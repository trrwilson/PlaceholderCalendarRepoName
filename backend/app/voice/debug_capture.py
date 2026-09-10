"""Write the kiosk's retained voice-activation audio to disk for debugging.

The kiosk keeps the last N turns' provider-input audio in the browser and (when
``voice_debug_capture_enabled``) POSTs each finished capture to
``POST /api/voice/debug/capture``. Here we write the headered WAV it sends
verbatim, plus a ``.json`` sidecar with the turn's metadata, into
``settings.voice_debug_capture_dir`` (default ``backend/voice-captures/``), and
prune to ``voice_debug_capture_keep`` pairs so the directory does not grow
without bound. Local-only; nothing here reaches a provider.
"""

from __future__ import annotations

import base64
import binascii
import json
from datetime import datetime
from pathlib import Path

from app.config import Settings
from app.models import VoiceDebugCapture

# A complete WAV starts ``RIFF....WAVE``; reject anything that is not one so a
# corrupt or truncated upload does not land as an unplayable file.
_RIFF = b"RIFF"
_WAVE = b"WAVE"
# 60 s of 24 kHz mono PCM16 is ~2.9 MB; this is generous headroom, not a limit
# anyone should hit (the kiosk caps a capture at 60 s).
_MAX_WAV_BYTES = 32 * 1024 * 1024


class VoiceCaptureError(ValueError):
    """The uploaded payload is not a WAV we will write."""


def capture_dir(settings: Settings) -> Path:
    """Resolved directory captures are written to (created on first write)."""
    return Path(settings.voice_debug_capture_dir)


def store_capture(settings: Settings, capture: VoiceDebugCapture) -> Path:
    """Write ``capture`` as ``<stamp>-<ptt|wake>-<provider>.wav`` (+ ``.json``).

    Returns the WAV path. Raises :class:`VoiceCaptureError` if the payload is not
    decodable base64 or not a RIFF/WAVE file.
    """
    try:
        wav = base64.b64decode(capture.wav_base64, validate=True)
    except (binascii.Error, ValueError) as exc:
        raise VoiceCaptureError("wav_base64 is not valid base64") from exc
    if len(wav) > _MAX_WAV_BYTES:
        raise VoiceCaptureError("capture is larger than the 32 MB ceiling")
    if wav[:4] != _RIFF or wav[8:12] != _WAVE:
        raise VoiceCaptureError("payload is not a RIFF/WAVE file")

    directory = capture_dir(settings)
    directory.mkdir(parents=True, exist_ok=True)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S-%f")[:-3]
    kind = "wake" if capture.via_wake else "ptt"
    provider = _slug(capture.provider) or "unknown"
    stem = _free_stem(directory, f"{stamp}-{kind}-{provider}")

    wav_path = directory / f"{stem}.wav"
    wav_path.write_bytes(wav)

    meta = capture.model_dump(mode="json", exclude={"wav_base64"})
    meta["wav_file"] = wav_path.name
    meta["bytes"] = len(wav)
    (directory / f"{stem}.json").write_text(json.dumps(meta, indent=2), encoding="utf-8")

    _prune(directory, settings.voice_debug_capture_keep)
    return wav_path


def _slug(value: str | None) -> str:
    return "".join(c if c.isalnum() or c in "-_" else "_" for c in (value or "")).strip("_")


def _free_stem(directory: Path, stem: str) -> str:
    """``stem``, or ``stem-2`` / ``stem-3`` / … if a ``.wav`` already has it.

    The stamp is only millisecond-resolution, so a burst of captures inside one
    millisecond (or on a coarse system clock) would otherwise collide and
    overwrite each other — leaving fewer files than turns.
    """
    if not (directory / f"{stem}.wav").exists():
        return stem
    for n in range(2, 1000):
        if not (directory / f"{stem}-{n}.wav").exists():
            return f"{stem}-{n}"
    return f"{stem}-{datetime.now().microsecond}"


def _prune(directory: Path, keep: int) -> None:
    if keep <= 0:
        return
    wavs = sorted(directory.glob("*.wav"), key=lambda p: p.stat().st_mtime)
    for stale in wavs[:-keep]:
        stale.unlink(missing_ok=True)
        stale.with_suffix(".json").unlink(missing_ok=True)
