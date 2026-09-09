"""Compare the wake-word detectors on the same real audio.

    python -m scripts.benchmark_wake \
        --positives voice-captures --negatives voice-samples

Runs each back end over a shared corpus and reports, per detector:

* **recall** — fraction of positive clips (a spoken "Mission Control …") detected
* **false accepts** — fraction of negative clips (a bare command, no wake phrase)
  that fired anyway
* **latency** — seconds from clip start to the detection
* openWakeWord score separation (peak score on positives vs negatives)

The ``invoke_gate`` column is the *selected detector's* re-check (openWakeWord
here) run over audio as the on-device gate would hand it up: each clip is trimmed
to ``[speech_onset - gate_preroll_ms, end]`` and the model is reset at that
OFF→OPEN edge, approximating the preroll burst + live handoff. The gate is
additive — it sits in front of whichever provider is selected — so this measures
whether that provider still fires when it only sees the gated window. It is an
approximation: no device, no ``mock_invoke_gate`` process.

This is a *small-corpus* check (see `docs/wake-word-provider-bakeoff.md` →
"Measured comparison" for the caveats): it needs no network and no GPU, and the
audio is real kiosk / recorded speech rather than synthetic. It does **not**
produce a false-accepts-per-hour figure — that needs a long ambient-noise corpus
(the openWakeWord training env has one; this does not).

Benchmark-only deps, installed on demand like `benchmark_local_stt.py`:
`pip install openwakeword` and the `azure-wake` extra.
"""

from __future__ import annotations

import argparse
import statistics
import sys
import wave
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
WORKSPACE_ROOT = REPO_ROOT.parent
WAKE_MODELS = WORKSPACE_ROOT / "frontend" / "public" / "models" / "wake"

OWW_STEP = 1280  # 80 ms at 16 kHz — the detector step used by frontend/src/voice/wake


def read_wav_16k_mono(path: Path) -> np.ndarray:
    """Whole file as int16 mono at 16 kHz (linear-resampled if needed)."""
    with wave.open(str(path), "rb") as wf:
        rate, channels, nframes = wf.getframerate(), wf.getnchannels(), wf.getnframes()
        raw = wf.readframes(nframes)
    audio = np.frombuffer(raw, dtype=np.int16).astype(np.float32)
    if channels > 1:
        audio = audio.reshape(-1, channels).mean(axis=1)
    if rate != 16_000:
        target_len = int(round(len(audio) * 16_000 / rate))
        audio = np.interp(
            np.linspace(0.0, len(audio) - 1, target_len),
            np.arange(len(audio)),
            audio,
        )
    return np.clip(audio, -32768, 32767).astype(np.int16)


def load_clips(directory: Path) -> list[tuple[str, np.ndarray]]:
    clips = []
    for path in sorted(directory.glob("*.wav")):
        clips.append((path.name, read_wav_16k_mono(path)))
    if not clips:
        sys.exit(f"no .wav files in {directory}")
    return clips


# -- openWakeWord ------------------------------------------------------------


def eval_openwakeword(clips: list[tuple[str, np.ndarray]], threshold: float) -> list[dict]:
    from openwakeword.model import Model

    model = Model(
        wakeword_models=[str(WAKE_MODELS / "mission_control.onnx")],
        inference_framework="onnx",
        melspec_model_path=str(WAKE_MODELS / "melspectrogram.onnx"),
        embedding_model_path=str(WAKE_MODELS / "embedding_model.onnx"),
    )
    out = []
    for name, audio in clips:
        model.reset()
        peak = 0.0
        fired_at: float | None = None
        for start in range(0, max(0, len(audio) - OWW_STEP) + 1, OWW_STEP):
            frame = audio[start : start + OWW_STEP]
            if len(frame) < OWW_STEP:
                break
            score = next(iter(model.predict(frame).values()))
            peak = max(peak, score)
            if fired_at is None and score >= threshold:
                fired_at = (start + OWW_STEP) / 16_000
        out.append({"clip": name, "peak": round(float(peak), 4), "fired_at": fired_at})
    return out


# -- invoke_gate (selected detector's re-check over the gated window) ------


def _speech_onset(audio: np.ndarray, floor_dbfs: float = -45.0) -> int:
    """First sample index whose ~20 ms frame RMS crosses ``floor_dbfs``."""
    win = 320  # 20 ms at 16 kHz
    a = audio.astype(np.float32)
    for start in range(0, max(0, len(a) - win) + 1, win):
        frame = a[start : start + win]
        rms = float(np.sqrt(np.mean(frame * frame))) if len(frame) else 0.0
        if rms > 1.0 and 20.0 * np.log10(rms / 32768.0) > floor_dbfs:
            return start
    return 0


def eval_invoke_gate(
    clips: list[tuple[str, np.ndarray]], threshold: float, gate_preroll_ms: int
) -> list[dict]:
    preroll = int(gate_preroll_ms * 16)  # samples at 16 kHz
    trimmed = [(name, audio[max(0, _speech_onset(audio) - preroll) :]) for name, audio in clips]
    return eval_openwakeword(trimmed, threshold)


# -- Azure custom keyword ---------------------------------------------------


def eval_azure(clips: list[tuple[str, np.ndarray]]) -> list[dict]:
    import threading

    import azure.cognitiveservices.speech as speechsdk

    table = WAKE_MODELS / "azure_mission_control_basic_med.table"
    model = speechsdk.KeywordRecognitionModel(str(table))
    out = []
    for name, audio in clips:
        fmt = speechsdk.audio.AudioStreamFormat(
            samples_per_second=16_000, bits_per_sample=16, channels=1
        )
        push = speechsdk.audio.PushAudioInputStream(stream_format=fmt)
        recognizer = speechsdk.KeywordRecognizer(speechsdk.audio.AudioConfig(stream=push))

        done = threading.Event()
        hit: dict = {"fired_at": None}

        def _on_recognized(evt: object, _hit: dict = hit, _done: threading.Event = done) -> None:
            result = getattr(evt, "result", None)
            if getattr(result, "reason", None) == speechsdk.ResultReason.RecognizedKeyword:
                # `offset` is 100 ns ticks from the start of the stream.
                _hit["fired_at"] = round((getattr(result, "offset", 0) or 0) / 1e7, 3)
            _done.set()

        recognizer.recognized.connect(_on_recognized)
        recognizer.canceled.connect(lambda evt, _d=done: _d.set())

        recognizer.recognize_once_async(model)
        push.write(audio.tobytes())
        push.write(np.zeros(16_000, dtype=np.int16).tobytes())  # trailing silence to flush
        push.close()
        done.wait(timeout=10)
        try:
            recognizer.stop_recognition_async().get()
        except Exception:
            pass
        out.append({"clip": name, "fired_at": hit["fired_at"]})
    return out


# -- report ---------------------------------------------------------------


def _summarise(rows: list[dict], label: str, is_positive: bool) -> str:
    fired = [r for r in rows if r["fired_at"] is not None]
    rate = len(fired) / len(rows)
    metric = "recall" if is_positive else "false-accept rate"
    line = f"  {label:12} {metric}: {len(fired)}/{len(rows)} = {rate:.0%}"
    if is_positive and fired:
        lat = [r["fired_at"] for r in fired if r["fired_at"]]
        if lat:
            line += (
                f"   fired at: median {statistics.median(lat):.2f}s into the clip"
                f" (min {min(lat):.2f}, max {max(lat):.2f}; >= phrase + model context)"
            )
    return line


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--positives", type=Path, default=REPO_ROOT / "voice-captures")
    parser.add_argument("--negatives", type=Path, default=REPO_ROOT / "voice-samples")
    parser.add_argument(
        "--oww-threshold",
        type=float,
        action="append",
        help="openWakeWord score threshold(s) to report (repeatable; default 0.3 and 0.5)",
    )
    parser.add_argument("--detectors", default="openwakeword,azure,invoke_gate")
    parser.add_argument(
        "--gate-preroll-ms",
        type=int,
        default=2000,
        help="invoke_gate: preroll kept before speech onset (default 2000, the daemon default)",
    )
    args = parser.parse_args()
    thresholds = args.oww_threshold or [0.3, 0.5]
    detectors = args.detectors.split(",")

    positives = load_clips(args.positives)
    negatives = load_clips(args.negatives)
    print(f"corpus: {len(positives)} positive, {len(negatives)} negative clips")
    print(f"        positives: {args.positives}")
    print(f"        negatives: {args.negatives}\n")

    if "openwakeword" in detectors:
        for th in thresholds:
            pos = eval_openwakeword(positives, th)
            neg = eval_openwakeword(negatives, th)
            print(f"openWakeWord (mission_control.onnx, threshold {th})")
            print(_summarise(pos, "positives", True))
            print(_summarise(neg, "negatives", False))
            pk_pos = statistics.median(r["peak"] for r in pos)
            pk_neg = statistics.median(r["peak"] for r in neg)
            print(f"  peak-score median: positives {pk_pos:.3f} vs negatives {pk_neg:.3f}")
            miss = [r["clip"] for r in pos if r["fired_at"] is None]
            fa = [r["clip"] for r in neg if r["fired_at"] is not None]
            if miss:
                print(f"  missed: {', '.join(miss)}")
            if fa:
                print(f"  false accepts: {', '.join(fa)}")
            print()

    if "invoke_gate" in detectors:
        for th in thresholds:
            pos = eval_invoke_gate(positives, th, args.gate_preroll_ms)
            neg = eval_invoke_gate(negatives, th, args.gate_preroll_ms)
            print(
                f"invoke_gate: selected detector over the gated window (openWakeWord, "
                f"preroll {args.gate_preroll_ms} ms, threshold {th})"
            )
            print(_summarise(pos, "positives", True))
            print(_summarise(neg, "negatives", False))
            miss = [r["clip"] for r in pos if r["fired_at"] is None]
            fa = [r["clip"] for r in neg if r["fired_at"] is not None]
            if miss:
                print(f"  missed: {', '.join(miss)}")
            if fa:
                print(f"  false accepts: {', '.join(fa)}")
            print("  (approximation — no device / mock_invoke_gate in the loop)")
            print()

    if "azure" in detectors:
        pos = eval_azure(positives)
        neg = eval_azure(negatives)
        print("Azure custom keyword (azure_mission_control_basic_med.table)")
        print(_summarise(pos, "positives", True))
        print(_summarise(neg, "negatives", False))
        print("  (KeywordRecognizer does not expose a usable fire offset offline — no latency)")
        miss = [r["clip"] for r in pos if r["fired_at"] is None]
        fa = [r["clip"] for r in neg if r["fired_at"] is not None]
        if miss:
            print(f"  missed: {', '.join(miss)}")
        if fa:
            print(f"  false accepts: {', '.join(fa)}")
        print()


if __name__ == "__main__":
    main()
