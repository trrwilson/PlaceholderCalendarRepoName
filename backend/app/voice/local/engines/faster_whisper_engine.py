"""``SpeechRecognizer`` backed by faster-whisper (CTranslate2).

faster-whisper is buffered, not truly streaming, but for *short bounded commands*
(1–3 s) a single greedy decode on end-of-speech is fast and accurate, and that is
what this engine optimises for (``AGENTS.md``: interactive latency over
throughput). Optional mid-utterance partials re-decode the buffer-so-far at a
throttled interval when ``partial_interval_s > 0``.

Install: ``pip install faster-whisper`` (pulls ``ctranslate2``). Models download
from Hugging Face on first use to ``download_root`` (or the HF cache). CPU uses
``int8``; an NVIDIA GPU with CUDA present uses ``float16`` automatically under
``device="auto"``. Weights are MIT (OpenAI Whisper) repackaged by Systran — see
``docs/local-stt-evaluation.md`` / ``docs/credits.md``.
"""

from __future__ import annotations

import time

import numpy as np

from app.voice.local.recognizer import RecognitionEvent, RecognizerTimings, SpeechRecognizer

_INITIAL_PROMPT = (
    "Mission Control household calendar. Commands about the schedule, the week, "
    "the month, events, appointments, people, and the kitchen timer."
)


class FasterWhisperRecognizer(SpeechRecognizer):
    streaming = True

    def __init__(
        self,
        *,
        model: str = "small.en",
        device: str = "auto",
        compute_type: str = "auto",
        download_root: str | None = None,
        beam_size: int = 1,
        partial_interval_s: float = 0.0,
    ) -> None:
        self._model_id = model
        self._device = device
        self._compute_type = compute_type
        self._download_root = download_root
        self._beam_size = beam_size
        self._partial_interval_s = partial_interval_s
        self.name = f"faster-whisper/{model}"

        self._model = None
        self._buf = bytearray()
        self._sample_rate = 16_000
        self._last_partial_at = 0.0
        self._last_partial_text = ""
        self._timings = RecognizerTimings()
        self._load()

    def _load(self) -> None:
        from faster_whisper import WhisperModel

        started = time.perf_counter()
        device = self._device
        compute = self._compute_type
        if device == "auto":
            # Default to CPU. A discrete GPU is an *opt-in* accelerator
            # (MISSION_CONTROL_LOCAL_STT_DEVICE=cuda) — "auto" must not fail on a
            # box that has an NVIDIA card but no CUDA 12 / cuDNN runtime on PATH
            # (AGENTS.md -> "Hardware assumptions"; the GTX 1080 target).
            device = "cpu"
            compute = "int8" if compute == "auto" else compute
        elif compute == "auto":
            compute = "float16" if device == "cuda" else "int8"
        try:
            self._model = WhisperModel(
                self._model_id,
                device=device,
                compute_type=compute,
                download_root=self._download_root,
            )
        except Exception:  # noqa: BLE001 - CUDA libs missing etc.; fall back to CPU
            if device == "cpu":
                raise
            device, compute = "cpu", "int8"
            self._model = WhisperModel(
                self._model_id,
                device=device,
                compute_type=compute,
                download_root=self._download_root,
            )
        self._resolved_device = device
        self._resolved_compute = compute
        self.name = f"faster-whisper/{self._model_id}/{device}-{compute}"
        self._timings.model_load_ms = (time.perf_counter() - started) * 1000

    def reset(self) -> None:
        self._buf.clear()
        self._last_partial_at = 0.0
        self._last_partial_text = ""
        self._timings = RecognizerTimings(model_load_ms=self._timings.model_load_ms)

    def accept_audio(self, pcm16: bytes, *, sample_rate: int = 16_000) -> list[RecognitionEvent]:
        self._sample_rate = sample_rate
        self._buf.extend(pcm16)
        self._timings.audio_seconds = len(self._buf) / 2 / sample_rate
        if self._partial_interval_s <= 0:
            return []
        now = time.perf_counter()
        if now - self._last_partial_at < self._partial_interval_s:
            return []
        if self._timings.audio_seconds < 0.6:
            return []
        self._last_partial_at = now
        text = self._decode(partial=True)
        if text and text != self._last_partial_text:
            self._last_partial_text = text
            at = (now - self._timings.created_at) * 1000
            if self._timings.first_partial_ms is None:
                self._timings.first_partial_ms = at
            return [RecognitionEvent("partial", text=text, at_ms=at)]
        return []

    def finalize(self) -> list[RecognitionEvent]:
        start = time.perf_counter()
        text, confidence = self._decode(partial=False, with_confidence=True)
        self._timings.decode_ms = (time.perf_counter() - start) * 1000
        at = (time.perf_counter() - self._timings.created_at) * 1000
        self._timings.final_ms = at
        return [
            RecognitionEvent("final", text=text, confidence=confidence, at_ms=at),
            RecognitionEvent("endpoint", at_ms=at),
        ]

    def _samples(self) -> np.ndarray:
        pcm = np.frombuffer(bytes(self._buf), dtype="<i2")
        return (pcm.astype(np.float32) / 32768.0).copy()

    def _decode(self, *, partial: bool, with_confidence: bool = False):
        if self._model is None or len(self._buf) < 2:
            return ("", 0.0) if with_confidence else ""
        segments, _info = self._model.transcribe(
            self._samples(),
            language="en",
            task="transcribe",
            beam_size=1 if partial else self._beam_size,
            vad_filter=not partial,
            condition_on_previous_text=False,
            initial_prompt=_INITIAL_PROMPT,
            temperature=0.0,
        )
        parts: list[str] = []
        logprobs: list[float] = []
        for seg in segments:
            parts.append(seg.text)
            if seg.avg_logprob is not None:
                logprobs.append(seg.avg_logprob)
        text = " ".join(p.strip() for p in parts).strip()
        if not with_confidence:
            return text
        confidence = float(np.exp(np.mean(logprobs))) if logprobs else (0.5 if text else 0.0)
        return text, round(min(1.0, confidence), 3)

    def close(self) -> None:
        self._model = None

    @property
    def timings(self) -> RecognizerTimings:
        return self._timings
