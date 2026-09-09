---
status: historical
summary: openWakeWord vs Azure .table, the Invoke gate, and the recall-eval harness.
---

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

## The on-device Invoke gate (additive — not a provider)

Independent of which of the two providers is selected, the **Invoke gate** can be
layered *in front* of it. It is the recipient side of the on-device gate
prototype in the ReInvoke2026 repo (`wakeword/`): the `invoke-gate` daemon on the
Harman Kardon Invoke runs a deliberately loose first stage (`--kws shape`) and
only streams real room audio after a candidate. The selected provider
(openWakeWord **or** Azure) then re-checks that gated audio, and an activation
happens **only when the gate window *and* the selected detector both accept**
(resolution 3 in `wakeword/FIRST_STAGE_WAKEWORD_INVESTIGATION.md` — the gate is
loose by design). A gate candidate the detector does not confirm before the gate
closes is a gate false accept and produces nothing.

- **Off by default** — `MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_ENABLED`, Settings →
  "On-device audio gate", or `PUT /api/voice/wake-config {"invoke_gate_enabled": true}`
  (a process-memory override, resolved by `effective_invoke_gate_enabled`).
- Needs `MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST` (the Invoke's LAN IP); until
  that is set the toggle is hidden (`invoke_gate_configured: false`).
- On ⇒ the kiosk opens `WS /api/voice/wake/invoke` (the backend bridges it to the
  daemon's control socket), tells the daemon to gate its egress
  (`gate_enabled:true`), and `GatedWakeDetector` wraps the selected detector.
  Idle room audio never leaves the Invoke.
- Off ⇒ the selected detector runs on the continuous mic feed exactly as before.
- Degrades to push-to-talk when the host is unset or the control socket is refused.
- Run the device side with `wakeword/harness/invoke_gate.sh up|down|status`. See
  `wakeword/MC_INTEGRATION.md` and `wakeword/RUN_END_TO_END.md`.

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
- The Invoke gate (above) is a **separate** toggle, `invoke_gate_enabled`, that
  applies on top of whichever provider is selected.

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

## Wire protocol — `WS /api/voice/wake/invoke`

Same LAN gate. The backend bridge (`app/voice/wake_invoke.py`) opens a TCP
connection to the daemon's control socket and relays it verbatim:

- device → kiosk: `hello` / `wake` / `state` / `preroll` / `vad` / `closing` /
  `heartbeat` / `error` frames (see `wakeword/PROTOCOL.md`), forwarded as text.
- kiosk → device: `{"cmd": ...}` — allow-list `ptt_start` / `ptt_stop` / `hold` /
  `done` / `set` / `gate_enabled` / `keepalive`.

The daemon's **audio** socket (`:5004`) is not touched by the backend — that PCM
reaches the kiosk over VB-CABLE and the kiosk reads it from the microphone as
today (`useAudioInput` `auto` already prefers a VB-CABLE input).
`GatedWakeDetector` (`frontend/src/voice/wake/gatedDetector.ts`) wraps the
selected base detector (openWakeWord / Azure): `state:open` / `preroll` →
`base.resume({resetCooldown:false})`; base `onWake` while verifying → forward;
`state:off` before that → drop. `endActivation()` sends `{cmd:"done"}` at turn
end; the Ask button sends `ptt_start` / `ptt_stop`; a `hold` lease keeps the gate
open through the reply for barge-in.

## Evaluating

Both surface the same diagnostics in Settings (state, last score, last
wake→listening latency). Compare on: false accepts per hour of ambient household
noise, miss rate at a normal speaking distance/volume, and wake→listening
latency. `azure` adds a network hop (localhost) and the SDK's own buffering;
`openwakeword` adds ONNX inference on the UI thread. Neither sends audio off the
machine while idle.

## Measured comparison (2026-09-07)

`python -m scripts.benchmark_wake` runs each back end over the same real audio
already on disk and reports recall (positives detected), hard-negative false
accepts, and — for openWakeWord — score separation. Benchmark-only deps
(`pip install openwakeword`, plus the `azure-wake` extra); openWakeWord is the
**reference Python implementation** here, which the browser port aims to match.
The `invoke_gate` column runs the selected detector's re-check (openWakeWord
here) over each clip trimmed to `[speech_onset − --gate-preroll-ms, end]` with
the model reset at that OFF→OPEN edge — an approximation of the gate handoff (no
device, no `mock_invoke_gate` in the loop), so read it as "does the detector
still fire on the gated window?", not a device number.

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
