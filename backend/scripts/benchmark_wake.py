"""Compare wake-word detectors for a keyword on the same audio, with statistics.

    # real close-mic corpus already on disk (small — a smoke test)
    python -m scripts.benchmark_wake --positives voice-captures --negatives voice-samples

    # a synthetic eval corpus (many clips, every detector scores raw WAV)
    python -m scripts.gen_wake_corpus --keyword mission_control --engine azure-tts \
        --profile coarse --noise-dir <noise> --rir-dir <rir>
    python -m scripts.benchmark_wake --manifest ./wake-corpus/mission_control/manifest.json \
        --json run-b.json

    # did retraining help? re-run against the SAME corpus, diff the JSON
    python -m scripts.benchmark_wake --manifest .../manifest.json --json run-c.json \
        --baseline run-b.json

Scores, per detector — openWakeWord at each ``--oww-threshold`` and every
``--azure-table`` (``azure_<keyword>_basic_med.table``,
``azure_<keyword>_advanced.table``, …) as its own column:

* **recall** with a Wilson 95% CI — fraction of positive clips detected
* **hard-negative false accepts** with a CI — negatives (no wake phrase) that fired
* **latency** — seconds from clip start to detection (openWakeWord only, offline)
* **recall by condition** — broken out by the manifest's SNR / augmentation tag
* **openWakeWord threshold sweep** — recall vs hard-negative FA across thresholds,
  plus the operating point that matches a target FA rate (``--target-fa``)
* **head-to-head** — an exact-binomial McNemar of openWakeWord vs each Azure
  table, and (with ``--baseline``) of this run vs a previous one

This still does **not** produce a false-accepts-per-hour figure — that needs a
long ambient corpus, not a hard-negative set. See
``docs/wake-word-provider-bakeoff.md`` -> "What this does not establish".

The keyword defaults to the manifest's (else ``mission_control``); model paths
follow ``<keyword>.onnx`` / ``azure_<keyword>_*.table`` unless overridden.
Benchmark-only deps, installed on demand: ``pip install openwakeword`` and the
``azure-wake`` extra. The evaluation maths lives in ``scripts/wake_eval.py`` and
is unit-tested without any of them.
"""

from __future__ import annotations

import argparse
import json
import sys
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.wake_eval import (  # noqa: E402
    ClipOutcome,
    DetectorRun,
    Manifest,
    diff_runs,
    format_pair_comparison,
    format_run,
    operating_point_for_fa,
    threshold_sweep,
    verify_manifest,
)

WORKSPACE_ROOT = REPO_ROOT.parent
WAKE_MODELS = WORKSPACE_ROOT / "frontend" / "public" / "models" / "wake"

OWW_STEP = 1280  # 80 ms at 16 kHz — the detector step used by frontend/src/voice/wake
SWEEP_FLOOR = 0.05  # score at/above which we record a first-crossing time
SWEEP_GRID = [round(x, 2) for x in np.arange(0.05, 1.0, 0.05)]

# A labelled clip: (name, int16 mono 16 kHz audio, "positive"|"negative", tag)
Clip = tuple[str, np.ndarray, str, str]


def read_wav_16k_mono(path: Path) -> np.ndarray:
    """Whole file as int16 mono at 16 kHz (linear-resampled if needed)."""
    import wave

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


def load_dir(directory: Path, label: str) -> list[Clip]:
    clips = [(p.name, read_wav_16k_mono(p), label, "") for p in sorted(directory.glob("*.wav"))]
    if not clips:
        sys.exit(f"no .wav files in {directory}")
    return clips


def load_manifest(manifest_path: Path) -> tuple[list[Clip], Manifest]:
    manifest = Manifest.load(manifest_path)
    audio_dir = manifest_path.parent
    problems = verify_manifest(manifest, audio_dir)
    if problems:
        print(f"WARNING: {len(problems)} manifest mismatch(es) - a v1/v2 comparison is NOT valid:")
        for line in problems[:10]:
            print(f"  {line}")
        if len(problems) > 10:
            print(f"  ... and {len(problems) - 10} more")
    clips = [
        (e.file, read_wav_16k_mono(audio_dir / e.file), e.label, e.tag)
        for e in manifest.entries
        if (audio_dir / e.file).exists()
    ]
    return clips, manifest


# -- openWakeWord ------------------------------------------------------------


def eval_openwakeword(clips: list[Clip], model_path: Path, models_dir: Path) -> dict[str, dict]:
    """Per-clip peak score + first time the score crossed SWEEP_FLOOR.

    Score-based, so every threshold is derived from this one pass rather than
    re-running the model per threshold. ``models_dir`` holds the two shared
    feature models (``melspectrogram.onnx`` / ``embedding_model.onnx``).
    """
    from openwakeword.model import Model

    mel = models_dir / "melspectrogram.onnx"
    emb = models_dir / "embedding_model.onnx"
    for p in (model_path, mel, emb):
        if not p.exists():
            sys.exit(f"openWakeWord asset not found: {p} (pass --oww-model / --models-dir)")
    model = Model(
        wakeword_models=[str(model_path)],
        inference_framework="onnx",
        melspec_model_path=str(mel),
        embedding_model_path=str(emb),
    )
    out: dict[str, dict] = {}
    for name, audio, _label, _tag in clips:
        model.reset()
        peak = 0.0
        crossed_at: float | None = None
        for start in range(0, max(0, len(audio) - OWW_STEP) + 1, OWW_STEP):
            frame = audio[start : start + OWW_STEP]
            if len(frame) < OWW_STEP:
                break
            score = float(next(iter(model.predict(frame).values())))
            peak = max(peak, score)
            if crossed_at is None and score >= SWEEP_FLOOR:
                crossed_at = (start + OWW_STEP) / 16_000
        out[name] = {"peak": round(peak, 4), "crossed_at": crossed_at}
    return out


def oww_run(clips: list[Clip], scores: dict[str, dict], threshold: float) -> DetectorRun:
    run = DetectorRun(name="openWakeWord", threshold=threshold)
    for name, _audio, label, tag in clips:
        s = scores[name]
        fired = s["peak"] >= threshold
        run.clips.append(
            ClipOutcome(
                clip=name,
                label=label,
                fired=fired,
                # crossed_at is the SWEEP_FLOOR crossing — a lower bound on the
                # true threshold crossing; latency here is approximate on purpose.
                fired_at=s["crossed_at"] if fired else None,
                peak=s["peak"],
                tag=tag,
            )
        )
    return run


# -- invoke_gate (selected detector's re-check over the gated window) ------
#
# The on-device Invoke gate is additive: it sits in front of whichever provider is
# selected. This approximates its handoff by trimming each clip to
# ``[speech_onset - gate_preroll_ms, end]`` (model reset at that OFF->OPEN edge)
# and re-running openWakeWord — no device, no ``mock_invoke_gate`` in the loop.


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


def gate_trim(clips: list[Clip], gate_preroll_ms: int) -> list[Clip]:
    preroll = int(gate_preroll_ms * 16)  # samples at 16 kHz
    return [(n, a[max(0, _speech_onset(a) - preroll) :], lbl, tag) for n, a, lbl, tag in clips]


# -- Azure custom keyword ---------------------------------------------------


def azure_table_label(table: Path, slug: str) -> str:
    """`azure_mission_control_basic_med.table` -> "Azure (basic_med)"."""
    stem = table.stem
    for prefix in (f"azure_{slug}_", f"azure_{slug}", "azure_", slug):
        if stem.startswith(prefix):
            stem = stem[len(prefix) :].strip("_-")
            break
    return f"Azure ({stem or 'keyword'})"


def azure_table_tier(table: Path) -> int | None:
    """The tier byte at offset 8 (LE uint32): basic == 3, advanced == 6.

    The offline ``KeywordRecognizer`` only matches **basic** (3). Advanced
    tables load without error but never fire — verified 2026-09-08 on SDK
    1.51.2; they need the Embedded Speech SDK. See
    ``frontend/public/models/wake/azure-advanced/README.md``.
    """
    try:
        return int.from_bytes(table.read_bytes()[8:12], "little")
    except Exception:  # noqa: BLE001
        return None


def eval_azure(clips: list[Clip], table: Path, label: str) -> DetectorRun:
    import threading

    import azure.cognitiveservices.speech as speechsdk

    if not table.exists():
        sys.exit(f"Azure .table not found: {table} (pass --azure-table)")
    model = speechsdk.KeywordRecognitionModel(str(table))
    run = DetectorRun(name=label)
    for name, audio, label, tag in clips:
        fmt = speechsdk.audio.AudioStreamFormat(
            samples_per_second=16_000, bits_per_sample=16, channels=1
        )
        push = speechsdk.audio.PushAudioInputStream(stream_format=fmt)
        recognizer = speechsdk.KeywordRecognizer(speechsdk.audio.AudioConfig(stream=push))

        done = threading.Event()
        hit: dict = {"fired_at": None, "fired": False}

        def _on_recognized(evt: object, _hit: dict = hit, _done: threading.Event = done) -> None:
            result = getattr(evt, "result", None)
            if getattr(result, "reason", None) == speechsdk.ResultReason.RecognizedKeyword:
                _hit["fired"] = True
                _hit["fired_at"] = round((getattr(result, "offset", 0) or 0) / 1e7, 3) or None
            _done.set()

        recognizer.recognized.connect(_on_recognized)
        # `canceled` fires with EndOfStream once the closed push stream drains —
        # that is the "no detection" signal, so the wait below is just a safety net.
        recognizer.canceled.connect(lambda evt, _d=done: _d.set())

        recognizer.recognize_once_async(model)
        push.write(audio.tobytes())
        push.write(np.zeros(8_000, dtype=np.int16).tobytes())  # 0.5 s trailing silence to flush
        push.close()
        if not done.wait(timeout=8):
            print(f"  (timeout on {name} — treating as no detection)")
        try:
            recognizer.stop_recognition_async().get()
        except Exception:
            pass
        run.clips.append(
            ClipOutcome(
                clip=name,
                label=label,
                fired=hit["fired"],
                fired_at=hit["fired_at"],
                tag=tag,
            )
        )
    return run


# -- report ---------------------------------------------------------------


def print_sweep(sweep: list[dict], target_fa: float) -> None:
    print("openWakeWord threshold sweep (hard negatives - NOT false-accepts-per-hour)")
    print(f"  {'thresh':>7}  {'recall':>8}  {'hard-neg FA':>12}")
    for row in sweep:
        rec = f"{row['recall']:.0%}" if row["recall"] is not None else "-"
        fa = f"{row['hard_neg_fa']:.0%}" if row["hard_neg_fa"] is not None else "-"
        print(f"  {row['threshold']:>7.2f}  {rec:>8}  {fa:>12}")
    op = operating_point_for_fa(sweep, target_fa)
    if op:
        print(
            f"  -> lowest threshold with hard-neg FA <= {target_fa:.0%}: "
            f"{op['threshold']:.2f}  (recall {op['recall']:.0%})"
        )
    else:
        print(f"  -> no threshold reaches hard-neg FA <= {target_fa:.0%} on this corpus")


def _resolve_keyword(args: argparse.Namespace, manifest: Manifest | None) -> str:
    return args.keyword or (manifest.keyword if manifest else None) or "mission_control"


def _resolve_azure_tables(args: argparse.Namespace, slug: str, models_dir: Path) -> list[Path]:
    if args.azure_table:
        return [Path(t) for t in args.azure_table]
    return sorted(models_dir.glob(f"azure_{slug}_*.table")) or sorted(
        models_dir.glob(f"azure_{slug}.table")
    )


def main() -> None:
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    parser.add_argument("--keyword", help="slug (default: the manifest's, else mission_control)")
    parser.add_argument("--manifest", type=Path, help="synthetic corpus manifest.json")
    parser.add_argument("--positives", type=Path, default=REPO_ROOT / "voice-captures")
    parser.add_argument("--negatives", type=Path, default=REPO_ROOT / "voice-samples")
    parser.add_argument(
        "--models-dir",
        type=Path,
        default=WAKE_MODELS,
        help="dir holding the .onnx / .table assets (default: the frontend models dir)",
    )
    parser.add_argument("--oww-model", type=Path, help="openWakeWord .onnx (else <keyword>.onnx)")
    parser.add_argument(
        "--azure-table",
        action="append",
        help="Azure .table(s) to score as columns (repeatable; "
        "default: every azure_<keyword>_*.table in the models dir)",
    )
    parser.add_argument(
        "--oww-threshold",
        type=float,
        action="append",
        help="openWakeWord threshold(s) to report in detail (repeatable; default 0.3, 0.5)",
    )
    parser.add_argument(
        "--target-fa",
        type=float,
        default=0.0,
        help="hard-negative FA rate to solve the openWakeWord operating point for (default 0)",
    )
    parser.add_argument("--detectors", default="openwakeword,azure,invoke_gate")
    parser.add_argument(
        "--gate-preroll-ms",
        type=int,
        default=2000,
        help="invoke_gate: preroll kept before speech onset (default 2000, the daemon default)",
    )
    parser.add_argument("--json", type=Path, help="write the full run (per-clip outcomes) here")
    parser.add_argument("--baseline", type=Path, help="a previous --json run to diff against")
    args = parser.parse_args()

    thresholds = sorted(args.oww_threshold or [0.3, 0.5])
    detectors = args.detectors.split(",")

    if args.manifest:
        clips, manifest = load_manifest(args.manifest)
        src = f"manifest {args.manifest} (engine {manifest.engine}, seed {manifest.spec_seed})"
    else:
        clips = load_dir(args.positives, "positive") + load_dir(args.negatives, "negative")
        manifest = None
        src = f"{args.positives} + {args.negatives}"
    slug = _resolve_keyword(args, manifest)
    models_dir: Path = args.models_dir
    oww_model = args.oww_model or models_dir / f"{slug}.onnx"
    npos = sum(1 for c in clips if c[2] == "positive")
    print(f"keyword: {slug}")
    print(f"corpus:  {npos} positive, {len(clips) - npos} negative clips")
    print(f"         {src}\n")

    runs: dict[str, DetectorRun] = {}
    sweep: list[dict] = []

    if "openwakeword" in detectors:
        scores = eval_openwakeword(clips, oww_model, models_dir)
        pos_peaks = [scores[n]["peak"] for n, _a, lbl, _t in clips if lbl == "positive"]
        neg_peaks = [scores[n]["peak"] for n, _a, lbl, _t in clips if lbl == "negative"]
        sweep = threshold_sweep(pos_peaks, neg_peaks, SWEEP_GRID)
        for th in thresholds:
            run = oww_run(clips, scores, th)
            runs[f"openwakeword@{th:.2f}"] = run
            print(format_run(run))
            print()
        print_sweep(sweep, args.target_fa)
        print()

    if "invoke_gate" in detectors:
        gated = gate_trim(clips, args.gate_preroll_ms)
        gscores = eval_openwakeword(gated, oww_model, models_dir)
        for th in thresholds:
            run = oww_run(gated, gscores, th)
            run.name = f"invoke_gate (openWakeWord, preroll {args.gate_preroll_ms} ms)"
            runs[f"invoke_gate@{th:.2f}"] = run
            print(format_run(run))
            print("  (approximation - no device / mock_invoke_gate in the loop)")
            print()

    azure_runs: list[str] = []
    if "azure" in detectors:
        tables = _resolve_azure_tables(args, slug, models_dir)
        if not tables:
            print(f"(no azure_{slug}_*.table found - skipping Azure; pass --azure-table)\n")
        for table in tables:
            label = azure_table_label(table, slug)
            tier = azure_table_tier(table)
            if tier not in (None, 3):
                print(
                    f"WARNING: {table.name} is tier {tier} (not basic=3). The offline "
                    "KeywordRecognizer does not match advanced tables — expect 0 detections. "
                    "See frontend/public/models/wake/azure-advanced/README.md"
                )
            run = eval_azure(clips, table, label)
            key = f"azure:{table.stem}"
            runs[key] = run
            azure_runs.append(key)
            print(format_run(run))
            print()

    # head-to-head: openWakeWord (lowest reported threshold) vs each Azure table
    oww_key = next((k for k in runs if k.startswith("openwakeword@")), None)
    if oww_key:
        for key in azure_runs:
            print(format_pair_comparison(runs[oww_key], runs[key]))
            print()

    if args.baseline:
        base_blob = json.loads(args.baseline.read_text())
        base_runs = {k: DetectorRun.from_json(v) for k, v in base_blob["runs"].items()}
        print(f"=== diff vs {args.baseline} ===")
        for key, run in runs.items():
            if key in base_runs:
                print(json.dumps(diff_runs(base_runs[key], run), indent=2))
        print()

    if args.json:
        blob = {
            "generated_at": datetime.now(UTC).isoformat(timespec="seconds"),
            "keyword": slug,
            "models_dir": str(models_dir),
            "oww_model": str(oww_model),
            "corpus": {
                "source": src,
                "positives": npos,
                "negatives": len(clips) - npos,
                "manifest_seed": manifest.spec_seed if manifest else None,
            },
            "runs": {k: v.to_json() for k, v in runs.items()},
            "openwakeword_threshold_sweep": sweep,
        }
        args.json.write_text(json.dumps(blob, indent=2))
        print(f"wrote {args.json}")


if __name__ == "__main__":
    main()
