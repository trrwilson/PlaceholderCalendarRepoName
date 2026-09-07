"""Concrete :class:`SpeechRecognizer` engines and the factory that picks one.

Engines are imported lazily (like the calendar and cloud-voice providers) so the
default install and CI never need faster-whisper or sherpa-onnx wheels. The
``null`` / scripted engine has no dependencies and backs both the tests and the
text-bypass path.

Model provenance (weights vs. runtime licence) is tracked per
``AGENTS.md`` -> "ML / audio / vision model artifacts"; see
``docs/local-stt-evaluation.md``.
"""

from __future__ import annotations

from app.config import Settings
from app.voice.local.recognizer import SpeechRecognizer

__all__ = ["available_engines", "create_recognizer"]

_ORDER = ("faster_whisper", "sherpa_onnx")


def available_engines() -> list[str]:
    """Engine ids whose Python package imports on this host (best-effort)."""
    found = ["null"]
    import importlib.util

    if importlib.util.find_spec("faster_whisper"):
        found.append("faster_whisper")
    if importlib.util.find_spec("sherpa_onnx"):
        found.append("sherpa_onnx")
    return found


def create_recognizer(settings: Settings) -> SpeechRecognizer:
    """Build the configured recogniser.

    ``local_stt_engine == "auto"`` picks the first installed engine in ``_ORDER``,
    falling back to the dependency-free scripted recogniser (which cannot hear a
    microphone — the pipeline then only serves the text-bypass path).
    """
    choice = settings.local_stt_engine
    if choice == "auto":
        installed = available_engines()
        choice = next((e for e in _ORDER if e in installed), "null")

    if choice == "faster_whisper":
        from app.voice.local.engines.faster_whisper_engine import FasterWhisperRecognizer

        return FasterWhisperRecognizer(
            model=settings.local_stt_model or "small.en",
            device=settings.local_stt_device,
            compute_type=settings.local_stt_compute_type,
            download_root=settings.local_stt_models_dir or None,
            beam_size=settings.local_stt_beam_size,
        )
    if choice == "sherpa_onnx":
        from app.voice.local.engines.sherpa_onnx_engine import SherpaOnnxRecognizer

        return SherpaOnnxRecognizer(
            model_dir=settings.local_stt_model,
            device=settings.local_stt_device,
        )

    from app.voice.local.engines.scripted import ScriptedRecognizer

    return ScriptedRecognizer()
