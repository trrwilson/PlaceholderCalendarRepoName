"""Pure mapping tests for app/eufy/events.py — no network, no bridge, no SDK."""

from datetime import datetime

from app.eufy.events import parse_clip_discovered, parse_ready, parse_status


def test_parse_status_maps_known_states():
    assert parse_status({"type": "status", "state": "connected"}) == "connected"
    assert parse_status({"type": "status", "state": "reconnecting"}) == "connecting"
    assert parse_status({"type": "status", "state": "needs_signin"}) == "needs_signin"


def test_parse_status_unknown_state_is_none():
    assert parse_status({"type": "status", "state": "made-up-state"}) is None
    assert parse_status({"type": "status"}) is None


def test_parse_clip_discovered_happy_path():
    clip = parse_clip_discovered(
        {
            "type": "clip_discovered",
            "clip_id": "T8160P11231428D3:12345",
            "camera_id": "T8160P11231428D3",
            "camera_name": "Front Door",
            "occurred_at": "2026-09-07T18:30:00Z",
            "frame_num": 300,
        },
        assumed_fps=15.0,
    )
    assert clip is not None
    assert clip.clip_id == "T8160P11231428D3:12345"
    assert clip.camera_id == "T8160P11231428D3"
    assert clip.camera_name == "Front Door"
    assert isinstance(clip.occurred_at, datetime)
    assert clip.approx_duration_seconds == 20.0
    assert clip.has_thumbnail is True


def test_parse_clip_discovered_missing_required_field_is_none():
    assert (
        parse_clip_discovered(
            {"type": "clip_discovered", "camera_id": "X", "camera_name": "Y"},
            assumed_fps=15.0,
        )
        is None
    )


def test_parse_clip_discovered_bad_timestamp_is_none():
    assert (
        parse_clip_discovered(
            {
                "clip_id": "a:1",
                "camera_id": "a",
                "camera_name": "A",
                "occurred_at": "not-a-timestamp",
            },
            assumed_fps=15.0,
        )
        is None
    )


def test_parse_clip_discovered_no_frame_num_leaves_duration_none():
    clip = parse_clip_discovered(
        {
            "clip_id": "a:1",
            "camera_id": "a",
            "camera_name": "A",
            "occurred_at": "2026-09-07T18:30:00Z",
        },
        assumed_fps=15.0,
    )
    assert clip is not None
    assert clip.approx_duration_seconds is None


def test_parse_ready_roster():
    roster = parse_ready(
        {
            "type": "ready",
            "devices": [
                {"camera_id": "a", "camera_name": "Front Door"},
                {"camera_id": "b", "camera_name": "KittyCam"},
                {"not": "a valid entry"},
            ],
        }
    )
    assert roster == [
        {"camera_id": "a", "camera_name": "Front Door"},
        {"camera_id": "b", "camera_name": "KittyCam"},
    ]


def test_parse_ready_missing_devices_is_empty():
    assert parse_ready({"type": "ready"}) == []
