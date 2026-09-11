"""Pure mapping: bridge JSON dicts -> domain models. No I/O.

Mirrors the calendar providers' event-mapping helpers (`app/calendar/graph.py`):
one small module, unit-tested against captured/hand-crafted fixtures, that is
the only place `eufy-security-client` vocabulary is translated into the
provider-neutral shapes in `app/models.py`. `EufyEventService` (`service.py`)
calls these; it never inspects a bridge dict itself.

The bridge emits ISO 8601 UTC timestamps (``...Z``); every function here
converts to naive local time at this boundary, the same rule the calendar
providers follow.
"""

from __future__ import annotations

from datetime import UTC, datetime, tzinfo
from typing import Any

from app.models import EufySourceStatus, StoredClip

_LOCAL_TZ: tzinfo = datetime.now().astimezone().tzinfo or UTC

# The bridge's own connection-state vocabulary maps 1:1 onto EufySourceStatus
# today; kept as an explicit table (not a bare cast) so a future bridge state
# this doesn't recognise fails safe to "error" instead of raising.
_STATUS_MAP: dict[str, EufySourceStatus] = {
    "connecting": "connecting",
    "connected": "connected",
    "reconnecting": "connecting",
    "needs_signin": "needs_signin",
    "error": "error",
}


def _parse_local(value: str) -> datetime:
    return datetime.fromisoformat(value).astimezone(_LOCAL_TZ).replace(tzinfo=None)


def parse_status(payload: dict[str, Any]) -> EufySourceStatus | None:
    """``{"type": "status", "state": "..."}`` -> an ``EufySourceStatus``, or
    ``None`` if the state is unrecognised (the caller should ignore it rather
    than guess)."""
    state = payload.get("state")
    if not isinstance(state, str):
        return None
    return _STATUS_MAP.get(state)


def parse_clip_discovered(payload: dict[str, Any], *, assumed_fps: float) -> StoredClip | None:
    """``{"type": "clip_discovered", "clip_id", "camera_id", "camera_name",
    "occurred_at", "frame_num"?}`` -> a ``StoredClip``.

    ``frame_num`` (the station's own frame count for the record) is turned into
    an approximate duration at ``assumed_fps`` — the true frame rate is only
    known once a download actually starts, so this is a cosmetic label, not a
    precise value. Returns ``None`` for a malformed payload (missing a required
    field) rather than raising — one bad line from the bridge must not take
    down the service loop.
    """
    clip_id = payload.get("clip_id")
    camera_id = payload.get("camera_id")
    camera_name = payload.get("camera_name")
    occurred_at = payload.get("occurred_at")
    if not (
        isinstance(clip_id, str)
        and clip_id
        and isinstance(camera_id, str)
        and camera_id
        and isinstance(camera_name, str)
        and camera_name
        and isinstance(occurred_at, str)
    ):
        return None
    try:
        when = _parse_local(occurred_at)
    except ValueError:
        return None
    frame_num = payload.get("frame_num")
    duration = (
        frame_num / assumed_fps
        if isinstance(frame_num, int | float) and frame_num > 0 and assumed_fps > 0
        else None
    )
    return StoredClip(
        clip_id=clip_id,
        camera_id=camera_id,
        camera_name=camera_name,
        occurred_at=when,
        approx_duration_seconds=duration,
        has_thumbnail=bool(payload.get("has_thumbnail", True)),
    )


def parse_ready(payload: dict[str, Any]) -> list[dict[str, str]]:
    """``{"type": "ready", "devices": [{"camera_id", "camera_name"}, ...]}`` ->
    the device roster, skipping any malformed entry. Used only to know whether
    any camera is online (``cameras_online``) — the gallery itself is driven by
    ``clip_discovered`` messages, not this roster."""
    devices = payload.get("devices")
    if not isinstance(devices, list):
        return []
    roster: list[dict[str, str]] = []
    for entry in devices:
        if not isinstance(entry, dict):
            continue
        camera_id = entry.get("camera_id")
        camera_name = entry.get("camera_name")
        if isinstance(camera_id, str) and camera_id and isinstance(camera_name, str):
            roster.append({"camera_id": camera_id, "camera_name": camera_name})
    return roster
