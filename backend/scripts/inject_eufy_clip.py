"""TEST MECHANISM — inject an external recording into the eufy clip gallery.

Not a product feature. Makes an arbitrary video show up in the camera gallery
as if the bridge had discovered it: thumbnail, tap-to-play, audio. Run on the
backend host (the backend copies ``video`` by local path into its durable
gallery cache) with ``MISSION_CONTROL_EUFY_ENABLED=true`` and
``MISSION_CONTROL_EUFY_TEST_INJECTION_ENABLED=true`` set for the backend.

    cd backend
    ./.venv/Scripts/python -m scripts.inject_eufy_clip clip.mov --camera "Front Door"
    ./.venv/Scripts/python -m scripts.inject_eufy_clip clip.mp4 --camera Garage \\
        --at 2026-09-29T07:42:00 --thumb-at 3.5

By default the video is re-encoded to H.264/AAC MP4 (+faststart) so the kiosk
browser can always play it; ``--no-transcode`` sends it as-is. Needs
``ffmpeg``/``ffprobe`` on PATH. The clip lands at the top of the gallery (the
same newest-discovered-first order real clips use), whatever ``--at`` says.
"""

from __future__ import annotations

import argparse
import base64
import subprocess
import sys
import tempfile
from datetime import datetime
from pathlib import Path

import httpx


def _probe_duration(video: Path) -> float | None:
    out = subprocess.run(
        ["ffprobe", "-v", "error", "-show_entries", "format=duration", "-of", "csv=p=0", video],
        capture_output=True,
        text=True,
    )
    try:
        return float(out.stdout.strip())
    except ValueError:
        return None


def _ffmpeg(*args: str | Path) -> None:
    subprocess.run(["ffmpeg", "-v", "error", "-y", *map(str, args)], check=True)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("video", type=Path)
    parser.add_argument("--camera", required=True, help="camera name shown in the gallery")
    parser.add_argument("--camera-id", default="injected-test-camera")
    parser.add_argument(
        "--at",
        type=datetime.fromisoformat,
        default=None,
        help="ISO timestamp (naive = local); default: now",
    )
    parser.add_argument("--thumb-at", type=float, default=1.0, help="thumbnail frame, seconds")
    parser.add_argument("--no-transcode", action="store_true")
    parser.add_argument("--backend", default="http://127.0.0.1:8000")
    args = parser.parse_args()

    source: Path = args.video.resolve()
    if not source.is_file():
        print(f"no such file: {source}", file=sys.stderr)
        return 1

    with tempfile.TemporaryDirectory(prefix="inject-clip-") as scratch:
        video = source
        if not args.no_transcode:
            video = Path(scratch) / "clip.mp4"
            _ffmpeg("-i", source, "-c:v", "libx264", "-pix_fmt", "yuv420p", "-c:a", "aac",
                    "-movflags", "+faststart", video)  # fmt: skip
        duration = _probe_duration(video)
        thumb_at = min(args.thumb_at, duration / 2) if duration else 0.0
        thumb = Path(scratch) / "thumb.jpg"
        _ffmpeg("-ss", f"{thumb_at:.3f}", "-i", video, "-frames:v", "1",
                "-vf", "scale=640:-2", "-q:v", "4", thumb)  # fmt: skip

        response = httpx.post(
            f"{args.backend}/api/camera/test/inject-clip",
            json={
                "video_path": str(video),
                "thumbnail_base64": base64.b64encode(thumb.read_bytes()).decode("ascii"),
                "camera_name": args.camera,
                "camera_id": args.camera_id,
                "occurred_at": (args.at or datetime.now()).isoformat(),
                "duration_seconds": duration,
            },
            timeout=60,
        )
    if response.status_code != 200:
        print(f"injection failed ({response.status_code}): {response.text}", file=sys.stderr)
        return 1
    print(f"injected {response.json()['clip_id']}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
