"""EufyClipCache — the durable last-few-clips cache (app/eufy/cache.py).
Pure filesystem behaviour, no bridge/service involved."""

from __future__ import annotations

from datetime import datetime

from app.eufy.cache import EufyClipCache
from app.models import StoredClip


def make_clip(clip_id: str, *, when: datetime | None = None) -> StoredClip:
    return StoredClip(
        clip_id=clip_id,
        camera_id="a",
        camera_name="Front Door",
        occurred_at=when or datetime(2026, 9, 15, 9, 0, 0),
    )


def test_load_on_empty_directory_starts_empty(tmp_path):
    cache = EufyClipCache(tmp_path / "cache", capacity=5)
    cache.load()
    assert cache.clips == []
    assert (tmp_path / "cache").is_dir()


def test_remember_persists_and_reloads(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=5)
    cache.load()
    cache.remember(make_clip("a:1"))
    cache.remember(make_clip("a:2"))

    reloaded = EufyClipCache(directory, capacity=5)
    reloaded.load()
    assert [c.clip_id for c in reloaded.clips] == ["a:2", "a:1"]


def test_remember_is_newest_first(tmp_path):
    cache = EufyClipCache(tmp_path / "cache", capacity=5)
    cache.load()
    for i in range(3):
        cache.remember(make_clip(f"a:{i}"))
    assert [c.clip_id for c in cache.clips] == ["a:2", "a:1", "a:0"]


def test_remember_evicts_past_capacity_and_deletes_media(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=2)
    cache.load()
    cache.remember(make_clip("a:0"))
    cache.save_thumbnail("a:0", b"thumb-0")
    cache.remember(make_clip("a:1"))
    cache.remember(make_clip("a:2"))  # evicts a:0

    assert [c.clip_id for c in cache.clips] == ["a:2", "a:1"]
    assert cache.thumbnail("a:0") is None
    assert not (directory / "a_0.thumb.jpg").exists()


def test_remember_duplicate_moves_to_front_without_duplicating(tmp_path):
    cache = EufyClipCache(tmp_path / "cache", capacity=5)
    cache.load()
    cache.remember(make_clip("a:0"))
    cache.remember(make_clip("a:1"))
    cache.remember(make_clip("a:0"))
    assert [c.clip_id for c in cache.clips] == ["a:0", "a:1"]


def test_save_thumbnail_round_trips(tmp_path):
    cache = EufyClipCache(tmp_path / "cache", capacity=5)
    cache.load()
    cache.remember(make_clip("a:1"))
    cache.save_thumbnail("a:1", b"jpeg-bytes")
    assert cache.thumbnail("a:1") == b"jpeg-bytes"


def test_save_thumbnail_for_evicted_clip_is_a_noop(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=1)
    cache.load()
    cache.remember(make_clip("a:0"))
    cache.remember(make_clip("a:1"))  # evicts a:0
    cache.save_thumbnail("a:0", b"late-arriving-thumbnail")
    assert cache.thumbnail("a:0") is None
    assert not (directory / "a_0.thumb.jpg").exists()


def test_save_video_copies_file_and_round_trips(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=5)
    cache.load()
    cache.remember(make_clip("a:1"))

    source = tmp_path / "downloaded.mp4"
    source.write_bytes(b"not-really-an-mp4")
    result = cache.save_video("a:1", source)

    assert result == cache.video_path("a:1")
    assert result.read_bytes() == b"not-really-an-mp4"


def test_save_video_for_unknown_clip_is_a_noop(tmp_path):
    cache = EufyClipCache(tmp_path / "cache", capacity=5)
    cache.load()
    source = tmp_path / "downloaded.mp4"
    source.write_bytes(b"data")
    assert cache.save_video("does-not-exist", source) is None


def test_load_sweeps_orphan_media_not_named_by_manifest(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=5)
    cache.load()
    cache.remember(make_clip("a:1"))
    cache.save_thumbnail("a:1", b"real-thumb")

    # Simulate a crash between writing a stray media file and persisting the
    # manifest: an orphan thumbnail for a clip the manifest never recorded.
    (directory / "orphan_9.thumb.jpg").write_bytes(b"leftover")

    reloaded = EufyClipCache(directory, capacity=5)
    reloaded.load()
    assert reloaded.thumbnail("a:1") == b"real-thumb"
    assert not (directory / "orphan_9.thumb.jpg").exists()


def test_load_with_corrupt_manifest_starts_fresh(tmp_path):
    directory = tmp_path / "cache"
    directory.mkdir()
    (directory / "manifest.json").write_text("{not json", encoding="utf-8")
    cache = EufyClipCache(directory, capacity=5)
    cache.load()
    assert cache.clips == []


def test_clip_id_with_colon_is_filesystem_safe(tmp_path):
    directory = tmp_path / "cache"
    cache = EufyClipCache(directory, capacity=5)
    cache.load()
    clip_id = "T8160P11231428D3:2026091500000"
    cache.remember(make_clip(clip_id))
    cache.save_thumbnail(clip_id, b"thumb")
    assert cache.thumbnail(clip_id) == b"thumb"
    for entry in directory.iterdir():
        assert ":" not in entry.name
