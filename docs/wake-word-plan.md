---
status: historical
summary: The wake-word activation build.
---

# Mission Control: Local Wake-Word Activation

Design, implement, and integrate local wake-word activation for Mission Control.

The wake phrase is:

> "Mission Control"

Mission Control already has a functional tap/push-to-talk voice path using the browser microphone and Gemini Live. Wake-word activation should build on that existing voice architecture rather than replace or duplicate it unnecessarily.

> **Status (2026-09-06): application integration implemented; trained model not yet
> produced.** The browser-resident architecture is on `master` — a `WakeDetector`
> seam (`frontend/src/voice/wake/`), a shared reference-counted `MicSource`, an
> `armed` voice state, the pre-roll ring-buffer handoff, backend config
> (`MISSION_CONTROL_WAKE_WORD_*`) + `GET /api/voice/wake-config`, a Settings
> control with diagnostics, and the plan's deterministic state-machine tests
> (`frontend/src/voice/wake/wakeSession.test.ts`). The feature is **off by default**
> and degrades to push-to-talk with no error when the model/runtime is absent.
> **Outstanding:** train the "Mission Control" openWakeWord model, `npm i
> onnxruntime-web`, drop the assets in, and validate on kiosk hardware (latency,
> CPU, false-positive/negative tuning). Full engine rationale, the
> microphone-ownership decision, the training procedure and the licensing/
> provenance record are in
> [`docs/wake-word-model-training.md`](wake-word-model-training.md).
>
> The [Feasibility assessment & pre-work context](#feasibility-assessment--pre-work-context)
> at the end of this document informed the implementation and is kept for reference.
>
> **Arbitrary/implementation decisions made autonomously (for review):**
> - Engine: **openWakeWord** over Porcupine (own the phrase, no AccessKey
>   phone-home, local-by-default) — Porcupine documented as the fallback if
>   accuracy disappoints, contingent on a recorded licensing decision.
> - Microphone: **Option B** (browser owns the mic via one shared `MicSource`);
>   no host audio service introduced.
> - `onnxruntime-web` is **not** added to `package.json` yet — it is lazy-loaded
>   via an external dynamic import, so the kiosk bundle is unchanged until an
>   install opts in. The ONNX feature maths is written to openWakeWord's
>   documented tensor shapes but is **unvalidated against the real models**.
> - Wake activation reuses the existing `connecting` overlay as the immediate
>   acknowledgement (appears with no network wait); no separate "● Listening"
>   pre-connect state was added.
> - Re-arm after every turn; detector suspended during
>   `connecting/listening/thinking/speaking` (covers self-triggering + the
>   assistant's own audio); abandoned activations fall through the existing
>   response watchdog + client-side silence detection.
> - Pre-roll: retain from the detection instant forward, 4 s cap, flushed to the
>   session before the live mic. Phrase-trimming left as a hardware-tuning knob.
>
> **Follow-up (2026-09-09):** the staged- vs one-shot-activation experience — leading
> silence after the keyword, cue timing, keeping the phrase out of the transcript, and
> dismissing empty turns — is specced in
> [`voice-activation-ux-plan.md`](voice-activation-ux-plan.md). It supersedes the open
> questions in *Wake-to-Command Audio Handoff* and *End-of-Utterance Handling* below.

The primary deployment host is likely Windows, but Linux remains possible. Do not assume a specific wake-word engine, microphone architecture, or OS integration before inspecting the repository and corroborating current options.

---

## Product Goal

Allow a person near the wall-mounted Mission Control display to say:

> "Mission Control"

and naturally begin a voice interaction without touching the screen.

Desired experience:

1. Mission Control waits locally for the wake phrase.
2. Saying "Mission Control" activates promptly.
3. The UI immediately and visibly acknowledges activation.
4. Speech following the wake phrase becomes the existing Mission Control voice turn.
5. Gemini handles the utterance through the existing voice/tool architecture.
6. Mission Control presents the result visually and, when appropriate, through existing assistant audio.
7. After the interaction completes or times out, Mission Control returns to local wake-word listening.

The normal idle wake-word path should not continuously stream room audio to Gemini or another cloud service.

Preserve push-to-talk as a fully supported fallback and diagnostic path.

---

# Core Principles

## 1. Wake-word detection is local activation, not conversational AI

Keep these responsibilities conceptually distinct:

Local audio
    ↓
Wake-word detector
    ↓ "Mission Control"
Voice-session activation
    ↓
Existing Gemini voice session
    ↓
Mission Control tools / UI / calendar / Home Assistant

The wake-word system answers only:

> "Should Mission Control begin listening to this person now?"

Gemini answers:

> "What did the person ask, and what should Mission Control do?"

Do not send continuous ambient audio to Gemini merely to recognize the wake phrase.

## 2. Preserve the existing voice architecture

Inspect the existing:
- microphone capture
- Gemini Live session
- audio playback
- voice state machine
- tool dispatch
- transcript UI
- push-to-talk controls

Reuse these paths where practical.

Do not create a parallel implementation of:
- Gemini sessions
- tool calling
- transcription
- assistant audio
- dashboard actions

Wake-word activation should enter the same logical interaction flow as manual activation.

## 3. Push-to-talk remains first-class

The existing Ask / microphone control must continue to work independently of wake-word detection.

This provides:
- accessibility
- fallback when wake detection fails
- debugging
- recovery when microphone conditions are poor
- a deterministic way to distinguish wake-word problems from Gemini problems

---

# Investigation Before Implementation

Inspect the repository and current runtime environment first.

Research and corroborate appropriate current wake-word implementations for:
- Windows
- local CPU inference
- custom phrase "Mission Control"
- continuously running operation
- Python and/or browser integration
- microphone compatibility
- resource consumption
- false-positive tuning
- custom-model training
- licensing

Possible candidates include:
- openWakeWord
- Picovoice Porcupine
- other actively maintained local keyword-spotting implementations

These are candidates, not mandated choices.

Prefer:
- local inference
- mature maintained implementation
- modest continuous CPU use
- good Windows support
- customizable detection threshold
- ability to own/control the "Mission Control" wake phrase
- clear licensing for runtime AND trained model assets

Document why the selected approach was chosen.

---

# Critical Architecture Decision: Microphone Ownership

Explicitly investigate how wake-word detection should coexist with the existing browser microphone capture.

Do not assume two independent processes can continuously own or capture the microphone reliably.

Evaluate alternatives such as:

### Option A: Local host audio service owns the microphone

Microphone
    ↓
Local wake-word / audio service
    ├── wake detection
    └── activated audio → Mission Control voice path

### Option B: Browser owns the microphone

Browser audio capture
    ├── local wake detector
    └── activated stream → Gemini

### Option C: Shared/local audio pipeline

A local service owns acquisition and exposes audio/state to whichever Mission Control component needs it.

Select the simplest reliable architecture after verifying behavior on the expected host.

Avoid duplicating microphone capture stacks merely because implementation is convenient.

---

# Wake-to-Command Audio Handoff

> **Resolved (MVP): `docs/voice-activation-ux-mvp.md`.** A 4 s rolling
> `AudioRingBuffer` per detector; on activation `useVoiceSession` flushes from
> `firedAt − WAKE_PREROLL_LEAD_MS` (1.2 s, still includes the keyword audio) up
> to now, then hands to the live mic. The keyword is kept out of the *answer*
> downstream — a phrase-strip regex on the transcript plus a `prompt.py` belt
> line — not by trimming the audio (openWakeWord's fire position varies; trimming
> harder risks clipping the first command word — deferred until kiosk hardware).
> Ambient pre-wake audio is bounded by the ring cap and the 3.5 s content-gate
> timeout.

Treat this as an explicit engineering problem.

Natural speech may be:

> "Mission Control ... what's happening tomorrow?"

or:

> "Mission Control, what's happening tomorrow?"

The beginning of the command must not be lost while the wake detector is triggering and the Gemini session is being established.

Investigate a small rolling local audio buffer or equivalent mechanism so recently captured audio can be retained around activation.

Determine experimentally whether:
- wake phrase should be omitted from Gemini input
- audio immediately following the phrase should be forwarded
- some pre-trigger audio should be retained
- Gemini session startup latency requires local buffering

Do not blindly forward long periods of ambient pre-wake audio.

---

# Interaction State Model

Integrate wake-word activation coherently with the existing voice state machine.

Conceptually support:

IDLE / ARMED
    ↓ "Mission Control"
ACTIVATED
    ↓
LISTENING
    ↓ end of utterance
THINKING
    ↓
RESPONDING
    ↓
IDLE / ARMED

The exact implementation should follow the existing voice state architecture.

The screen should give immediate acknowledgement of successful wake detection. Do not wait for Gemini connection or transcription before visually acknowledging the user.

Example:

> ● Listening

During processing:

> Checking tomorrow...

During response, the display remains the primary output medium where useful.

---

# End-of-Utterance Handling

> **Resolved (MVP): `docs/voice-activation-ux-mvp.md`.** A wake turn is not
> end-of-speech-eligible until *content* speech past the keyword is seen (live-mic
> RMS, or a non-wake-phrase transcript token) — an `awaitingContent` gate in
> `useVoiceSession` that ignores provider `speech-*` until then (they fire on the
> keyword in the flushed pre-roll). After the gate opens, end-of-speech is the
> normal negotiated path (`grant.endpointing`; Azure Voice Live = `hybrid`
> semantic VAD + mic-RMS backstop). No content within 3.5 s, or `MAX_LISTEN_MS`,
> → silent abandon and the detector re-arms; an empty / keyword-only turn is torn
> down before `activity-end` so nothing is spoken. Manual Stop is retained.

Wake-word activation eventually needs hands-free completion of the voice turn.

Investigate how the existing Gemini Live VAD/end-of-speech behavior can replace the manual Stop interaction after wake-word activation.

Requirements:
- normal pauses must not prematurely end a command
- the user should not need to touch Stop
- interactions should terminate predictably
- sessions must not remain open indefinitely after abandoned activations

Retain manual Stop/Cancel as a fallback while developing this.

---

# Assistant Audio and Echo Interaction

Mission Control can play assistant speech through speakers near the microphone.

Ensure assistant output does not repeatedly trigger:
- the "Mission Control" detector
- new Gemini turns
- spurious microphone capture
- feedback loops

Evaluate appropriate behavior such as:
- suspending wake detection while Mission Control is speaking
- resuming after playback completes
- echo cancellation where supported
- short post-playback suppression/debounce if necessary

Do not permanently disable interruption/barge-in capability through an overly simplistic solution.

It is acceptable for the first implementation to prohibit wake-word reactivation while Mission Control is speaking, provided the behavior is explicit and documented.

---

# Detection Reliability

Wake-word detection should be evaluated as an appliance feature, not merely demonstrated once.

Expose configurable values where appropriate:
- wake-word detection threshold
- cooldown / debounce interval
- wake-word feature enabled/disabled
- microphone selection if existing architecture supports it

Test the phrase "Mission Control" under representative conditions:
- several distances from the display
- different speaking volumes
- multiple household voices
- normal room noise
- television/music/background speech
- speech immediately following the wake phrase
- repeated activation
- assistant audio playing

Measure both:

### False negatives
Deliberate "Mission Control" utterances that fail to activate.

### False positives
Normal household audio that activates Mission Control unexpectedly.

Do not optimize one while ignoring the other.

---

# Performance

Wake-word inference may run continuously.

Measure representative:
- CPU utilization
- memory utilization
- wake detection latency
- microphone/audio processing overhead

Avoid processing unnecessarily high bandwidth audio for keyword spotting.

The component should be suitable for continuously running on a modest Windows mini-PC/thin-client class host.

---

# Failure Behavior

Wake-word failure must not make voice support unusable.

Examples:
- wake detector unavailable
- model fails to load
- microphone unavailable
- microphone disconnected
- detector crashes
- configured model missing
- local audio pipeline fails

In these cases:
- push-to-talk should remain usable whenever the underlying microphone still works
- Mission Control itself should remain operational
- UI/settings should expose useful diagnostic status
- avoid repeated noisy retries or log flooding

A wake-word failure is a degraded convenience feature, not a Mission Control fatal error.

---

# Settings and Diagnostics

Integrate wake-word configuration into the existing Settings experience rather than consuming permanent dashboard space.

Useful settings/status include:

- Wake word enabled
- Wake phrase: Mission Control
- Detector status
- Microphone status
- Selected microphone where applicable
- Detection threshold where appropriate
- Current state: Armed / Listening / Disabled / Error

Developer diagnostics may additionally expose:
- latest detector score
- detection timestamp
- activation-to-listening latency
- model/runtime information

Do not turn normal kiosk UI into a debugging console.

---

# Privacy

Before wake activation, audio processing should remain local by default.

Do not:
- stream ambient room audio continuously to Gemini
- record ambient audio
- persist arbitrary microphone captures
- upload wake-word samples during normal operation

Any model-training workflow requiring external processing should be clearly separate from runtime inference and documented.

---

# Licensing and Model Provenance

Treat runtime software and trained wake-word model licensing as separate concerns.

Before adopting a wake-word engine or downloaded/trained model:

1. Verify the runtime/library license.
2. Verify the license governing the actual "Mission Control" trained model.
3. Record where the model came from.
4. Record how it was trained or obtained.
5. Record restrictions on redistribution or commercial use.
6. Avoid assuming an open-source runtime implies that model weights have the same license.

Update:
- project-level dependency/license documentation
- relevant README/resources
- `AGENTS.md`

Add a durable project instruction that ML/audio/vision model artifacts must have licensing and provenance reviewed independently from the software libraries that execute them.

There is currently no planned commercialization, but preserve enough provenance that future use does not require reconstructing how model assets were obtained.

---

# Candidate Technology Notes

openWakeWord is one candidate worth evaluating. Its runtime is local and open source, custom models are possible, and its current Python packaging supports Windows through ONNX Runtime.

Picovoice Porcupine is another candidate worth evaluating, particularly as a comparison for custom wake-word quality and Windows support.

Do not select either solely because it is mentioned here.

Evaluate both implementation suitability and licensing/model terms before committing.

---

# Testing

Add automated tests around the application-level wake/voice state machine independent of the actual microphone/model.

At minimum test:

1. Wake detection transitions Armed → Listening.
2. Wake detection starts the existing voice-session path.
3. Push-to-talk continues working with wake-word support enabled.
4. Push-to-talk works when wake-word support is unavailable.
5. Repeated detector signals do not create concurrent voice sessions.
6. Wake signals during an active voice turn are handled safely.
7. Assistant playback cannot accidentally create another voice session.
8. Abandoned activation times out safely.
9. Wake detector errors leave Mission Control usable.
10. Disabling wake-word support stops continuous detection.
11. Restart returns to the appropriate armed/disabled state.

Keep actual model/microphone tests separate from deterministic application tests.

---

# Manual Validation

On representative hardware, validate:

1. "Mission Control" activates while standing directly at the display.
2. It activates from realistic across-room distance.
3. "Mission Control, what's happening tomorrow?" does not lose the beginning of the command.
4. "Mission Control" followed by a pause still permits the subsequent command.
5. Ordinary conversation does not frequently activate the system.
6. Television/music/background speech does not frequently activate it.
7. Mission Control's own audio output does not reactivate itself.
8. Multiple successive voice interactions work.
9. Push-to-talk continues working.
10. Recovery after detector/microphone failure is reasonable.
11. CPU/memory use is acceptable for continuous operation.

---

# Execution

Work autonomously through this task.

1. Inspect the existing voice implementation first.
2. Understand current microphone ownership and Gemini session lifecycle.
3. Research and corroborate current wake-word implementation alternatives.
4. Document the selected architecture and alternatives considered.
5. Update `.github/copilot-instructions.md` with durable wake-word, local-audio, and model-licensing principles.
6. Update project-level licensing/provenance resources.
7. Train or obtain a "Mission Control" model using a documented, appropriately licensed process.
8. Implement local wake detection.
9. Integrate detection into the existing voice-session path.
10. Preserve push-to-talk.
11. Implement safe audio handoff and interaction state transitions.
12. Add configuration/settings/diagnostics.
13. Add automated tests.
14. Run existing backend/frontend/type-check/lint/test suites.
15. Test on available microphone hardware.
16. Measure activation latency and representative continuous resource use.
17. Document Windows/Linux assumptions and limitations.

Do not:
- redesign unrelated Mission Control UI
- replace the existing Gemini/tool architecture
- implement speaker recognition
- implement facial/person recognition
- route wake-word recognition through Gemini
- continuously send ambient microphone audio to the cloud
- remove the existing push-to-talk path
- introduce a generalized audio framework unless current requirements actually demand it

Before completion, verify that saying "Mission Control" and immediately speaking a command behaves like a natural hands-free version of the existing Ask interaction rather than a separate voice system.

Report:
- selected detector/model and why
- microphone ownership architecture
- wake-to-Gemini audio handoff design
- measured wake latency
- representative CPU/memory utilization
- false-positive/false-negative observations from available testing
- licensing/model provenance
- automated validation results
- remaining limitations

---

# Feasibility assessment & pre-work context

Added 2026-09-05 after reading this plan against the shipped voice implementation
(`frontend/src/voice/*`, `backend/app/voice/*`, `App.tsx` wiring), the sibling planning
docs, and `AGENTS.md`. This section records what is already done, what is genuinely
open, and the order things must happen in, so a later implementation session does not
re-derive it.

## Verdict

Feasible, medium complexity, almost entirely frontend work. No hard blocker of the kind
`docs/eufy-sdk-integration.md` has (there the SDK does not exist yet). The plan body is
sound on product, UX states, testing, and privacy, but it leaves the two decisions that
actually gate implementation unmade, and it under-credits work already shipped for
push-to-talk. It is correctly sequenced **after** push-to-talk is stable.

## The decision that blocks everything: microphone ownership

The plan flags this ("Critical Architecture Decision") but defers it to "investigate".
Repo context narrows it more than the plan admits:

- **There is no local host process today.** Deployment is a kiosk Chrome tab pointed at
  Vite + FastAPI. The backend is explicitly designed to be possibly-remote (LAN-gated
  endpoints, `allow_remote_auth`). Nothing on the display host can reach the microphone
  outside the browser. `AGENTS.md` also lists "no Docker / no infra" and "no always-on
  mic" as standing non-goals.
- **Option A / C (local audio service)** means introducing a new deployable plus an IPC
  channel to trigger `startTurn()` in the browser. `/api/ws` + the `ApplicationMessage`
  envelope is stubbed for roughly this, but it is server→client only, has no reconnect,
  and this is a large lift that fights the repo's stated direction.
- **Option B (browser-resident detector)** fits the existing architecture with zero new
  deployment surface: the browser already owns the mic, holds the Gemini session, and
  runs the state machine. Shape: a Web Worker + `AudioWorklet` tap on one shared
  `MediaStream`.

**Coupling to the camera plan:** `docs/camera-support-plan.md` *also* needs a local host
process (display-power control, local webcam inference). If that lands first, a shared
"Mission Control host agent" becomes justified and Option A / C becomes reasonable for
both features. So the answer here depends on whether the camera host-agent happens
first.

**Recommendation:** browser-resident (Option B) unless/until a host agent already exists
for the camera plan. Candidate browser engines: Picovoice Porcupine Web (official WASM
SDK) or a community openWakeWord web port — see licensing table below.

## What is already done (plan under-credits these)

- **Hands-free end-of-turn is essentially solved.** `backend/app/voice/tokens.py`
  already configures Gemini Live automatic VAD (`start/end_of_speech_sensitivity: HIGH`,
  `prefix_padding_ms: 300`, `silence_duration_ms: 700`) precisely because push-to-talk
  users do not reliably tap Stop. The "End-of-Utterance Handling" section is mostly
  already satisfied; wake word inherits it.
- **The activation seam exists.** `useVoiceSession` exposes `startTurn()` / `stopTurn()`;
  the hook docstring and `AGENTS.md` both say a wake front end calls these.
  `surface: 'kiosk'` is already threaded through the token request.
- **Echo mitigation partly exists.** `echoCancellation: true` is set on capture;
  barge-in / flush-on-interrupt is implemented in `AudioSink`. The plan's "suspend
  detection while speaking + debounce" is a small addition on top.
- **`prewarmVoice()`** already pulls the lazy `@google/genai` chunk and the capture
  worklet into cache on mount.

## Current voice architecture — the seams to build on

| Concern | File | Note for wake word |
| --- | --- | --- |
| State machine | `frontend/src/voice/useVoiceSession.ts` | `idle→connecting→listening→thinking→speaking→idle` + `error`/`unavailable`. Add an `armed` state distinct from `idle`. `startTurn()`/`stopTurn()` are the entry points. |
| Mic capture | `frontend/src/voice/audio.ts` `MicCapture` | Creates **and fully tears down** its `AudioContext` + `getUserMedia` stream per turn. Needs refactoring to a long-lived shared mic source. |
| Capture worklet | `frontend/src/voice/pcm-capture-worklet.js` | Emits ~100 ms Float32 batches at native rate; main thread downsamples to 16 kHz PCM16. A wake worklet can mirror this. |
| Playback | `frontend/src/voice/audio.ts` `AudioSink` | 24 kHz PCM queue with flush-on-interrupt; already handles barge-in. |
| Live session | `frontend/src/voice/session.ts` `GeminiVoiceSession` | `sendAudio(base64)` takes PCM chunks — buffered pre-roll can be flushed through it. Connect = token fetch + lazy SDK import + `live.connect`, multi-second. |
| Token / VAD config | `backend/app/voice/tokens.py` | VAD, thinking-budget-0, voice, transcription all locked into the ephemeral token. |
| UI wiring | `frontend/src/App.tsx` (~L194–221, 257, 269) | `voiceActions`, the Ask button, `VoiceOverlay`, `VoiceToast`, the "Mic on" badge. |

## Real work, by area

- **Mic lifecycle refactor (enabler, do early, low risk).** Split "own the mic source"
  from "capture a turn" in `audio.ts` so a wake worklet and the existing `pcm-capture`
  worklet can both subscribe to one persistent stream/context.
- **Rolling pre-roll buffer (the sharp edge).** Audio only reaches Gemini after
  `session.connect()` completes; by wake time the user is already talking. Add a ~2–3 s
  PCM ring buffer (16 kHz mono ≈ 100 KB) in the wake worklet; on detection keep
  buffering, call `startTurn()`, then flush buffered post-wake chunks via `sendAudio()`
  before going live. Whether to strip the wake phrase and how much pre-roll to keep are
  answerable only on hardware.
- **State machine.** Add `armed`; `armed → connecting` on detection with an immediate
  `VoiceOverlay` acknowledgement (do not wait for Gemini). Re-arm after each turn;
  suppress detection during `speaking`.
- **Privacy indicator.** The "Mic on" badge currently means "a turn is live". With
  always-on capture the mic is always live — the badge's meaning and the kiosk's
  persistent mic-permission grant (voice plan open Q5, still unresolved) both need
  answers.

## Engine + model — corroborate at implementation time; licensing already tilts it

Verify current terms when starting (assessment written against ~Jan 2026 knowledge).

| | openWakeWord | Picovoice Porcupine |
| --- | --- | --- |
| Runtime license | Apache-2.0 | Apache-2.0 SDK, but an AccessKey is required |
| Custom model | Trained from synthetic TTS; **you own the output** | Generated in Picovoice Console, governed by their terms; free tier is personal/eval |
| "Local by default" | Yes | AccessKey validation phones home at startup |
| Windows / browser | Python solid; **browser support is unofficial** (community ONNX/TF.js ports) | Excellent official Windows + **official Web SDK (WASM)** |
| Custom-phrase accuracy | Good, generally below Porcupine | Best-in-class |

This plan's stated priorities (own the phrase, clear licensing for runtime *and* model,
local-by-default) point at **openWakeWord**, at the cost of possibly-worse detection and
an unofficial browser story. Suggested pre-commitment for the doc: openWakeWord unless
hardware testing shows unacceptable accuracy, then reconsider Porcupine *with a
documented licensing decision*. Rule out the Web Speech API explicitly — Chrome routes
its audio to Google servers, violating local-by-default. "Mission Control" is a
favorable phrase: two long words, low false-trigger rate.

## Corrections to the plan body

- **Step 5** says update `.github/copilot-instructions.md` with durable principles — that
  file is now only a pointer; the content belongs in `AGENTS.md`. The same durable "ML
  model artifacts get independent license/provenance review" instruction is wanted by
  `docs/camera-support-plan.md` — write it once, jointly.
- `AGENTS.md` lists "no wake word / always-on mic" as an explicit non-goal in two places;
  the implementation task must lift that.
- The plan states no latency budget. Define acceptable wake→"● Listening" (e.g.
  <300 ms) and wake→first-audio-captured.
- Config keys should follow the `MISSION_CONTROL_` prefix (see `backend/app/config.py`),
  e.g. `WAKE_WORD_ENABLED`, `WAKE_WORD_THRESHOLD`, `WAKE_WORD_COOLDOWN_MS`,
  `WAKE_WORD_MODEL_PATH`.

## Prerequisites (why this waits on push-to-talk)

Wake word makes latency *feel* worse (the user is already mid-sentence), multiplies the
mic/`AudioContext` lifecycle complexity, and the plan's own "deterministic way to tell
wake-word problems from Gemini problems" only holds if push-to-talk is genuinely
reliable. Before starting:

1. **Push-to-talk verified end-to-end on real kiosk hardware** — audible reply confirmed
   (still unverified per the voice-plan diagnostics notes; `voice.testtone` exists for
   this).
2. **Token-endpoint calendar-name caching** — remove the synchronous Graph snapshot on
   the activation path (`backend/app/api.py`, already flagged in a code comment).
3. **`MicCapture` refactor** to separate mic-source ownership from per-turn capture (can
   land early, independent of the rest).
4. **Microphone-ownership decision** — browser-resident vs host agent, coupled to the
   camera plan.
5. **Kiosk Chrome persistent mic-permission** solved for production
   (`--use-fake-ui-for-media-stream` is not acceptable per the voice plan).

## Testing

The plan's 11 app-level state-machine tests are appropriate and match the existing
pattern exactly — `frontend/src/voice/useVoiceSession.test.ts` already mocks `./session`
and `./audio`; a `WakeDetector` seam mocks the same way. The Playwright `VITE_VOICE_FAKE`
approach extends to a scripted fake wake trigger. No new backend endpoint is needed on
the browser-resident path.