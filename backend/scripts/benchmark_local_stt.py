"""Measure the local voice pipeline's real interaction characteristics on *this* host.

Two modes:

  # 1. STT latency & accuracy on real audio
  python -m scripts.benchmark_local_stt stt --audio-dir ./voice-samples
  python -m scripts.benchmark_local_stt stt --synthesize     # SAPI/espeak, Windows/Linux

  # 2. The semantic layer over the whole utterance corpus (no audio, no model)
  python -m scripts.benchmark_local_stt intent

``stt`` reports, per engine: model-load time, first-partial latency, end-of-speech
-> final-transcript latency, total speech->result latency, the transcript, and (if
``psutil`` is installed) process CPU% / RSS, plus CUDA memory when a GPU is used.
It streams each file in 100 ms chunks to mimic the kiosk.

The point is an **evidence-based engine/model choice on the target machine** — do
not trust published "minutes per second" numbers (``AGENTS.md`` ->
"Hardware assumptions"). Model binaries are downloaded per run, never committed.

Reusable local command corpus: put ``.wav`` files (16 kHz mono preferred; anything
else is resampled) in a directory and point ``--audio-dir`` at it. Personal
recordings are **not** committed — ``backend/voice-samples/`` is git-ignored.
"""

from __future__ import annotations

import argparse
import json
import statistics
import sys
import time
import wave
from dataclasses import dataclass, field
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from app.config import Settings  # noqa: E402
from app.voice.local.engines import available_engines  # noqa: E402
from app.voice.local.recognizer import SpeechRecognizer  # noqa: E402

CORPUS = REPO_ROOT / "tests" / "data" / "voice_commands.jsonl"
DEFAULT_SAMPLES_DIR = REPO_ROOT / "voice-samples"
CHUNK_MS = 100


def _load_corpus() -> list[dict]:
    return [json.loads(line) for line in CORPUS.read_text().splitlines() if line.strip()]


# -- audio -----------------------------------------------------------------


def _read_wav_16k_mono(path: Path) -> bytes:
    with wave.open(str(path), "rb") as wf:
        rate = wf.getframerate()
        channels = wf.getnchannels()
        width = wf.getsampwidth()
        frames = wf.readframes(wf.getnframes())
    if width != 2:
        raise SystemExit(f"{path.name}: need 16-bit PCM, got {width * 8}-bit")
    import array

    samples = array.array("h", frames)
    if channels == 2:
        samples = array.array("h", (samples[i] for i in range(0, len(samples), 2)))
    if rate != 16_000:
        samples = _resample_16k(samples, rate)
    return samples.tobytes()


def _resample_16k(samples, from_rate: int):
    import array

    ratio = from_rate / 16_000
    out = array.array("h")
    n = int(len(samples) / ratio)
    for i in range(n):
        src = int(i * ratio)
        out.append(samples[min(src, len(samples) - 1)])
    return out


def _synthesize(corpus: list[dict], out_dir: Path) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    phrases = [row["text"] for row in corpus]
    if sys.platform == "win32":
        import subprocess

        script = (
            "Add-Type -AssemblyName System.Speech;"
            "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer;"
            "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
            "16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
            "[System.Speech.AudioFormat.AudioChannel]::Mono);"
        )
        for i, phrase in enumerate(phrases):
            safe = phrase.replace("'", "''")
            script += (
                f"$s.SetOutputToWaveFile('{out_dir / f'{i:02d}.wav'}',$fmt);$s.Speak('{safe}');"
            )
        script += "$s.Dispose();"
        subprocess.run(["powershell", "-NoProfile", "-Command", script], check=True)
    else:
        import shutil
        import subprocess

        if not shutil.which("espeak-ng") and not shutil.which("espeak"):
            raise SystemExit("install espeak-ng for --synthesize on Linux, or pass --audio-dir")
        exe = shutil.which("espeak-ng") or "espeak"
        for i, phrase in enumerate(phrases):
            subprocess.run(
                [exe, "-w", str(out_dir / f"{i:02d}.wav"), "-s", "150", phrase], check=True
            )
    print(f"synthesised {len(phrases)} phrases -> {out_dir}")


# -- resource sampling ---------------------------------------------------


class _Resources:
    def __init__(self) -> None:
        self.ok = False
        try:
            import psutil

            self._p = psutil.Process()
            self._p.cpu_percent(None)
            self.ok = True
        except Exception:  # noqa: BLE001
            self._p = None

    def sample(self) -> dict:
        if not self.ok:
            return {}
        out = {
            "cpu_percent": round(self._p.cpu_percent(None), 1),
            "rss_mb": round(self._p.memory_info().rss / 1e6, 1),
        }
        try:
            import ctranslate2

            if ctranslate2.get_cuda_device_count() > 0:
                import torch

                out["cuda_mem_mb"] = round(torch.cuda.max_memory_allocated() / 1e6, 1)
        except Exception:  # noqa: BLE001
            pass
        return out


# -- the STT benchmark --------------------------------------------------


@dataclass
class Sample:
    file: str
    expected: str
    transcript: str = ""
    first_partial_ms: float | None = None
    final_after_eos_ms: float | None = None
    total_ms: float | None = None
    audio_ms: float = 0.0
    wer: float | None = None


@dataclass
class EngineResult:
    engine: str
    model_load_ms: float = 0.0
    samples: list[Sample] = field(default_factory=list)
    resources: dict = field(default_factory=dict)

    def summary(self) -> dict:
        finals = [s.final_after_eos_ms for s in self.samples if s.final_after_eos_ms is not None]
        totals = [s.total_ms for s in self.samples if s.total_ms is not None]
        partials = [s.first_partial_ms for s in self.samples if s.first_partial_ms is not None]
        wers = [s.wer for s in self.samples if s.wer is not None]
        rtf = [
            (s.total_ms / s.audio_ms) for s in self.samples if s.audio_ms and s.total_ms is not None
        ]
        return {
            "engine": self.engine,
            "model_load_ms": round(self.model_load_ms, 1),
            "n": len(self.samples),
            "first_partial_ms_median": _median(partials),
            "final_after_eos_ms_median": _median(finals),
            "final_after_eos_ms_p90": _p(finals, 0.9),
            "total_ms_median": _median(totals),
            "realtime_factor_median": round(_median(rtf) or 0, 3),
            "wer_mean": round(statistics.mean(wers), 3) if wers else None,
            "resources": self.resources,
        }


def _median(xs: list[float]) -> float | None:
    return round(statistics.median(xs), 1) if xs else None


def _p(xs: list[float], q: float) -> float | None:
    if not xs:
        return None
    s = sorted(xs)
    return round(s[min(len(s) - 1, int(q * len(s)))], 1)


def _wer(reference: str, hypothesis: str) -> float:
    import re

    def toks(s: str) -> list[str]:
        return re.findall(r"[a-z0-9]+", s.lower())

    r, h = toks(reference), toks(hypothesis)
    if not r:
        return 0.0 if not h else 1.0
    d = list(range(len(h) + 1))
    for i in range(1, len(r) + 1):
        prev, d[0] = d[0], i
        for j in range(1, len(h) + 1):
            cur = min(d[j] + 1, d[j - 1] + 1, prev + (r[i - 1] != h[j - 1]))
            prev, d[j] = d[j], cur
    return round(d[len(h)] / len(r), 3)


def _bench_engine(
    engine_id: str, files: list[tuple[Path, str]], settings: Settings
) -> EngineResult:
    from app.voice.local.engines import create_recognizer

    settings = settings.model_copy(update={"local_stt_engine": engine_id})
    resources = _Resources()
    load_start = time.perf_counter()
    recognizer: SpeechRecognizer = create_recognizer(settings)
    result = EngineResult(
        engine=recognizer.name, model_load_ms=(time.perf_counter() - load_start) * 1000
    )

    for path, expected in files:
        pcm = _read_wav_16k_mono(path)
        recognizer.reset()
        sample = Sample(file=path.name, expected=expected, audio_ms=len(pcm) / 2 / 16)
        chunk = int(16_000 * CHUNK_MS / 1000) * 2
        t0 = time.perf_counter()
        for off in range(0, len(pcm), chunk):
            for ev in recognizer.accept_audio(pcm[off : off + chunk]):
                if ev.type == "partial" and sample.first_partial_ms is None:
                    sample.first_partial_ms = (time.perf_counter() - t0) * 1000
        eos = time.perf_counter()
        finals = recognizer.finalize()
        now = time.perf_counter()
        sample.final_after_eos_ms = (now - eos) * 1000
        sample.total_ms = (now - t0) * 1000
        sample.transcript = next((e.text for e in finals if e.type == "final"), "")
        sample.wer = _wer(expected, sample.transcript)
        result.samples.append(sample)

    result.resources = resources.sample()
    recognizer.close()
    return result


def _print_stt(results: list[EngineResult]) -> None:
    for r in results:
        print(f"\n=== {r.engine} ===")
        print(f"model load: {r.model_load_ms:.0f} ms")
        for s in r.samples:
            fp = f"{s.first_partial_ms:.0f}" if s.first_partial_ms else "-"
            print(
                f"  [{s.wer:.2f} wer] final+{s.final_after_eos_ms:6.0f}ms "
                f"total {s.total_ms:6.0f}ms  1st-partial {fp:>5}ms  "
                f"“{s.transcript}”  (want “{s.expected}”)"
            )
        print("  summary:", json.dumps(r.summary(), indent=None))


# -- the intent benchmark ---------------------------------------------


def _bench_intent(settings: Settings) -> None:
    from datetime import datetime, timedelta

    from app.calendar.provider import MockCalendarProvider
    from app.models import CalendarRange
    from app.voice.local.adapter import LocalHybridAdapter
    from app.voice.local.interpreter import interpret

    corpus = _load_corpus()
    provider = MockCalendarProvider()
    snap = provider.snapshot(
        CalendarRange(
            starts_on=datetime.now().date(), ends_on=datetime.now().date() + timedelta(days=14)
        )
    )
    cfg = LocalHybridAdapter()._interpreter_config(settings)
    now = datetime.now()

    hits_intent = hits_disposition = 0
    times: list[float] = []
    print(f"{'utterance':52} {'disposition':20} {'intent':22} ok")
    for row in corpus:
        t0 = time.perf_counter()
        r = interpret(row["text"], now=now, snapshot=snap, config=cfg)
        times.append((time.perf_counter() - t0) * 1000)
        di_ok = r.disposition.value == row.get("disposition")
        in_ok = r.intent == row.get("intent")
        hits_intent += in_ok
        hits_disposition += di_ok
        flag = "  " if (di_ok and in_ok) else ("d!" if not di_ok else "i!")
        print(f"{row['text'][:52]:52} {r.disposition.value:20} {r.intent:22} {flag}")
    n = len(corpus)
    print(
        f"\nintent {hits_intent}/{n}  disposition {hits_disposition}/{n}  "
        f"median {statistics.median(times):.2f} ms  max {max(times):.2f} ms"
    )


# -- cli --------------------------------------------------------------


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    sub = parser.add_subparsers(dest="mode", required=True)

    p_stt = sub.add_parser("stt", help="STT latency & accuracy on real audio")
    p_stt.add_argument("--audio-dir", type=Path, default=DEFAULT_SAMPLES_DIR)
    p_stt.add_argument("--synthesize", action="store_true", help="make WAVs with SAPI/espeak first")
    p_stt.add_argument("--engines", default="", help="comma list; default = all installed")
    p_stt.add_argument("--json", type=Path, help="also write the summary here")

    sub.add_parser("intent", help="semantic layer over the whole corpus (no audio)")

    args = parser.parse_args()
    settings = Settings(_env_file=None)

    if args.mode == "intent":
        _bench_intent(settings)
        return

    corpus = _load_corpus()
    if args.synthesize:
        _synthesize(corpus, args.audio_dir)
    wavs = sorted(args.audio_dir.glob("*.wav"))
    if not wavs:
        raise SystemExit(f"no .wav files in {args.audio_dir} — pass --audio-dir or --synthesize")
    files = [(w, corpus[i]["text"] if i < len(corpus) else "") for i, w in enumerate(wavs)]

    engine_ids = [e.strip() for e in args.engines.split(",") if e.strip()] or [
        e for e in available_engines() if e != "null"
    ]
    if not engine_ids:
        raise SystemExit("no STT engine installed — pip install faster-whisper or sherpa-onnx")

    results = [_bench_engine(e, files, settings) for e in engine_ids]
    _print_stt(results)
    if args.json:
        args.json.write_text(json.dumps([r.summary() for r in results], indent=2))
        print(f"\nwrote {args.json}")


if __name__ == "__main__":
    main()
