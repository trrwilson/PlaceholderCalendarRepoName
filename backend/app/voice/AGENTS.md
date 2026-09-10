---
name: Mission Control voice
description: Voice assistant architecture — provider seam, endpointing, local/hybrid pipeline, wake word.
---

# Voice assistant & wake word

Read the repo-root `AGENTS.md` and `backend/AGENTS.md` first. Build history and the
per-provider wire details are in `docs/` — `voice-support-plan.md`,
`voice-provider-bakeoff-plan.md`, `local-voice-plan.md`, `wake-word-plan.md` (see
`docs/README.md`).

Two things must move with any change here:
- **`docs/voice-commands.md`** — the human-facing list of what voice understands.
  Update it with any change to the tool set, `prompt.py` spoken behaviour, or what
  voice is allowed to touch.
- **`docs/audio-pipeline.md`** — the *sole* authority on mic capture, the one gain
  stage, sample rates, echo cancellation, and playout. It is not per-provider (one
  mic, one gain, one output bus, shared by voice + wake word + the timer chime). Read
  it before touching anything that affects samples or level.

## What voice is

Tap-to-talk. It answers schedule questions and moves the display; it **cannot change
the calendar.** Two narrow write exceptions, both local appliance state with no
external side effect: the kitchen timer and the grocery list. Spoken replies are
one-sentence confirmations — the display carries the answer, the overlay is transient,
not a chat panel.

**Single turn, no follow-up questions.** Every activation is one self-contained
exchange. `prompt.py` forbids follow-up offers ("Do you want me to…", "Should I…") —
answer what was asked, then stop. This is a hard rule; the speech-to-speech models
drift into assistant-chat patterns otherwise.

The system prompt bakes in a compact digest of the next
`MISSION_CONTROL_VOICE_CONTEXT_DAYS` (default 30) of events so loose references
resolve with no tool call; `get_events` is for dates past that window.

## Provider seam

`MISSION_CONTROL_VOICE_PROVIDER` selects the conversational provider (a bake-off,
default `gemini`). One `VoiceProviderAdapter` per provider in `app/voice/providers/`;
the shared prompt (`prompt.py`), tool contract (`tools.py`), and grant caching
(`cache.py`) sit **above** the adapters and never know which is active. The frontend
mirror is `frontend/src/voice/providers/` behind one `ConversationalVoiceProvider`
interface + a `VoiceEvent` union — the shared layer never sees a wire protocol.
Selecting an unconfigured provider is a 409, never a silent fallback.

- **Gemini** connects browser-direct with an ephemeral token from
  `POST /api/voice/token` (LAN-gated); the API key never leaves the backend.
- **Azure contestants** connect through the backend relay (`app/voice/relay.py`,
  `WS /api/voice/live`) with a single-use ticket — the browser `WebSocket` API can't
  set auth headers. Relay grants are not cacheable.
- Token + snapshot caching and freshness rules: `docs/voice-token-caching-notes.md`.
- `backend/scripts/verify_voice_providers.py` exercises each provider live (not CI).

## Endpointing is negotiated, not fixed at the shared layer

`grant.endpointing` is `client` | `hybrid` | `provider` (`app.models.Endpointing`).
The shared mic-RMS silence detector is the **default** (`client`), applied when a
provider declares nothing better. The shared turn state machine (`useVoiceSession`)
switches strategy on the declared mode — it must not assume it always owns
endpointing, nor infer ownership from whether a provider event happened to arrive.
Detail: `docs/voice-provider-bakeoff-plan.md` → "End-of-speech ownership".

## Durable principle — integrated cloud *and* composed local/hybrid

The voice architecture must support both integrated cloud speech-to-speech providers
*and* composition of local/hybrid speech / routing / tool / reasoning / TTS stages. Do
not couple core application behaviour to the assumption that one provider owns the
whole conversational audio pipeline. **Add abstractions only when a concrete
implementation needs them** — do not pre-build a generalized voice framework.

- Cloud contestants stay integrated speech-to-speech providers — do not decompose them
  internally to satisfy a hypothetical abstraction.
- The generalized STT / intent / escalation seams exist **only inside
  `app/voice/local/`.** Do not hoist them into the shared voice layer.
- Wake-word selection stays orthogonal to conversational-voice selection.
- Bake-off instrumentation (`instrument.ts` `VoiceTimeline`) measures the whole
  user-perceived interaction — preserve the milestone seams a hybrid path reuses
  (activation, end of speech, transcription, intent/tool decision, first response
  audio, cancellation, errors).

## Tools = explicit application tools, never providers

`app/voice/tools.py` is the contract, mirrored in `frontend/src/voice/tools.ts` (the
backend copy is what gets locked into the token). View-state tools mutate local state;
data tools are answered from `/api/calendar`; timer/list tools call `/api/timers` and
`/api/lists`. Agent code never reaches a calendar provider directly. The local intent
router plans the same tool calls without a speech provider. **Adding a tool =** update
both `tools` files, the `DashboardActions` type + `App.tsx` `voiceActions`, the
locked-set assertions in `test_voice*.py`, and `docs/voice-commands.md`.

## Local / Hybrid pipeline (`app/voice/local/`, experimental)

`MISSION_CONTROL_VOICE_PROVIDER=local`. On-device STT + intent/entity interpretation;
the cloud is an **escalation capability, not a mandatory hop.** Runs on the backend
over `WS /api/voice/local` (relay-style ticket), driving the same
`ConversationalVoiceProvider` interface. Two extra `VoiceEvent`s (`diagnostic`,
`escalation`) are additive and ignored by the cloud paths.

- **Four layers, each separately replaceable and text-testable** (no mic, no model):
  `recognizer` (STT seam) → `intents` (weighted regex — never exact-string, never a
  giant static grammar) → `dates` + `entities` (fuzzy resolution against the live
  `CalendarSnapshot` passed in per turn, no baked-in name list) → `interpreter`
  (confidence, tier, plan).
- Mission Control never imports `faster-whisper` / `sherpa-onnx` directly — only
  `SpeechRecognizer` (`local/recognizer.py`). Engines (`local/engines/`) are a lazily-imported
  config choice; the dependency-free `scripted` engine backs tests and the text
  bypass. A discrete GPU is an opt-in accelerator, never required — CPU int8 meets the
  interactive target (`docs/local-stt-evaluation.md`).
- Tool execution stays in the browser dispatcher — the interpreter only decides which
  tools to call.
- `Interpretation.disposition` is the explicit local-vs-escalate representation
  (`handled_locally` / `needs_clarification` / `rejected` / `escalate_to_cloud`). The
  cloud text call (`CloudEscalator`) and local TTS are **extension points, not done.**
- **Safety: a mutating request below the mutation-confidence threshold is never
  executed on a guess** — it becomes `needs_clarification`. Calendar writes are
  `rejected` unconditionally. "Recognised but unsupported" is a clean "can't do that
  yet", never a guess.
- The reusable command corpus is text (`backend/tests/data/voice_commands.jsonl`) — no
  personal recordings in git. Keep it and `docs/voice-commands.md` current with
  intent-catalogue changes.

## Wake word (`frontend/src/voice/wake/`, `app/voice/wake*.py`)

Local "Mission Control" activation. **Off by default**; a missing model, runtime, or
backend degrades silently to push-to-talk, which is always independent of all of this.

- **Not conversational AI.** The detector answers only "did someone say the phrase?"
  and then calls the *same* `startTurn()` the Ask button does — it never touches the
  model, tools, or the transcript.
- **Provider bake-off, orthogonal to the voice provider** (`WakeProviderId`:
  `openwakeword` | `azure`, runtime-selectable, defaulted by
  `MISSION_CONTROL_WAKE_WORD_PROVIDER`):
  - `openwakeword` (default): **browser-resident** — idle-listening audio never leaves
    the browser.
  - `azure`: an Azure custom-keyword `.table` spotted **on the backend** by the native
    Speech SDK (optional `.[azure-wake]` extra). Spotting is still on-device (no key,
    no network) but the audio reaches our backend — a deliberate exception at the same
    trust boundary as the voice relay.
- **On-device Invoke gate — additive, not a provider** (`invoke_gate_enabled`, default
  off; needs `MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST`). A loose first stage
  running on a companion device (separate `ReInvoke2026` repo) that gates whichever
  provider is selected; an activation needs the gate *and* the detector to agree.
- **One microphone, one gain.** `audio.ts` `MicSource` is reference-counted (one
  `getUserMedia` + `AudioContext` + worklet, many listeners). Wake word and
  push-to-talk are both just listeners — never open a second mic stack, never put a
  `deviceId` constraint anywhere but `useAudioInput`. (`docs/audio-pipeline.md`.)
- Web Speech API is ruled out — Chrome sends its audio to Google, breaking
  local-by-default.

### Activation styles — a keyword turn is not push-to-talk (`docs/voice-activation-ux-plan.md`, proposed)

- **Leading silence is expected.** A wake turn is not end-of-speech- or
  answer-eligible until *content* speech (after the keyword, on the live mic) is
  heard — a provider `speech-stopped` before that is the keyword; ignore it.
- **The keyword is not content.** Keep it out of the transcript; never speak a
  reply to a turn whose only content is the wake phrase — dismiss it silently.
- **Acknowledge on detection, not on connect** — visual at `handleWake`; the cue
  plays at detection or not at all, never mid-command. Wake grants never run pure
  `provider` endpointing (the client must own the answer trigger to withhold it).
