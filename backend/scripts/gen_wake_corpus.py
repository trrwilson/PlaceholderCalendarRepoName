"""Generate a synthetic wake-word evaluation corpus for a keyword.

    python -m scripts.gen_wake_corpus --keyword mission_control --engine azure-tts

Reads a per-keyword spec (`tests/data/wake_corpus/<slug>.json`) and the shared
`_voices.json`, writes 16 kHz mono WAVs + a `manifest.json` that
`benchmark_wake.py --manifest` consumes.

Why (see `docs/wake-word-provider-bakeoff.md`): the real-audio corpus is ~10
positives — too small to compare detectors or to tell whether a retrained model
improved. This makes a few hundred labelled clips across many voices, speaking
rates and SNRs, in raw WAV so **both** detectors can score it (openWakeWord's
own training holdout is feature vectors — Azure's `.table` cannot read those).

TTS engines:

* `azure-tts` — Azure Neural TTS (the widest, most natural voice set; SSML rate
  control). Reuses the shared Azure key + region from `Settings`
  (`azure_speech_key` / `azure_speech_region`); prints a character count + cost
  estimate and waits for confirmation. `--max-chars` hard-caps a run.
* `piper`     — the training env's multi-speaker `en_US-libritts_r` model
  (`--piper-model <.onnx>`, 904 speakers); free, offline.
* `sapi`      — Windows `System.Speech`; the 2-3 installed voices. No install.
* `espeak`    — `espeak-ng`; one voice, rate only. Last resort.

Augmentation (optional, the training env has both): `--noise-dir` mixes
background at each spec SNR; `--rir-dir` convolves a room impulse response.

Profiles (`--profile`, from `_voices.json`): `smoke` (fast, ~150 clips, proves
the pipeline), `coarse` (~2000, ranks the detectors), `full` (tighter CIs).

Adding a keyword: drop a `tests/data/wake_corpus/<slug>.json` next to
`mission_control.json` (same shape) and run with `--keyword <slug>`.

Nothing here needs a microphone. `azure-tts` needs network + the key; the other
engines are fully offline. Recording real close-mic positives on the kiosk is
still a separate, better signal for in-domain recall.
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
import tempfile
import wave
from datetime import UTC, datetime
from pathlib import Path

import numpy as np

REPO_ROOT = Path(__file__).resolve().parents[1]
if str(REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(REPO_ROOT))

from scripts.wake_eval import Manifest, ManifestEntry, sha256_file  # noqa: E402

SPEC_DIR = REPO_ROOT / "tests" / "data" / "wake_corpus"
COMMAND_CORPUS = REPO_ROOT / "tests" / "data" / "voice_commands.jsonl"
SR = 16_000
AZURE_TTS_USD_PER_MCHAR = 15.0  # standard neural, S0; free tier covers 500k/month


# -- TTS back ends -------------------------------------------------------


def _run_ps(script: str) -> str:
    with tempfile.NamedTemporaryFile("w", suffix=".ps1", delete=False, encoding="utf-8") as fh:
        fh.write(script)
        path = fh.name
    try:
        out = subprocess.run(
            ["powershell", "-NoProfile", "-ExecutionPolicy", "Bypass", "-File", path],
            check=True,
            capture_output=True,
            text=True,
        )
        return out.stdout
    finally:
        Path(path).unlink(missing_ok=True)


def _tts_sapi(jobs: list[tuple[Path, str, str, float]]) -> None:
    """jobs: (out_path, text, voice_name, rate_pct). SAPI rate is -10..10."""
    lines = [
        "Add-Type -AssemblyName System.Speech",
        "$s = New-Object System.Speech.Synthesis.SpeechSynthesizer",
        "$fmt = New-Object System.Speech.AudioFormat.SpeechAudioFormatInfo("
        "16000,[System.Speech.AudioFormat.AudioBitsPerSample]::Sixteen,"
        "[System.Speech.AudioFormat.AudioChannel]::Mono)",
    ]
    for out, text, voice, rate_pct in jobs:
        safe = text.replace("'", "''")
        lines.append(f"$s.SelectVoice('{voice.replace(chr(39), chr(39) * 2)}')")
        lines.append(f"$s.Rate = {int(round(rate_pct / 7.5))}")
        lines.append(f"$s.SetOutputToWaveFile('{out}')")
        lines.append(f"$s.Speak('{safe}')")
    lines.append("$s.Dispose()")
    _run_ps("\n".join(lines))


def _sapi_voices() -> list[str]:
    out = _run_ps(
        "Add-Type -AssemblyName System.Speech;"
        "(New-Object System.Speech.Synthesis.SpeechSynthesizer)."
        "GetInstalledVoices() | ForEach-Object { $_.VoiceInfo.Name }"
    )
    return [ln.strip() for ln in out.splitlines() if ln.strip()]


def _tts_espeak(jobs: list[tuple[Path, str, str, float]]) -> None:
    exe = shutil.which("espeak-ng") or shutil.which("espeak")
    for out, text, _voice, rate_pct in jobs:
        wpm = int(round(175 * (1 + rate_pct / 100)))
        subprocess.run([exe, "-w", str(out), "-s", str(wpm), text], check=True)


def _tts_piper(jobs: list[tuple[Path, str, str, float]], model: Path) -> None:
    exe = shutil.which("piper") or shutil.which("piper-tts")
    if not exe:
        sys.exit("piper not on PATH — `pip install piper-tts` or use --engine sapi")
    for out, text, speaker, rate_pct in jobs:
        cmd = [
            exe,
            "-m",
            str(model),
            "-f",
            str(out),
            "--length_scale",
            str(round(1.0 / (1 + rate_pct / 100), 3)),
        ]
        if speaker != "":
            cmd += ["-s", speaker]
        subprocess.run(cmd, check=True, input=text, text=True)


def _azure_ssml(text: str, voice: str, rate_pct: float) -> str:
    lang = "-".join(voice.split("-")[:2]) or "en-US"
    body = text.replace("&", "&amp;").replace("<", "&lt;").replace(">", "&gt;")
    if rate_pct:
        body = f"<prosody rate='{rate_pct:+.0f}%'>{body}</prosody>"
    return (
        f"<speak version='1.0' xmlns='http://www.w3.org/2001/10/synthesis' xml:lang='{lang}'>"
        f"<voice name='{voice}'>{body}</voice></speak>"
    )


def _tts_azure(jobs: list[tuple[Path, str, str, float]]) -> None:
    import azure.cognitiveservices.speech as speechsdk

    from app.config import get_settings

    s = get_settings()
    if not s.azure_speech_key:
        sys.exit(
            "no Azure Speech key: set MISSION_CONTROL_AZURE_SPEECH_KEY (or "
            "FOUNDRY_API_KEY_MC_EASTUS2) and MISSION_CONTROL_AZURE_SPEECH_REGION"
        )
    cfg = speechsdk.SpeechConfig(subscription=s.azure_speech_key, region=s.azure_speech_region)
    cfg.set_speech_synthesis_output_format(
        speechsdk.SpeechSynthesisOutputFormat.Riff16Khz16BitMonoPcm
    )
    # One synthesiser, no default audio out — reuses the connection; each clip is
    # pulled from the result and written to its own WAV.
    synth = speechsdk.SpeechSynthesizer(speech_config=cfg, audio_config=None)
    print(f"  azure region {s.azure_speech_region}, {len(jobs)} clips")
    for i, (out, text, voice, rate_pct) in enumerate(jobs, 1):
        result = synth.speak_ssml_async(_azure_ssml(text, voice, rate_pct)).get()
        if result.reason != speechsdk.ResultReason.SynthesizingAudioCompleted:
            detail = ""
            if result.reason == speechsdk.ResultReason.Canceled:
                c = speechsdk.SpeechSynthesisCancellationDetails(result)
                detail = f"{c.reason}: {c.error_details}"
            sys.exit(f"azure TTS failed on {out.name!r} ({voice}): {result.reason} {detail}")
        speechsdk.AudioDataStream(result).save_to_wav_file(str(out))
        if i % 25 == 0 or i == len(jobs):
            print(f"    {i}/{len(jobs)}")


# -- audio io + augmentation -------------------------------------------


def _read_mono_16k(path: Path) -> np.ndarray:
    with wave.open(str(path), "rb") as wf:
        rate, ch, n = wf.getframerate(), wf.getnchannels(), wf.getnframes()
        raw = wf.readframes(n)
    a = np.frombuffer(raw, dtype=np.int16).astype(np.float32) / 32768.0
    if ch > 1:
        a = a.reshape(-1, ch).mean(axis=1)
    if rate != SR:
        tgt = int(round(len(a) * SR / rate))
        a = np.interp(np.linspace(0, len(a) - 1, tgt), np.arange(len(a)), a).astype(np.float32)
    return a


def _write_16k(path: Path, audio: np.ndarray) -> float:
    pcm = np.clip(audio * 32768.0, -32768, 32767).astype(np.int16)
    with wave.open(str(path), "wb") as wf:
        wf.setnchannels(1)
        wf.setsampwidth(2)
        wf.setframerate(SR)
        wf.writeframes(pcm.tobytes())
    return round(len(pcm) / SR, 3)


def _apply_rir(audio: np.ndarray, rir: np.ndarray) -> np.ndarray:
    rir = rir / (np.max(np.abs(rir)) or 1.0)
    wet = np.convolve(audio, rir)[: len(audio) + SR // 2]
    peak = np.max(np.abs(wet)) or 1.0
    return (wet / peak * (np.max(np.abs(audio)) or 1.0)).astype(np.float32)


def _mix_noise(
    audio: np.ndarray, noise: np.ndarray, snr_db: float, rng: np.random.Generator
) -> np.ndarray:
    if len(noise) < len(audio):
        noise = np.tile(noise, int(np.ceil(len(audio) / len(noise))))
    start = int(rng.integers(0, len(noise) - len(audio) + 1))
    noise = noise[start : start + len(audio)]
    sig_p = float(np.mean(audio**2)) or 1e-9
    noise_p = float(np.mean(noise**2)) or 1e-9
    mixed = audio + noise * np.sqrt((sig_p / (10 ** (snr_db / 10))) / noise_p)
    peak = np.max(np.abs(mixed))
    return (mixed / peak).astype(np.float32) if peak > 1.0 else mixed.astype(np.float32)


# -- spec + plan -----------------------------------------------------


def _negatives_from_commands() -> list[str]:
    if not COMMAND_CORPUS.exists():
        return []
    return [json.loads(ln)["text"] for ln in COMMAND_CORPUS.read_text().splitlines() if ln.strip()]


def _resolve_voices(engine: str, count: int, shared: dict, piper_model: Path | None) -> list[str]:
    if engine == "azure-tts":
        return list(shared["azure_voices"])[:count] or sys.exit("no azure_voices in _voices.json")
    if engine == "sapi":
        return _sapi_voices()[:count] or [""]
    if engine == "piper":
        n_spk = int(shared.get("piper", {}).get("speaker_max", 1))
        if count <= 1 or n_spk <= 1:
            return [""]
        return [str(int(i)) for i in np.linspace(0, n_spk - 1, count).round()]
    return [""]  # espeak


def build(args: argparse.Namespace) -> None:
    spec_path = SPEC_DIR / f"{args.keyword}.json"
    if not spec_path.exists():
        sys.exit(f"no spec {spec_path} — add one (copy mission_control.json) or fix --keyword")
    spec = json.loads(spec_path.read_text())
    shared = json.loads((SPEC_DIR / "_voices.json").read_text())
    profile = shared["profiles"][args.profile]

    slug = spec["slug"]
    phrase = spec["phrase"]
    out_dir: Path = args.out or (REPO_ROOT / "wake-corpus" / slug)
    raw_dir = out_dir / "_raw"
    raw_dir.mkdir(parents=True, exist_ok=True)
    seed = args.seed if args.seed is not None else spec.get("seed", 0)
    rng = np.random.default_rng(seed)

    engine = args.engine
    if engine == "auto":
        engine = (
            "piper"
            if args.piper_model
            else "sapi"
            if sys.platform == "win32"
            else "espeak"
            if (shutil.which("espeak-ng") or shutil.which("espeak"))
            else sys.exit("no TTS engine: --engine azure-tts, --piper-model, or install espeak-ng")
        )

    n_voices = args.voices or profile["voices"]
    voices = _resolve_voices(engine, n_voices, shared, args.piper_model)
    nv = args.negative_voices or (len(voices) + 1) // 2
    neg_voices = voices[: max(1, min(len(voices), nv))]
    rates: list[float] = args.rates_pct or profile["rates_pct"]
    snrs: list[float | None] = [None] if args.clean_only else profile["snr_db"]
    print(f"keyword: {slug} ({phrase!r})   engine: {engine}   profile: {args.profile}")
    print(
        f"voices: {len(voices)} positive / {len(neg_voices)} negative"
        f"   rates: {rates}   snr: {snrs}"
    )

    pos_limit = (
        args.positives_limit if args.positives_limit is not None else profile["positives_limit"]
    )
    neg_limit = (
        args.negatives_limit if args.negatives_limit is not None else profile["negatives_limit"]
    )
    positives = spec["positives"][: pos_limit or None]
    negatives = list(spec["negatives_confusable"])
    if spec.get("negatives_from_command_corpus"):
        negatives += _negatives_from_commands()
    negatives = negatives[: neg_limit or None]

    # -- plan: one base render per (phrase, voice, rate) --
    plan: list[dict] = []
    for label, phrases, vs, rs in (
        ("positive", positives, voices, rates),
        ("negative", negatives, neg_voices, [0.0]),
    ):
        for pi, text in enumerate(phrases):
            for vi, voice in enumerate(vs):
                for ri, rate in enumerate(rs):
                    stem = f"{label[:3]}_{pi:03d}_v{vi:02d}_r{ri}"
                    plan.append(
                        {
                            "stem": stem,
                            "label": label,
                            "text": text,
                            "voice": voice,
                            "rate": float(rate),
                            "raw": raw_dir / f"{stem}.wav",
                        }
                    )

    todo = [r for r in plan if not r["raw"].exists()]
    chars = sum(len(r["text"]) for r in todo)
    print(f"\n{len(plan)} base renditions ({len(plan) - len(todo)} cached, {len(todo)} to synth)")
    if engine == "azure-tts" and todo:
        est = chars * 1.15 / 1_000_000 * AZURE_TTS_USD_PER_MCHAR
        print(f"  ~{chars} chars -> ~${est:.2f} on S0 (free tier covers 500k chars/month)")
        if args.max_chars and chars > args.max_chars:
            sys.exit(f"  {chars} chars over --max-chars {args.max_chars}")
        if not args.yes and input("  proceed? [y/N] ").strip().lower() != "y":
            sys.exit("aborted")

    if todo:
        jobs = [(r["raw"], r["text"], r["voice"], r["rate"]) for r in todo]
        {"azure-tts": _tts_azure, "sapi": _tts_sapi, "espeak": _tts_espeak}.get(
            engine, lambda j: _tts_piper(j, args.piper_model)
        )(jobs)

    # -- augmentation material --
    rirs = [_read_mono_16k(p) for p in sorted(args.rir_dir.glob("*.wav"))] if args.rir_dir else []
    noises = (
        [_read_mono_16k(p) for p in sorted(args.noise_dir.glob("*.wav"))] if args.noise_dir else []
    )
    if any(s is not None for s in snrs) and not noises:
        print("  note: no --noise-dir; emitting clean clips only")
        snrs = [None]

    # -- final clips + manifest --
    entries: list[ManifestEntry] = []
    for row in plan:
        if not row["raw"].exists():
            continue
        base = _read_mono_16k(row["raw"])
        if rirs:
            base = _apply_rir(base, rirs[int(rng.integers(0, len(rirs)))])
        for snr in snrs:
            tag = "clean" if snr is None else f"snr{int(snr)}"
            audio = (
                base
                if snr is None
                else _mix_noise(base, noises[int(rng.integers(0, len(noises)))], float(snr), rng)
            )
            name = f"{row['stem']}_{tag}.wav"
            seconds = _write_16k(out_dir / name, audio)
            entries.append(
                ManifestEntry(
                    file=name,
                    label=row["label"],
                    phrase=row["text"],
                    tag=tag,
                    sha256=sha256_file(out_dir / name),
                    seconds=seconds,
                    speaker=row["voice"] or None,
                    rate=row["rate"],
                    snr_db=None if snr is None else float(snr),
                )
            )

    manifest = Manifest(
        spec_seed=seed,
        engine=engine,
        generated_at=datetime.now(UTC).isoformat(timespec="seconds"),
        entries=entries,
        keyword=slug,
        phrase=phrase,
        profile=args.profile,
    )
    (out_dir / "manifest.json").write_text(json.dumps(manifest.to_json(), indent=2))
    npos = sum(e.label == "positive" for e in entries)
    print(
        f"\nwrote {len(entries)} clips ({npos} positive, {len(entries) - npos} negative)\n"
        f"  {out_dir / 'manifest.json'}"
    )
    if not args.keep_raw:
        shutil.rmtree(raw_dir, ignore_errors=True)


def main() -> None:
    p = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter
    )
    p.add_argument("--keyword", default="mission_control", help="spec slug in wake_corpus/")
    p.add_argument("--profile", default="smoke", choices=["smoke", "coarse", "full"])
    p.add_argument(
        "--engine", default="auto", choices=["auto", "azure-tts", "sapi", "espeak", "piper"]
    )
    p.add_argument("--out", type=Path, help="default ./wake-corpus/<slug>")
    p.add_argument("--piper-model", type=Path, help="multi-speaker piper .onnx voice model")
    p.add_argument("--voices", type=int, help="override the profile voice count")
    p.add_argument("--negative-voices", type=int, help="voices for negatives (default ~half)")
    p.add_argument("--positives-limit", type=int, help="cap positive phrases (0 = all)")
    p.add_argument("--negatives-limit", type=int, help="cap negative phrases (0 = all)")
    p.add_argument(
        "--rates-pct",
        type=lambda s: [float(x) for x in s.split(",")],
        help="override speaking-rate percentages, e.g. -15,0,15",
    )
    p.add_argument("--noise-dir", type=Path, help="background noise WAVs for SNR mixing")
    p.add_argument("--rir-dir", type=Path, help="room impulse response WAVs")
    p.add_argument("--clean-only", action="store_true", help="skip SNR augmentation")
    p.add_argument("--max-chars", type=int, help="abort azure-tts if the run exceeds this")
    p.add_argument("--yes", action="store_true", help="skip the azure-tts cost confirmation")
    p.add_argument("--keep-raw", action="store_true", help="keep the pre-augmentation _raw/ dir")
    p.add_argument("--seed", type=int, help="override the spec seed")
    build(p.parse_args())


if __name__ == "__main__":
    main()
