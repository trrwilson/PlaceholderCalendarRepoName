---
status: future
summary: Fixing staged and one-shot keyword activation — leading-silence tolerance, cue timing, keyword-free transcript, silent dismissal of empty queries.
---

# Keyword-activation voice UX — plan

Status: **proposed, not started.** The wake-word path (`frontend/src/voice/wake/`,
`app/voice/wake*.py`) is integrated and off by default; before it is turned on for a
household it needs the activation experience described here. Push-to-talk is unaffected
by everything in this document and stays the diagnostic baseline.

Background reading: `docs/wake-word-plan.md` (the build), `docs/audio-pipeline.md`
(capture, cue, pre-roll geometry), `docs/voice-provider-bakeoff-plan.md` → "End-of-speech
ownership", `backend/app/voice/AGENTS.md` → "Wake word".

---

## The three activation flows

Single-turn voice has three ways in, and they are **not** the same interaction with a
different trigger:

| Flow | Leading silence (trigger → command) | "I'm listening" signal |
| --- | --- | --- |
| **Push-to-talk** | wide — button then a beat then speech | **required**, and PTT already has it (button gives an instant visual + audible ack; provider VAD / mic-RMS handle the end) |
| **Staged activation** | wide — "Mission Control" … *wait for the signal* … "what's tomorrow?" | **required** — the user is explicitly waiting for it |
| **One-shot activation** | ~none by definition — "Mission Control, what's tomorrow?" as one breath | **harmful** — a signal fired mid-command distracts from an utterance already in progress; only trailing silence matters |

PTT works. Staged and one-shot are both broken today, in opposite ways.

## What's wrong today

Grounded in `frontend/src/voice/useVoiceSession.ts` and `wake/preroll.ts`:

- **Staged activation submits a bogus empty turn.** After a wake fire the pre-roll
  (which contains "Mission Control") is flushed into the session and the turn runs the
  normal endpointer. The keyword itself reads as speech, the pause after it reads as
  end-of-speech: `hybrid` providers emit `speech-stopped` and `endUserTurn('server-vad')`
  fires; `client` mode's `SILENCE_HOLD_MS` (700 ms) trips. The turn is finalised and
  answered before the user has said anything. `AUTO_ABANDON_REASONS` does not catch it
  because `spokeRef` is already `true` from the keyword. The delayed post-connect cue
  makes it worse — by the time the user perceives "listening", the silence window has
  usually already closed.
- **One-shot activation beeps over the command.** `playListeningCue()` runs in
  `startTurn`, *after* `createVoiceProvider().connect()` — multiple seconds in. On a
  barrelled "Mission Control, what's tomorrow?" the tone lands in the middle of, or after,
  the word "tomorrow". The same delay means a false rejection is invisible until most of
  the command has been spoken into a session that never opened.
- **The keyword is in the transcript.** `WakePreroll.take()` deliberately reads back
  `firedAt − 1.2 s` of lead, re-including "Mission Control" (and whatever preceded it).
- **Empty queries get a spoken non-answer.** A turn with no content — or whose only
  content is the wake phrase — still gets `endActivity()` + a model response, which
  drones a default "here's your agenda" reply on top of a UX failure.

## Objectives

| ID | Objective |
| --- | --- |
| **P0-pause** | A ≥ 2 s pause between keyword and command must not end the turn. "Mission Control … what's tomorrow?" answers "what's tomorrow?". |
| **P0-cue** | No audible cue over an in-progress one-shot command — not during "…tomorrow", not after it. |
| **P1-ack** | Minimise keyword-detected → user-sees-"listening". Lean on provider affordances. Also mitigates both P0s. |
| **P1-keyword** | "Mission Control" should not be transcription content — a wake turn ≈ pressing the button and saying the command. |
| **P1-empty** | Empty / keyword-only turns dismiss silently. A subtle "didn't catch that" affordance is a future nicety, not required now. |

## Signals available

### Provider affordances (corroborated against current provider docs, Jan 2026)

| Affordance | Providers | Use here |
| --- | --- | --- |
| `create_response: false` + client-owned `response.create` | OpenAI/Azure Realtime, Azure Voice Live; Gemini via manual/hybrid activity | **The key lever for P1-empty.** The client already owns the answer trigger in `hybrid`. Withhold it until content exists; never send it for an empty turn. |
| Semantic VAD (`semantic_vad` eagerness, `azure_semantic_vad` + `end_of_utterance_detection`) | OpenAI/Azure Realtime, Azure Voice Live | Already the `hybrid` default. Tolerates a mid-*command* pause ("set a timer for… ten minutes"). Does **not** help the keyword→command gap — that is pre-content and must be handled client-side. |
| Manual activity (`activityStart`/`activityEnd`), `automaticActivityDetection.disabled` | Gemini | Keep wake turns on hybrid/manual — never automatic VAD — so leading silence is never interpreted as a turn boundary. |
| Input transcription (all providers) | all | Gives the text to run the "is this only the wake phrase?" check before requesting a response. |
| `idle_timeout_ms` / session idle auto-end | OpenAI Realtime | Must be unset or long for a wake turn; the client owns the no-content timeout. |

**Conclusion:** no provider has a "ignore leading silence until the real command starts"
knob. The fix is a client-side *content gate* in the shared turn state machine, plus
`create_response: false` (already in place) to make empty turns free to drop.

### Local geometry

- **Detector fire position.** openWakeWord fires ~1.2 s into the clip — around or after
  the end of "Mission Control" (`docs/wake-word-provider-bakeoff.md`). So flushing pre-roll
  from *near the fire instant forward* already excludes most of the keyword; the current
  `−1.2 s` lead is what re-includes it.
- **Immediate truthful "listening".** On a wake turn the mic is already capturing (the
  detector runs on the shared `MicSource`), so "listening" is honest the instant the
  phrase is detected — unlike PTT, where the socket must open first.
- **Local / Hybrid provider** owns its VAD and has ~0 connect latency — it sidesteps
  most of this. The content gate must live in `useVoiceSession` so it covers that path too.

## Proposed approach

Add one explicit per-turn concept to `useVoiceSession`: an **activation style**
(`ptt` | `staged` | `oneshot`) and an **`awaitingContent`** flag for wake turns. Prefer
this over more scattered `viaWakeRef` checks.

### A. Leading-silence tolerance — content gate (P0-pause)

On a wake activation, `awaitingContent = true` until *content speech* is observed:
sustained mic RMS ≥ the speech gate **on the live mic** (post pre-roll handoff, past
`AEC_SETTLE_MS`), or the first `user-transcript` token that is not the wake phrase.
While `awaitingContent`:

- provider `speech-stopped` / `speech-started` are **ignored** (they fire on the keyword
  in the pre-roll);
- the mic-RMS silence-hold endpointer does not run;
- only `WAKE_CONTENT_TIMEOUT_MS` (new, default ~6000 — comfortably over the 2 s floor)
  and `MAX_LISTEN_MS` apply; either expiry → silent abandon (see E), detector re-arms.

Once content speech is seen → `awaitingContent = false`, normal endpointing resumes
(`hybrid` backstop / `client` hold / semantic VAD), and the keyword→command gap has
already been ridden out.

### B. Cue timing (P0-cue)

- Move the acknowledgement earlier: a wake turn's audible cue (if any) plays **at
  detection**, from `handleWake`, routed through the always-available echo-cancelled
  chime bus (`timers/chime.ts`'s context — it works before the provider socket opens and
  is in the AEC reference, per `docs/audio-pipeline.md` principle 5). The post-connect
  `playListeningCue()` is suppressed for wake turns.
- Classify the style from the pre-roll: if there is significant speech energy in the
  window *after* the keyword (true one-shot), **skip the earcon entirely** — visual ack
  only. Staged activation (silence after the keyword) gets the earcon.
- PTT keeps today's post-connect cue unchanged.

### C. Immediate visual ack (P1-ack)

`handleWake` already flips `status` to `connecting` synchronously. Give wake activation
its own immediate **"● Listening"** overlay treatment distinct from the PTT connecting
spinner — on a wake turn the mic genuinely is live, so the wording is truthful from
millisecond zero. This is the in-scope P1-ack fix; the larger lever (a warm/lingered
provider session that removes connect latency) is an existing, separate follow-up in
`docs/voice-support-plan.md`.

### D. Keep the keyword out of the transcript (P1-keyword)

- Replace `WakePreroll.take()`'s hard-coded `+1.2 s` lead with `WAKE_PREROLL_LEAD_MS`
  (new, default ~250 — coarticulation only), flushing from `firedAt − lead` forward.
  Mirror the change in `openWakeWord.ts`'s inline copy.
- Belt: `prompt.py` gains one line telling the model a wake turn's audio may open with
  the vocative "Mission Control" and to treat it as address, not content.
- The content gate's transcript check normalises and strips a leading
  `^(hey |ok )?mission control[\s,.]*`.
- **Do not over-trim.** openWakeWord's fire position varies; on a fast one-shot the fire
  can land inside the first command word. The lead margin + ASR + prompt do the work;
  aggressive trimming risks clipping "…trol, *what's* tomorrow" → keep it a
  hardware-tuned knob.

### E. Silent dismissal of empty queries (P1-empty)

Generalise the abandon path. When a wake turn ends (`endUserTurn`, or a timeout from A),
before `endActivity()` / any `response.create`:

- if no content speech was ever gated in, **or** the assembled transcript normalises to
  empty / only the wake phrase → mark `turn-abandoned-empty`, tear down, request no
  response. The overlay clears without a spoken reply.
- Wake-surface grants are minted at **`hybrid` maximum** — never pure `provider`
  endpointing — so the client always owns the answer trigger and can withhold it. The
  `surface` string is already threaded to `adapter.create_grant`; clamp there.

## Degraded / edge cases

| Case | Handling |
| --- | --- |
| Content never arrives (keyword-only, walk-away, false wake on TV) | `WAKE_CONTENT_TIMEOUT_MS` → silent abandon, re-arm. Room-audio-to-cloud exposure is bounded to that window (~6 s), same order as `MAX_LISTEN_MS`. |
| Very long staged pause (> timeout) | Treated as abandoned. P0 asks for ≥ 2 s; 6 s gives margin. Knob is per-install if a household wants longer. |
| One-shot, keyword trim clips first command word | Mitigated by the lead margin + ASR + prompt; residual risk is hardware-tuned, not solved by trimming harder. |
| Barrelled one-shot still slightly overlaps the detection earcon | Pre-roll energy classifier suppresses the earcon for that case — visual only. |
| Provider `speech-started` from the keyword audio | Ignored until `awaitingContent` clears (live-mic handoff + guard interval). |
| Very quiet content start after the keyword | Content gate uses the same relative speech level as the endpointer, plus first-transcript-token as an alternate trigger, to avoid a wrongful no-content abandon. |
| Privacy mode | Unchanged — the turn still connects and every tool bar the unlock keypad is refused; an empty turn abandons before that matters. |
| PTT | `activationStyle = 'ptt'`; no content gate, no timing change. Regression-tested. |

## Risks & limitations

- Adds an activation-style dimension to a state machine that is otherwise
  provider-neutral. Keep it one explicit flag pair, not sprinkled conditionals.
- The content-gate RMS heuristic inherits the quiet-talker weakness of the existing
  endpointer. The transcript-token fallback is the mitigation; a genuinely inaudible
  command will still (correctly) abandon.
- Keyword trimming and fire-position assumptions are **unverifiable without kiosk
  hardware** — openWakeWord's ONNX feature maths is still unvalidated on-device
  (`docs/audio-pipeline.md` known gaps).
- The early earcon needs the chime `AudioContext` warm at idle; confirm `AlarmChime`
  is not lazily constructed only on first fire.
- None of this reduces cold-connect latency; C only makes the wait honest and
  non-destructive. The warm-session follow-up is where the real number moves.
- No automated acoustic test — consistent with the rest of the audio stack; deterministic
  state-machine tests only (below).

## Out-of-scope follow-ups

- **Warm / lingered provider session** to cut wake→answer latency
  (`docs/voice-support-plan.md` follow-ups) — the highest-leverage latency win.
- **Subtle false-rejection / "didn't catch that" affordance** — the P1-empty "future
  nicety".
- Parallel `gemini-3.5-transcribe-live` for true word-by-word live text (already tracked).
- A phrase-endpoint model to trim the keyword precisely instead of by a fixed lead.
- Wake barge-in over the assistant's reply ("Mission Control, stop").
- Exposing `WAKE_CONTENT_TIMEOUT_MS` / `WAKE_PREROLL_LEAD_MS` in Settings rather than
  as env + tuned constants.

## Testing

Deterministic, mock detector + mock provider, matching `useVoiceSession.test.ts` /
`wake/wakeSession.test.ts`:

1. Staged: wake → 2.5 s silence → content speech → turn stays open, ends normally after
   the content.
2. Staged abandon: wake → silence past `WAKE_CONTENT_TIMEOUT_MS` → `turn-abandoned-empty`,
   no `endActivity`, no `response.create`, detector re-arms.
3. One-shot: wake with post-keyword energy in the pre-roll → no earcon scheduled; turn
   ends on the normal content endpoint.
4. Empty transcript: wake → transcript is only "Mission Control" → `turn-abandoned-empty`.
5. Provider `speech-stopped` during `awaitingContent` is ignored; the same event after
   content clears the gate ends the turn.
6. A grant with `endpointing: 'provider'` on a wake surface is clamped to `hybrid`
   turn control.
7. `WakePreroll.take()` with the reduced lead: assert the flushed start offset / chunk
   count.
8. PTT regression: cue still plays post-connect, no content gate, timing unchanged.

Backend: wake-surface grant is minted at `hybrid` maximum (`test_voice_*`).

Instrumentation: add `wake-content-detected`, `wake-activation-style`,
`turn-abandoned-empty` timeline marks so `VoiceTurnReport` / the bake-off measurement
capture the new behaviour.

## Docs to update when this is built

- `backend/app/voice/AGENTS.md` → "Wake word" — already carries the distilled principles
  (added with this plan); keep in step with the implementation.
- `docs/audio-pipeline.md` → Output / pre-roll — the cue may render on the chime bus for
  a pre-connect wake ack; `WAKE_PREROLL_LEAD_MS` replaces the fixed lead.
- `docs/voice-commands.md` — describe staged vs one-shot once the feature is live.
- `docs/wake-word-plan.md` → "Wake-to-Command Audio Handoff" / "End-of-Utterance
  Handling" — resolve those open questions by reference to this plan.
