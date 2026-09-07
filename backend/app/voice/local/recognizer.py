"""The replaceable local speech-recognition seam.

Mission Control never imports faster-whisper / sherpa-onnx directly — it depends
only on :class:`SpeechRecognizer`. An implementation turns a stream of PCM16
frames into partial and final transcripts plus timing, and reports an endpoint
when it detects end-of-speech (or the caller forces one).

The concept — start/listen, partial events, final transcript, endpoint, error,
cancel, timing — is adapted to this codebase's grain: recognizers are plain
objects with synchronous ``accept_audio`` / ``finalize`` methods (heavy engines
run them in a threadpool from ``session.py``), and events are a small dataclass
union rather than an observer interface.
"""

from __future__ import annotations

import time
from dataclasses import dataclass, field
from typing import Literal, Protocol, runtime_checkable

SAMPLE_RATE = 16_000  # every engine here wants 16 kHz mono PCM16


@dataclass
class RecognitionEvent:
    """One thing the recogniser noticed."""

    type: Literal["partial", "final", "endpoint", "error"]
    text: str = ""
    #: engine confidence for a ``final`` (0..1) where the engine exposes one
    confidence: float | None = None
    message: str = ""
    #: ms since the recogniser was constructed / reset, for diagnostics
    at_ms: float = 0.0


@dataclass
class RecognizerTimings:
    created_at: float = field(default_factory=time.perf_counter)
    model_load_ms: float = 0.0
    audio_seconds: float = 0.0
    first_partial_ms: float | None = None
    final_ms: float | None = None
    decode_ms: float = 0.0

    def as_dict(self) -> dict[str, float | None]:
        return {
            "model_load_ms": round(self.model_load_ms, 1),
            "audio_seconds": round(self.audio_seconds, 2),
            "first_partial_ms": None
            if self.first_partial_ms is None
            else round(self.first_partial_ms, 1),
            "final_ms": None if self.final_ms is None else round(self.final_ms, 1),
            "decode_ms": round(self.decode_ms, 1),
        }


@runtime_checkable
class SpeechRecognizer(Protocol):
    """Streaming-or-buffered speech recognition for one utterance at a time."""

    #: short id for diagnostics / the grant ``model`` field, e.g. "faster-whisper/small.en"
    name: str
    #: True for engines that emit useful ``partial`` events mid-utterance
    streaming: bool

    def reset(self) -> None:
        """Drop any buffered audio / partial state; ready for a new utterance."""
        ...

    def accept_audio(
        self, pcm16: bytes, *, sample_rate: int = SAMPLE_RATE
    ) -> list[RecognitionEvent]:
        """Feed one chunk of little-endian mono PCM16. May return ``partial`` events."""
        ...

    def finalize(self) -> list[RecognitionEvent]:
        """End of speech: return the ``final`` transcript (and a trailing ``endpoint``)."""
        ...

    def close(self) -> None:
        """Release the model / any native resources."""
        ...

    @property
    def timings(self) -> RecognizerTimings: ...
