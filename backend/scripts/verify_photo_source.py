"""Live check of the photo stream's OneDrive source against the real account.

Not run in CI (AGENTS.md: live provider endpoints are validated by hand). Run on
the backend host with the same ``.env`` the backend uses, after signing in with
``MISSION_CONTROL_PHOTOS_ENABLED=true`` so the device-code flow asks for
``Files.Read`` (``python -m app.auth login``):

    cd backend
    ./.venv/Scripts/python -m scripts.verify_photo_source
    ./.venv/Scripts/python -m scripts.verify_photo_source --albums --sizes c2560x1440 c3840x2160

It reports the [verify] items in docs/photo-stream-plan.md: whether the default
first-party client got Files.Read, folder delta paging + deltaLink, thumbnail
rendition sizes/formats (including HEIC), and — with ``--albums`` — whether
OneDrive albums are listable on this account. Nothing is written to the cache.
"""

from __future__ import annotations

import argparse
import sys
import time

import httpx

from app.config import get_settings
from app.photos import _token_provider
from app.photos.onedrive import GRAPH, OneDriveFolderSource, PhotoSourceError


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("--folder", help="override MISSION_CONTROL_PHOTOS_FOLDER_PATH")
    parser.add_argument("--sizes", nargs="*", default=["c2560x1440"])
    parser.add_argument("--albums", action="store_true", help="also list OneDrive albums")
    parser.add_argument(
        "--watch", type=int, default=0, help="seconds to wait, then run one incremental delta"
    )
    args = parser.parse_args()
    settings = get_settings()
    token = _token_provider()

    try:
        token()
    except PhotoSourceError as exc:
        print(f"FAIL token: {exc}")
        return 1
    print("ok   Files.Read token acquired silently")

    client = httpx.Client(timeout=60.0, follow_redirects=True)
    folder_path = args.folder or settings.photos_folder_path
    source = OneDriveFolderSource(
        token_provider=token, folder_path=folder_path, rendition=args.sizes[0], client=client
    )
    try:
        folder_id = source.resolve_folder()
        print(f"ok   folder {folder_path!r} -> {folder_id}")
        started = time.monotonic()
        result = source.changes(folder_id, None)
        print(
            f"ok   full delta: {len(result.upserts)} images in {time.monotonic() - started:.1f}s; "
            f"deltaLink {'present' if result.delta_link else 'MISSING'}"
        )
    except PhotoSourceError as exc:
        print(f"FAIL {exc}")
        return 1

    for item in result.upserts[:3]:
        for size in args.sizes:
            url = f"{GRAPH}/me/drive/items/{item.id}/thumbnails/0/{size}/content"
            response = client.get(url, headers={"Authorization": f"Bearer {token()}"})
            kind = response.headers.get("content-type")
            print(
                f"{'ok  ' if response.status_code == 200 else 'FAIL'} {item.name} {size}: "
                f"{response.status_code} {kind} {len(response.content)} bytes "
                f"(original {item.width}x{item.height})"
            )

    if args.watch:
        print(f"...add/remove a photo in the folder now; waiting {args.watch}s")
        time.sleep(args.watch)
        delta = source.changes(folder_id, result.delta_link)
        print(f"ok   incremental: +{len(delta.upserts)} / -{len(delta.deleted)} full={delta.full}")

    if args.albums:
        response = client.get(
            f"{GRAPH}/me/drive/bundles",
            params={"$filter": "bundle/album ne null"},
            headers={"Authorization": f"Bearer {token()}"},
        )
        if response.status_code == 200:
            names = [b.get("name") for b in response.json().get("value", [])]
            print(f"ok   {len(names)} albums: {names[:10]}")
        else:
            print(f"FAIL albums: {response.status_code} {response.text[:200]}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
