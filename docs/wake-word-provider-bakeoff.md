# Wake-word provider bake-off

Two ways to spot "Mission Control", swappable at runtime — the activation-side
analogue of the voice-provider bake-off (`docs/voice-provider-bakeoff-plan.md`).
The choice is orthogonal to which conversational provider then handles the turn.

| | `openwakeword` (default) | `azure` |
| --- | --- | --- |
| Where it runs | Kiosk browser | Backend (`app/voice/wake_azure.py`) |
| Model | `frontend/public/models/wake/mission_control.onnx` (+ shared feature models) | `frontend/public/models/wake/azure_mission_control_basic_med.table` (Azure Speech Studio custom keyword, basic, medium) |
| Runtime | `onnxruntime-web`, lazy-loaded | native Speech SDK — `pip install -e 'backend[azure-wake]'` |
| Audio path when idle | never leaves the browser | streamed to the backend over `WS /api/voice/wake/azure` (localhost / LAN) — spotting itself is still on-device, no Azure key, no network |
| Degrades to push-to-talk when | ONNX assets or `onnxruntime-web` missing | SDK not installed, `.table` missing, or the socket is refused |

## Why the split

The JavaScript Speech SDK cannot load a `.table` — `KeywordRecognitionModel.fromFile`
/ `fromStream` are unimplemented stubs and there is no `KeywordRecognizer` in the
JS package. Only the native SDK (`azure-cognitiveservices-speech`,
`KeywordRecognizer` + `KeywordRecognitionModel`) does offline `.table` spotting.
So `azure` runs on the backend and the kiosk streams it mic audio, reusing the
relay shape of the Azure voice contestants.

## Selection

- Default: `MISSION_CONTROL_WAKE_WORD_PROVIDER` (`openwakeword` | `azure`).
- Runtime: Settings → "Keyword provider", or `PUT /api/voice/wake-config`
  `{"provider": "azure"}` — a process-memory override (reverts on restart),
  resolved by `app/voice/wake.py::effective_wake_provider` exactly like the voice
  provider override. `GET /api/voice/wake-config` returns the active provider and
  the selectable list (`configured: false` for `azure` until the SDK + `.table`
  are in place).

## Wire protocol — `WS /api/voice/wake/azure`

LAN-gated (`_is_local_client`); closes `4404` unless wake + voice are on and the
`azure` provider is actually available. JSON text frames:

- kiosk → backend: `{"type":"audio","pcm":"<base64 PCM16 16 kHz mono>"}`,
  `{"type":"suspend"}` (a turn is running — stop feeding the recogniser),
  `{"type":"resume"}`.
- backend → kiosk: `{"type":"wake","score":1.0}` on a detection,
  `{"type":"error","message":...}`, `{"type":"closing"}`.

The frontend still owns the post-fire cooldown and the pre-roll buffer
(`WakePreroll`), identical to `openwakeword`, so `useWakeWord` / `useVoiceSession`
drive both detectors the same way.

## Evaluating

Both surface the same diagnostics in Settings (state, last score, last
wake→listening latency). Compare on: false accepts per hour of ambient household
noise, miss rate at a normal speaking distance/volume, and wake→listening
latency. `azure` adds a network hop (localhost) and the SDK's own buffering;
`openwakeword` adds ONNX inference on the UI thread. Neither sends audio off the
machine while idle.

## Measured comparison (2026-09-07)

`python -m scripts.benchmark_wake` runs both back ends over the same real audio
already on disk and reports recall (positives detected), hard-negative false
accepts, and — for openWakeWord — score separation. Benchmark-only deps
(`pip install openwakeword`, plus the `azure-wake` extra); openWakeWord is the
**reference Python implementation** here, which the browser port aims to match.

Corpus: **10 positives** (`backend/voice-captures/` — real kiosk wake
activations, "Mission Control …", 24 kHz resampled to 16 kHz) and **35 hard
negatives** (`backend/voice-samples/` — real spoken commands with *no* wake
phrase: "show me tomorrow", "set a timer for 10 minutes", …). Both dirs are
git-ignored, provisioned per install.

| | openWakeWord (`mission_control.onnx`) | Azure (`…basic_med.table`) |
| --- | --- | --- |
| Recall | **9/10** (thresholds 0.3 and 0.5 identical) | **9/10** |
| Hard-negative false accepts | **0/35** | **0/35** |
| Peak-score margin | positives **0.983** vs negatives **0.001** | n/a (`.table` has no score) |
| Fire position | ~1.2 s into the clip — this is openWakeWord's minimum warm-up (mel + 16-embedding context), *not* post-phrase lag; it fires as soon as it mathematically can | offset not exposed offline |

**Both detectors miss the same one clip** (`…153620-502…`): session STT heard
"you should control positive", and the WAV is full-scale clipped — an atypical,
low-quality utterance, not a detector weakness. On everything else both are
perfect with a wide margin.

**Finding: indistinguishable on the real audio available.** openWakeWord's
near-binary score separation says its 0.3 default threshold has plenty of head
room here. Note this real in-domain recall (90 %) is well above the synthetic
held-out figure in `wake-word-model-training-notes.md` (recall ~0.62) — expected,
since these positives are deliberate, close-mic, single-speaker.

### What this does **not** establish

- **n = 10 positives** — a 95 % CI on 9/10 spans roughly 55–100 %; this cannot
  separate a detector that is truly 85 % from one that is 95 %.
- **No false-accepts-per-hour.** 35 command phrases (~90 s) is a hard-negative
  set, not hours of ambient household noise. Both scoring 0 is reassuring, not a
  rate. A real FA/hr number needs the negative corpus in the openWakeWord
  training env (WSL) run through *both* detectors — Azure needs the raw audio,
  not the cached feature vectors.
- Single speaker, single room, single mic. Distance / accent / background-TV
  robustness is untested.
- openWakeWord measured via the reference library; the shipping browser port
  (`openWakeWord.ts`, feature maths still unvalidated on-device) could differ.
- Azure tested at "basic / medium" only — other model tiers / sensitivities exist.

Strengthening this is mostly a matter of recording more positives (varied
speaker/distance/noise) into `backend/voice-captures/` and re-running.
