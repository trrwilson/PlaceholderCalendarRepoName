"""``SpeechRecognizer`` backed by sherpa-onnx streaming transducer recognition.

This is the genuinely *streaming* option: a zipformer transducer emits stable
partials while the person is still talking and sherpa-onnx has built-in endpoint
detection. Best fit for the "feels like an appliance" latency target on CPU; a
GTX 1080 helps but is not required.

Install: ``pip install sherpa-onnx``. Provide a streaming model directory via
``MISSION_CONTROL_LOCAL_STT_MODEL`` (an absolute path or one under
``MISSION_CONTROL_LOCAL_STT_MODELS_DIR``) containing ``encoder-*.onnx``,
``decoder-*.onnx``, ``joiner-*.onnx`` and ``tokens.txt`` — e.g. the
``sherpa-onnx-streaming-zipformer-en-*`` releases. Model binaries are provisioned
per install, never committed (``AGENTS.md``). Weights/runtime licence: see
``docs/local-stt-evaluation.md`` / ``docs/credits.md``.

UNVALIDATED on this hardware — the API calls follow the sherpa-onnx docs; expect
to tune ``rule*`` endpoint constants and the model choice on the target host
(same posture as the wake-word ONNX).
"""

from __future__ import annotations

import time
from pathlib import Path

import numpy as np

from app.voice.local.recognizer import RecognitionEvent, RecognizerTimings, SpeechRecognizer


def _one(model_dir: Path, *stems: str) -> str:
    for stem in stems:
        hits = sorted(model_dir.glob(stem))
        if hits:
            return str(hits[0])
    raise FileNotFoundError(f"none of {stems} in {model_dir}")


class SherpaOnnxRecognizer(SpeechRecognizer):
    streaming = True

    def __init__(self, *, model_dir: str, device: str = "auto", num_threads: int = 2) -> None:
        if not model_dir:
            raise ValueError(
                "sherpa_onnx engine needs MISSION_CONTROL_LOCAL_STT_MODEL set to a "
                "streaming-zipformer model directory"
            )
        self._dir = Path(model_dir).expanduser()
        if not self._dir.is_dir():
            raise FileNotFoundError(f"sherpa-onnx model directory not found: {self._dir}")
        self._device = device
        self._num_threads = num_threads
        self.name = f"sherpa-onnx/{self._dir.name}"

        self._recognizer = None
        self._stream = None
        self._emitted = ""
        self._timings = RecognizerTimings()
        self._load()

    def _load(self) -> None:
        import sherpa_onnx

        started = time.perf_counter()
        provider = "cpu"
        if self._device in ("auto", "cuda"):
            try:
                import onnxruntime

                if "CUDAExecutionProvider" in onnxruntime.get_available_providers():
                    provider = "cuda"
            except Exception:  # noqa: BLE001
                provider = "cpu"
        self._recognizer = sherpa_onnx.OnlineRecognizer.from_transducer(
            tokens=_one(self._dir, "tokens.txt"),
            encoder=_one(self._dir, "encoder-*.onnx", "encoder-*.int8.onnx"),
            decoder=_one(self._dir, "decoder-*.onnx", "decoder-*.int8.onnx"),
            joiner=_one(self._dir, "joiner-*.onnx", "joiner-*.int8.onnx"),
            num_threads=self._num_threads,
            provider=provider,
            decoding_method="greedy_search",
            enable_endpoint_detection=True,
            rule1_min_trailing_silence=2.4,
            rule2_min_trailing_silence=0.8,
            rule3_min_utterance_length=20.0,
        )
        self._stream = self._recognizer.create_stream()
        self._resolved_provider = provider
        self.name = f"sherpa-onnx/{self._dir.name}/{provider}"
        self._timings.model_load_ms = (time.perf_counter() - started) * 1000

    def reset(self) -> None:
        if self._recognizer is not None:
            self._stream = self._recognizer.create_stream()
        self._emitted = ""
        self._timings = RecognizerTimings(model_load_ms=self._timings.model_load_ms)

    def accept_audio(self, pcm16: bytes, *, sample_rate: int = 16_000) -> list[RecognitionEvent]:
        if self._recognizer is None or self._stream is None:
            return []
        samples = np.frombuffer(pcm16, dtype="<i2").astype(np.float32) / 32768.0
        self._timings.audio_seconds += len(samples) / sample_rate
        self._stream.accept_waveform(sample_rate, samples)
        events: list[RecognitionEvent] = []
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
        text = self._recognizer.get_result(self._stream).strip()
        now = (time.perf_counter() - self._timings.created_at) * 1000
        if text and text != self._emitted:
            self._emitted = text
            if self._timings.first_partial_ms is None:
                self._timings.first_partial_ms = now
            events.append(RecognitionEvent("partial", text=text, at_ms=now))
        if self._recognizer.is_endpoint(self._stream):
            final = self._recognizer.get_result(self._stream).strip()
            self._recognizer.reset(self._stream)
            self._timings.final_ms = now
            events.append(RecognitionEvent("final", text=final, confidence=None, at_ms=now))
            events.append(RecognitionEvent("endpoint", at_ms=now))
            self._emitted = ""
        return events

    def finalize(self) -> list[RecognitionEvent]:
        if self._recognizer is None or self._stream is None:
            return [RecognitionEvent("final", text="", at_ms=0.0), RecognitionEvent("endpoint")]
        tail = np.zeros(int(0.4 * 16_000), dtype=np.float32)
        self._stream.accept_waveform(16_000, tail)
        self._stream.input_finished()
        while self._recognizer.is_ready(self._stream):
            self._recognizer.decode_stream(self._stream)
        text = self._recognizer.get_result(self._stream).strip()
        now = (time.perf_counter() - self._timings.created_at) * 1000
        self._timings.final_ms = now
        return [
            RecognitionEvent("final", text=text, confidence=None, at_ms=now),
            RecognitionEvent("endpoint", at_ms=now),
        ]

    def close(self) -> None:
        self._recognizer = None
        self._stream = None

    @property
    def timings(self) -> RecognizerTimings:
        return self._timings
