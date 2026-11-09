"""OneDrive folder photo source over Microsoft Graph (docs/photo-stream-plan.md §2.1).

Read-only: delegated ``Files.Read``, folder-scoped ``delta`` for incremental
sync, and server-rendered custom-size thumbnails (``c{W}x{H}``) for display —
which also converts HEIC to JPEG. Folder-scoped delta is supported on personal
OneDrive; OneDrive for Business only supports delta on the drive root, which
this source does not handle yet (see the plan's open gaps).

Synchronous ``httpx`` like ``outlook_personal``; the service runs it on a worker
thread so the event loop never blocks on Graph.
"""

from __future__ import annotations

from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import datetime
from urllib.parse import quote

import httpx

from app.models import PhotoItem

GRAPH = "https://graph.microsoft.com/v1.0"
_SELECT = "id,name,file,image,photo,deleted,folder,cTag,eTag,size,parentReference,root"


class PhotoSourceError(RuntimeError):
    """A recoverable source failure; the caller keeps serving the cache."""


class NeedsSignIn(PhotoSourceError):
    pass


class Throttled(PhotoSourceError):
    def __init__(self, retry_after: float) -> None:
        super().__init__(f"throttled for {retry_after:.0f}s")
        self.retry_after = retry_after


@dataclass
class DeltaResult:
    upserts: list[PhotoItem] = field(default_factory=list)
    deleted: set[str] = field(default_factory=set)
    delta_link: str = ""
    # True when this was a full enumeration (first run or a 410 resync): the
    # caller must evict anything cached that ``upserts`` didn't mention.
    full: bool = False


def _taken_at(value: object) -> datetime | None:
    if not isinstance(value, str) or not value:
        return None
    try:
        parsed = datetime.fromisoformat(value.replace("Z", "+00:00"))
    except ValueError:
        return None
    # Domain datetimes are naive local time (AGENTS.md); same rule as graph.py.
    return parsed.astimezone().replace(tzinfo=None) if parsed.tzinfo else parsed


def to_photo(raw: dict) -> PhotoItem | None:
    """A delta/children entry → PhotoItem, or None for anything that isn't a
    still image (folders, videos, documents)."""
    file = raw.get("file") or {}
    mime = str(file.get("mimeType") or "")
    if not mime.startswith("image/") and "image" not in raw:
        return None
    image = raw.get("image") or {}
    photo = raw.get("photo") or {}
    return PhotoItem(
        id=str(raw["id"]),
        name=str(raw.get("name") or ""),
        width=image.get("width"),
        height=image.get("height"),
        taken_at=_taken_at(photo.get("takenDateTime")),
        version=str(raw.get("cTag") or raw.get("eTag") or ""),
    )


def _retry_after(response: httpx.Response) -> float:
    try:
        return max(1.0, float(response.headers.get("Retry-After", "30")))
    except ValueError:
        return 30.0


class OneDriveFolderSource:
    def __init__(
        self,
        *,
        token_provider: Callable[[], str],
        folder_path: str,
        rendition: str,
        client: httpx.Client | None = None,
    ) -> None:
        self._token = token_provider
        self._folder_path = folder_path.strip("/")
        self._rendition = rendition
        self._client = client or httpx.Client(timeout=30.0, follow_redirects=True)

    def _get(self, url: str, *, params: dict[str, str] | None = None) -> httpx.Response:
        try:
            response = self._client.get(
                url, params=params, headers={"Authorization": f"Bearer {self._token()}"}
            )
        except httpx.HTTPError as exc:
            raise PhotoSourceError(f"network error: {type(exc).__name__}") from exc
        if response.status_code in (429, 503):
            raise Throttled(_retry_after(response))
        if response.status_code == 401:
            raise NeedsSignIn("Graph rejected the token")
        return response

    def resolve_folder(self) -> str:
        url = f"{GRAPH}/me/drive/root:/{quote(self._folder_path)}"
        response = self._get(url, params={"$select": "id,folder"})
        if response.status_code == 404:
            raise PhotoSourceError(f"folder not found: {self._folder_path}")
        if response.status_code == 403:
            raise NeedsSignIn("missing Files.Read consent")
        if response.status_code != 200:
            raise PhotoSourceError(f"folder lookup failed ({response.status_code})")
        body = response.json()
        if "folder" not in body:
            raise PhotoSourceError(f"not a folder: {self._folder_path}")
        return str(body["id"])

    def changes(self, folder_id: str, delta_link: str | None) -> DeltaResult:
        """Drain one delta round. With no ``delta_link`` (or after a 410) it
        enumerates the folder from scratch and marks the result ``full``."""
        full = not delta_link
        url = delta_link or f"{GRAPH}/me/drive/items/{folder_id}/delta"
        params: dict[str, str] | None = None if delta_link else {"$select": _SELECT}
        result = DeltaResult(full=full)
        while True:
            response = self._get(url, params=params)
            params = None  # nextLink / Location already carry the query
            if response.status_code == 410:
                # resyncRequired family: start over from the fresh link Graph
                # hands back (or the base URL), discarding this partial round.
                fresh = response.headers.get("Location")
                result = DeltaResult(full=True)
                if fresh:
                    url = fresh
                else:
                    url, params = f"{GRAPH}/me/drive/items/{folder_id}/delta", {"$select": _SELECT}
                continue
            if response.status_code == 403:
                raise NeedsSignIn("missing Files.Read consent")
            if response.status_code != 200:
                raise PhotoSourceError(f"delta failed ({response.status_code})")
            body = response.json()
            for raw in body.get("value", []):
                if raw.get("id") == folder_id or "root" in raw:
                    continue
                if "deleted" in raw:
                    result.deleted.add(str(raw["id"]))
                    continue
                item = to_photo(raw)
                if item is None:
                    continue
                result.deleted.discard(item.id)
                result.upserts.append(item)
            if "@odata.nextLink" in body:
                url = body["@odata.nextLink"]
                continue
            result.delta_link = str(body.get("@odata.deltaLink") or "")
            if not result.delta_link:
                raise PhotoSourceError("delta round ended without a deltaLink")
            return result

    def fetch(self, photo_id: str) -> bytes:
        """The display rendition as JPEG bytes."""
        url = f"{GRAPH}/me/drive/items/{photo_id}/thumbnails/0/{self._rendition}/content"
        response = self._get(url)
        if response.status_code == 200 and response.content:
            return response.content
        raise PhotoSourceError(f"thumbnail unavailable ({response.status_code})")
