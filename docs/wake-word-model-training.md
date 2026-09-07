# The "Mission Control" wake-word model — training, licensing, provenance

This is the companion to [`docs/wake-word-plan.md`](wake-word-plan.md). The plan's
application integration (state machine, shared microphone, pre-roll handoff,
settings, diagnostics, tests) is implemented and on `master`. **The trained model
asset is the one remaining piece** and is produced by the process below rather
than committed to the repo.

> **Status (2026-09-06):** engine selected and integrated. `mission_control.onnx`
> **has now been trained** locally (Option 2 below, on a WSL2 + RTX 4090 box — see
> [`wake-word-model-training-notes.md`](wake-word-model-training-notes.md) for the
> environment, version pins, and the hyperparameter sweep) and copied into
> `frontend/public/models/wake/` (still not committed — the dir is gitignored).
> Current model: auto-trainer validation **accuracy 0.81, recall 0.62,
> false-positives ~1/hr** on an 11 h adversarial set (`layer_size 128`,
> `max_negative_weight 64`, 100k synthetic positives). Still below openWakeWord's
> published models; the notes doc has the recall/fp frontier and next steps.
> Nothing measured on the real kiosk microphone yet — expect to tune
> `MISSION_CONTROL_WAKE_WORD_THRESHOLD` there.

---

## Engine decision: openWakeWord (local ONNX), browser-resident

Evaluated against the plan's stated priorities — own the phrase, clear licensing
for **both** runtime and model, local-by-default, modest continuous CPU, good
Windows support, tunable threshold.

| | **openWakeWord** (chosen) | Picovoice Porcupine | Web Speech API |
| --- | --- | --- | --- |
| Runtime licence | Apache-2.0 | Apache-2.0 SDK **+ required AccessKey** | Browser built-in |
| Custom model | Trained from synthetic TTS; **the output is yours**, no service terms | Generated in Picovoice Console; governed by their terms, free tier is personal/eval | n/a — cannot add a phrase |
| Local by default | **Yes** — all inference in-browser | AccessKey validation contacts Picovoice at startup | **No** — Chrome streams mic audio to Google servers |
| Browser story | Community (ONNX Runtime Web); we own the glue in `frontend/src/voice/wake/` | Official WASM Web SDK | n/a |
| Custom-phrase accuracy | Good; generally a little below Porcupine | Best-in-class | n/a |

**Web Speech API is ruled out explicitly** — routing room audio to Google to spot
a wake word violates the plan's "idle audio stays local" requirement.

**Porcupine stays the documented fallback:** if on-hardware testing shows
openWakeWord's accuracy for "Mission Control" is unacceptable, switching is a
contained change — implement a second `WakeDetector` in
`frontend/src/voice/wake/` and select it by config. That switch **must** come
with its own recorded licensing decision (AccessKey handling, tier).

"Mission Control" is a favourable phrase for keyword spotting: two long,
multi-syllable words, uncommon as a everyday utterance, low expected
false-trigger rate.

### Microphone ownership: Option B (browser owns the mic)

Per the plan's "Critical Architecture Decision" and the feasibility assessment:
there is no local host process today (kiosk is a Chrome tab → Vite + FastAPI, the
backend is possibly-remote). Introducing a host audio service is a large lift
against the repo's direction. The browser already owns the mic, holds the Gemini
session and runs the state machine, so wake detection lives there too:

- `frontend/src/voice/audio.ts` now has a single reference-counted `MicSource`
  (one `getUserMedia`, one `AudioContext`, one capture worklet, many listeners).
  Push-to-talk and the wake detector are both just listeners — no second mic
  stack, which is exactly the unreliability the plan warns about.
- If the camera plan (`docs/camera-support-plan.md`) later adds a local host
  agent, revisit: a shared host agent would make Option A/C reasonable for both
  features. Not before.

### Wake-to-command audio handoff

The detector keeps a rolling 16 kHz PCM ring buffer
(`frontend/src/voice/wake/ringBuffer.ts`). On detection it switches to retaining
everything from that moment; `useVoiceSession` opens the turn exactly as the Ask
button does and, once the Live session connects, flushes the retained chunks via
`sendAudio()` **before** the live mic takes over, so "Mission Control, what's
tomorrow?" does not lose its start. Current defaults, all tunable on hardware:
retain from the detection point forward (the phrase itself is mostly excluded
because openWakeWord fires at the end of the phrase), 4 s cap. Whether to trim
more or keep a little pre-trigger lead is a hardware question.

---

## Producing the model

openWakeWord custom models are trained on **synthetic speech** — you never record
or upload real voices. Output: a small `mission_control.onnx` (a few hundred KB).

### Option 1 — openWakeWord automatic training notebook (recommended)

1. Open the official notebook:
   `https://github.com/dscripka/openWakeWord` →
   `notebooks/automatic_model_training.ipynb` (also linked from the project
   README as a Colab). It is Apache-2.0.
2. Set the target phrase to `mission control` and run all cells. The notebook:
   - generates ~thousands of positive clips with Piper TTS across many synthetic
     voices,
   - mixes in negatives + room impulse responses + background noise
     (it pulls these public sets itself),
   - trains the classifier head and exports ONNX + tflite.
3. Download `mission_control.onnx`.
4. Also download the two shared feature models from the repo
   (`openwakeword/resources/models/melspectrogram.onnx`,
   `embedding_model.onnx`).

### Option 2 — local training

Needs Python 3.10+, ~10 GB disk, and ideally a CUDA GPU (CPU works, slower).

```bash
pip install openwakeword piper-phonemize piper-tts

# 1. Fetch the base feature models + augmentation data
python -c "import openwakeword; openwakeword.utils.download_models()"

# 2. Generate synthetic positives/negatives and train.
#    See openWakeWord's docs/training_models.md — the high-level call is:
python -m openwakeword.train \
    --target_phrase "mission control" \
    --model_name mission_control \
    --output_dir ./wake_out \
    --n_samples 30000 \
    --augmentation_rounds 2
```

The augmentation corpora (RIRs, AudioSet-derived noise, the openWakeWord
"features" negative set — the last is ~2 GB) are what made this impractical in
the unattended run; they download once and cache.

### Install into the kiosk

```bash
cd frontend
npm i onnxruntime-web            # adds the runtime (MIT); it is lazy-loaded
# copy the wasm the runtime needs next to the models (CSP: no CDN)
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.wasm public/models/wake/
cp node_modules/onnxruntime-web/dist/ort-wasm-simd-threaded.mjs  public/models/wake/
# place the three models
cp <download>/melspectrogram.onnx  public/models/wake/
cp <download>/embedding_model.onnx public/models/wake/
cp <download>/mission_control.onnx public/models/wake/
```

Then set on the backend:

```
MISSION_CONTROL_VOICE_ENABLED=true
MISSION_CONTROL_WAKE_WORD_ENABLED=true
```

`GET /api/voice/wake-config` will now report `enabled: true`; the kiosk arms on
next load. Tune `MISSION_CONTROL_WAKE_WORD_THRESHOLD` (0.5 default) and
`_COOLDOWN_MS` from the Settings diagnostics + the `[wake]` console scores.

> The ONNX feature maths in `frontend/src/voice/wake/openWakeWord.ts` is written
> to openWakeWord's documented tensor shapes but has **not** been run against the
> real models. Expect to adjust the mel lookback / windowing constants (`OWW` in
> that file) during first bring-up; they are all in one place for that reason.

---

## Licensing & provenance record

Fill in the bracketed fields when the model is actually produced, and mirror the
one-liner into [`docs/credits.md`](credits.md).

| Concern | Detail |
| --- | --- |
| Runtime library | `onnxruntime-web` — MIT. Lazy-loaded; wasm served locally from `frontend/public/models/wake/`. |
| Feature models | `melspectrogram.onnx`, `embedding_model.onnx` from openWakeWord (`openwakeword/resources/models/`). openWakeWord is Apache-2.0; the embedding weights originate from Google's `speech_embedding` (TF Hub), Apache-2.0. |
| Trained phrase model | `mission_control.onnx`. Trained **2026-09-06** with **openWakeWord 0.6.0**, **local** (`openwakeword/train.py`, not the Colab notebook), entirely from synthetic Piper TTS + public augmentation sets. **No human voice recordings were used or uploaded.** openWakeWord imposes no licence on models you train — the artifact is the household's. |
| Redistribution | The feature models: Apache-2.0 (keep the notice). The trained model: unrestricted, but it is kiosk-specific and not committed. |
| Training inputs | Piper **LibriTTS-R medium** generator model (`en_US-libritts_r-medium.pt`, piper-sample-generator v2.0.0 release, MIT); ~904 synthetic LibriTTS speakers. MIT environmental impulse responses (`davidscripka/MIT_environmental_impulse_responses`, HF). Background noise: 2 shards of AudioSet balanced-train (`agkphysics/AudioSet`, CC-BY-4.0 clip-wise). Negative features: `davidscripka/openwakeword_features` ACAV100M-derived 2000 h set + 11 h validation set (precomputed embeddings, not audio). All pulled by scripted download; each set carries its own permissive licence. |

**Durable rule (now in `AGENTS.md`):** any ML/audio/vision model artifact gets
its licence and provenance reviewed independently of the software that runs it —
an Apache-2.0 runtime does not make the weights Apache-2.0.
