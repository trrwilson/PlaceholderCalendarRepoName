---
status: reference
summary: Evidence behind the local STT engine choice and how to re-benchmark it.
---

# Local STT technology evaluation

The evidence behind the initial local speech-to-text choice for the
Local / Hybrid voice pipeline (`docs/local-voice-plan.md`). A pragmatic
comparison, not an exhaustive survey — the deciding data is measured on real
hardware with `backend/scripts/benchmark_local_stt.py`, not published throughput
numbers (`AGENTS.md` → "Hardware assumptions": *interactive latency matters
substantially more than throughput on long recordings*).

## Decision

**faster-whisper (CTranslate2), `base.en`, CPU `int8`, single greedy decode on
end-of-speech.** It is the shipped default (`MISSION_CONTROL_LOCAL_STT_*`).

- Meets the interactive target on CPU-only x86 with no GPU: **~280 ms from
  end-of-speech to a stable final transcript** on this dev box's CPU, ~230 MB
  RAM, English WER indistinguishable from `small.en` on short commands.
- Trivial to install (`pip install faster-whisper`), Windows + Linux wheels,
  models auto-download and cache, no model files in the repo.
- The engine is behind the `SpeechRecognizer` seam, so this is a *default*, not a
  lock-in. `sherpa_onnx` (true streaming) is implemented as the second engine and
  is the likely upgrade once validated on the target CPU.

## Candidates

| Engine | Windows | Linux | x86 CPU | GTX 1080 / CUDA | Streaming / incremental | Endpointing | Python | Maintenance | Deploy complexity |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| **faster-whisper / CTranslate2** | ✅ wheel | ✅ wheel | ✅ excellent int8 | ✅ float16 (needs CUDA 12 + cuDNN 9 runtime) | ⚠️ buffered; re-decode for partials | ⚠️ Silero VAD, or caller-driven | ✅ first-class | ✅ very active | ✅ `pip install`, model auto-downloads |
| **sherpa-onnx (streaming zipformer transducer)** | ✅ wheel | ✅ wheel | ✅ good, designed for it | ✅ CUDA EP; CPU is the design point | ✅ genuine, stable partials | ✅ built-in (`rule1/2/3`) | ✅ good | ✅ active (k2-fsa) | ⚠️ `pip install` + provide a model directory (encoder/decoder/joiner/tokens) |
| **whisper.cpp** | ✅ (build or `pywhispercpp`) | ✅ | ✅ good; GGML quant | ⚠️ CUDA build, or Vulkan | ⚠️ buffered; `--step` streaming exists but coarse | ⚠️ energy VAD | ⚠️ via bindings, less idiomatic | ✅ active | ⚠️ compile or a less-maintained wheel; separate model download |
| Vosk (Kaldi) | ✅ | ✅ | ✅ | ❌ CPU-only | ✅ streaming | ✅ | ✅ | ⚠️ slower cadence | ✅ pip + model zip |
| Web Speech API | — | — | — | — | ✅ | ✅ | — | — | ❌ **ruled out** — Chrome sends audio to Google, breaks local-by-default (already ruled out for wake word in `AGENTS.md`) |

### Why not the others, briefly

- **whisper.cpp** — no clear advantage over faster-whisper for this environment:
  similar accuracy, similar buffered latency, *worse* Python integration and a
  heavier install story (compile, or a thinly-maintained wheel). Would revisit
  only if CTranslate2 wheels stopped covering a target platform.
- **Vosk** — solid and truly streaming, but the acoustic models are noticeably
  behind Whisper/zipformer on accuracy for natural phrasing, and it has no GPU
  path if we ever want one. Kept as a mental fallback, not implemented.
- **Web Speech API** — disqualified on privacy, same as for wake word.

## Measured results (this host, `benchmark_local_stt.py stt --synthesize`)

Host: the project dev box, **CPU path forced** (`device=cpu`, `int8`) so the
numbers represent a GPU-less kiosk. 35-utterance corpus
(`backend/tests/data/voice_commands.jsonl`) rendered to 16 kHz mono WAV with
Windows SAPI, streamed in 100 ms chunks.

| faster-whisper model | model load | **final after end-of-speech** (median / p90) | total speech→result (median) | realtime factor | WER (mean) | RSS |
| --- | --- | --- | --- | --- | --- | --- |
| `tiny.en` | ~2.5 s¹ | **158 ms** / 165 ms | 158 ms | 0.10 | 0.058 | 209 MB |
| `base.en` | ~0.8 s | **280 ms** / 288 ms | 281 ms | 0.10 | 0.052 | 231 MB |
| `small.en` | ~1.2 s | **874 ms** / 901 ms | 874 ms | 0.40 | 0.048 | 411 MB |

¹ `tiny.en` load time is first-run/cache noise; warm it is sub-second.

Notes:

- **No mid-utterance partials** with the buffered single-decode strategy
  (`first_partial_ms` is null). Acceptable for 1–3 s commands where the whole
  decode is ~160–280 ms anyway; the streaming `sherpa_onnx` engine is the path to
  real partials if perceived latency needs them.
- **WER is ~0.05 across all three and dominated by SAPI artefacts** — the
  synthetic voice says "ten" / "twenty" / "three PM" and Whisper writes
  "10" / "20" / "3 PM", plus one "cost co" → "cost co-list". The *semantic* layer
  normalises digits and fuzzy-matches "cost co" → "Costco", so end-to-end intent
  accuracy on this corpus is **35/35** (`benchmark_local_stt.py intent`). Real
  speech should do better on the raw transcript, not worse.
- `small.en` buys **no measurable accuracy** on bounded commands for **3×** the
  latency and **~2×** the RAM. `base.en` is the sweet spot; `tiny.en` is the
  choice if a slower kiosk CPU pushes `base.en` past ~1 s and its accuracy holds.
- CPU utilisation spikes to multiple cores during the ~200 ms decode then idles —
  fine for an appliance that recognises a command every few minutes, not a
  transcription server.

### GTX 1080 / CUDA

Not measured here (this box's CUDA 12 libraries aren't on `PATH`, and the whole
point is that CPU is enough). faster-whisper `float16` on a 1080-class card would
cut the decode further and is available via
`MISSION_CONTROL_LOCAL_STT_DEVICE=cuda` — but it needs the CUDA 12 + cuDNN 9
runtime installed, and `auto` deliberately stays on CPU so a card with no runtime
never breaks the pipeline. **A discrete GPU must not be a requirement**
(`AGENTS.md`), and the CPU numbers above confirm it isn't.

Re-run on the actual kiosk host before committing: `cd backend && python -m
scripts.benchmark_local_stt stt --synthesize --engines faster_whisper --json
stt.json`, or record real commands into `backend/voice-samples/` (git-ignored)
first.

## Model provenance / licensing

Recorded per `AGENTS.md` → "ML / audio / vision model artifacts" and
`docs/credits.md`:

| Artifact | Runtime licence | Weights licence | Source | Notes |
| --- | --- | --- | --- | --- |
| faster-whisper (CTranslate2) | MIT | — | github.com/SYSTRAN/faster-whisper | library only |
| `Systran/faster-whisper-{tiny,base,small}.en` | — | **MIT** (OpenAI Whisper) | huggingface.co/Systran | CT2 repackage of OpenAI Whisper; downloaded per install, never committed |
| sherpa-onnx | Apache-2.0 | — | github.com/k2-fsa/sherpa-onnx | library only; not yet used by default |
| a `sherpa-onnx-streaming-zipformer-en-*` model | — | **Apache-2.0** (k2-fsa releases; confirm per model) | github.com/k2-fsa/sherpa-onnx/releases | provision per install; check the specific release's LICENSE before adopting |

Model binaries are provisioned per install, never committed to the repo.
