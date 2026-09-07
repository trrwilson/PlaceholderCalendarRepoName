"""A dependency-free recogniser for tests and the text-bypass path.

It cannot transcribe audio. It either replays a caller-supplied transcript
(``ScriptedRecognizer(["show me tomorrow"])`` — one utterance per ``finalize``)
or, given nothing, returns an empty final so the pipeline degrades cleanly on a
host with no STT engine installed. ``session.py`` uses it directly when a client
sends a ``{"type": "text", ...}`` frame.
"""

from __future__ import annotations

import time

from app.voice.local.recognizer import RecognitionEvent, RecognizerTimings, SpeechRecognizer


class ScriptedRecognizer(SpeechRecognizer):
    name = "scripted"
    streaming = False

    def __init__(self, script: list[str] | None = None, *, confidence: float = 1.0) -> None:
        self._script = list(script or [])
        self._confidence = confidence
        self._pending = ""
        self._bytes = 0
        self._timings = RecognizerTimings()

    # allow the pipeline to inject a transcript for the text-bypass frame
    def inject(self, text: str, *, confidence: float | None = None) -> None:
        self._pending = text
        if confidence is not None:
            self._confidence = confidence

    def reset(self) -> None:
        self._pending = ""
        self._bytes = 0
        self._timings = RecognizerTimings()

    def accept_audio(self, pcm16: bytes, *, sample_rate: int = 16_000) -> list[RecognitionEvent]:
        self._bytes += len(pcm16)
        self._timings.audio_seconds = self._bytes / 2 / sample_rate
        return []

    def finalize(self) -> list[RecognitionEvent]:
        text = self._pending or (self._script.pop(0) if self._script else "")
        self._pending = ""
        now = (time.perf_counter() - self._timings.created_at) * 1000
        self._timings.final_ms = now
        return [
            RecognitionEvent("final", text=text, confidence=self._confidence, at_ms=now),
            RecognitionEvent("endpoint", at_ms=now),
        ]

    def close(self) -> None:  # nothing to release
        pass

    @property
    def timings(self) -> RecognizerTimings:
        return self._timings
