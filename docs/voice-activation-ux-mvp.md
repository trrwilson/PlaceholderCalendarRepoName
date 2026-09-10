---
status: implemented
summary: MVP slice of the keyword-activation UX fix — content gate for leading silence, cue suppression, silent empty dismissal. Scoped to Azure Custom Keyword (basic) + Azure Voice Live.
---

# Keyword-activation UX — MVP

Status: **implemented** (deterministic state-machine tests only; not yet
exercised on kiosk hardware). Decisions taken at go-ahead: visual-only ack (no
at-detection earcon), `activationStyle` as a separate hook field, flat
`'kiosk-wake'` surface string, `WAKE_CONTENT_TIMEOUT_MS` = 3500 ms.

Narrows `docs/voice-activation-ux-plan.md` to the
smallest slice that makes staged + one-shot wake activation shippable for one
household, and pins the provider-specific details to the two contestants we are
actually running: **Azure Custom Keyword (basic)** for detection and **Azure Voice
Live** for the conversation. Everything here is a strict subset of the parent
plan's objectives and section letters (A/B/C/D/E) — no new design, just a cut line.

Push-to-talk is untouched and stays the diagnostic baseline.

---

## What's in the MVP, and what waits

| Parent objective | MVP? | Rationale |
| --- | --- | --- |
| **P0-pause** — a ≥ 2 s keyword→command gap must not end the turn | **In** | The blocker. Without it staged activation submits a bogus empty turn every time (`docs/voice-activation-ux-plan.md` → "What's wrong today"). This is the one medium-risk change we accept. |
| **P0-cue** — no audible cue over an in-progress one-shot command | **In (reduced)** | Suppress the post-connect `playListeningCue()` for wake turns entirely. Visual-only ack. Trivial and fully removes the defect. The *at-detection earcon* (parent §B) waits — see "Deferred". |
| **P1-empty** — empty / keyword-only turns dismiss silently | **In** | Falls out of P0-pause almost for free: if the content gate never opened, tear down without `endActivity()` — the exact shape of the existing no-speech abandon path. High user value (a spoken non-answer on top of a UX miss). |
| **P1-ack** — minimise keyword→"listening" | **In (minimal)** | `handleWake` already flips `status` synchronously; add one distinct "● Listening" treatment for wake turns. No warm-session work (that's a separate follow-up in `docs/voice-support-plan.md`). |
| **P1-keyword** — keyword out of the transcript | **In (belt only)** | Prompt belt line + a transcript-normalisation strip in the content gate. **The pre-roll lead is not shortened** in the MVP — that's the unverifiable-without-hardware knob. |
| §B earcon classifier (one-shot vs staged from pre-roll energy) | Deferred | Needs pre-roll energy analysis; not low-risk. |
| Shortening `WAKE_PREROLL_LEAD_MS` from 1.2 s | Deferred | Risks clipping the first command word on a fast one-shot; unverifiable without the kiosk mic (`docs/audio-pipeline.md` known gaps). Introduce the constant, leave the value at 1200. |
| Warm / lingered provider session | Deferred | Parent plan out-of-scope; the real latency lever, separate effort. |
| "Didn't catch that" affordance | Deferred | Parent plan calls it a future nicety. |
| Settings exposure of the new knobs | Deferred | Env + tuned constants for now. |

---

## Design (MVP subset)

One new concept in `useVoiceSession`, exactly as the parent plan frames it: a
per-turn **activation style** and an **`awaitingContent`** flag. Keep it to one
explicit ref pair — not scattered `viaWakeRef` conditionals.

```
activationStyleRef: 'ptt' | 'wake'      // MVP collapses 'staged' | 'oneshot' → 'wake'
awaitingContentRef: boolean             // true only on a wake turn, until content speech
```

`'staged'` vs `'oneshot'` is not distinguished in the MVP because the only thing
that used the distinction (parent §B's earcon choice) is deferred. The content
gate handles both identically.

### A. Content gate — leading-silence tolerance (P0-pause)

On a wake activation, set `awaitingContentRef = true` at `startTurn`. While it is true:

- **Provider `speech-started` / `speech-stopped` are ignored** — do not set
  `serverVadSeenRef`, `spokeRef`, or call `endUserTurn`. These fire on the keyword
  audio in the flushed pre-roll (Azure `azure_semantic_vad`, `silence_duration_ms:
  500`, will emit them within ~0.5 s of the flushed "Mission Control").
- **The mic-RMS endpointer does not run.** In `handleLevel`, when
  `awaitingContentRef` is set, skip the silence-hold / no-speech / backstop
  branches. Only `MAX_LISTEN_MS` and the new `WAKE_CONTENT_TIMEOUT_MS` apply.
- The gate **clears** on the first of:
  1. sustained live-mic RMS ≥ the speech gate (`SPEECH_RMS`), measured past
     `AEC_SETTLE_MS` on the live mic — reuse the existing arming logic in
     `handleLevel`; or
  2. the first `user-transcript` event whose text, normalised and stripped of a
     leading `^(hey |ok |okay )?mission control[\s,.]*`, is non-empty.
- On clear: `awaitingContentRef = false`, `timeline.mark('wake-content-detected')`,
  and normal endpointing resumes from that instant (`hybrid` backstop / semantic
  VAD). The keyword→command gap has been ridden out.
- On `WAKE_CONTENT_TIMEOUT_MS` or `MAX_LISTEN_MS` expiry with the gate still
  closed → silent abandon (see E), detector re-arms.

`listenStartRef` for a wake turn is set when the live mic starts (after the
pre-roll flush), not at connect, so `AEC_SETTLE_MS` and the timeout measure from
the handoff.

### B. Cue timing (P0-cue) — reduced

- `playListeningCue()` is **not called** for wake turns (`activationStyleRef ===
  'wake'`). PTT is unchanged.
- No earcon is played at detection in the MVP. The wake overlay (C) is the whole
  acknowledgement. Staged activation loses its audible "go" until the §B earcon
  work lands; acceptable because staged is fully broken today and the visual ack
  is instant and truthful (the mic genuinely is live from `handleWake`).

### C. Immediate visual ack (P1-ack) — minimal

- `handleWake` already sets `status = 'connecting'` synchronously. Thread the
  activation style so the overlay can render a distinct **"● Listening"** state
  for a wake turn while `connecting` — the parent plan's point that on a wake turn
  the mic is already capturing, so the wording is honest from millisecond zero,
  unlike the PTT connect spinner.
- Implementation: either a new `VoiceStatus` value (`'wake-listening'`) or — lighter —
  expose `activationStyle` alongside `status` from the hook and let the overlay
  branch. Recommend the latter; it avoids touching every `status` switch.
- `wake.diagnostics.activationLatencyMs` already measures wake→`reportActivated`;
  keep it.

### D. Keyword out of the transcript (P1-keyword) — belt only

- **Prompt belt.** One line in `build_system_instruction` (`app/voice/prompt.py`):
  a wake turn's audio may open with the vocative "Mission Control"; treat it as
  address, not content. Applies to every provider, costs nothing.
- **Transcript strip.** The content-gate check (A.2) and the empty check (E)
  normalise and strip `^(hey |ok |okay )?mission control[\s,.]*` before deciding.
- **Pre-roll lead unchanged.** Replace the hard-coded `+1.2` in `WakePreroll.take()`
  and the inline copy in `openWakeWord.ts` with a shared `WAKE_PREROLL_LEAD_MS`
  constant, value **1200** (no behavioural change). Shortening it is a
  hardware-tuned follow-up, not MVP.

### E. Silent dismissal of empty queries (P1-empty)

Generalise the existing abandon path (`endUserTurn`'s `!spokeRef && AUTO_ABANDON_REASONS`
branch → `finishTurn()` with no `endActivity`):

- When a wake turn ends, **before** `endActivity()` / any `response.create`:
  if the content gate never cleared, **or** the assembled transcript normalises to
  empty / only the wake phrase → `timeline.mark('turn-abandoned-empty')`,
  `voiceDebugRecorder.note({ outcome: 'abandoned' })`, `finishTurn()`. The overlay
  clears with no spoken reply.
- Because the MVP provider is Azure Voice Live in `hybrid` mode, "request no
  response" = simply **do not send `activity-end`** (the relay turns `activity-end`
  into `commit` + `response.create`; skipping it means the model is never asked).
  `session.close()` from `teardown()` drops the single-use relay socket cleanly.
- New abandon reasons `wake-content-timeout` and `wake-empty-transcript` join
  `AUTO_ABANDON_REASONS`.

---

## Provider specifics

### Azure Custom Keyword (basic) — `app/voice/wake_azure.py`, `frontend/src/voice/wake/azureKeyword.ts`

- **Fire position.** The native `KeywordRecognizer.recognized` signal fires *after*
  the keyword utterance completes — i.e. `firedAt ≈ end of "Mission Control"`. With
  the pre-roll flushed from `firedAt − 1200 ms` forward, the flush contains the
  keyword and ~1 s before it. The content gate + transcript strip are what keep
  that out of the answer; the prompt belt is the backstop.
- **`score` is always `1.0`** (binary spot). No threshold tuning is available from
  this path — which is *why* the "basic" model tier makes P1-empty load-bearing:
  the basic tier has a higher false-accept rate (TV dialogue, "permission control",
  etc.), and the content-gate timeout is the bound on room-audio-to-cloud exposure
  for a false wake (3.5 s, well under `MAX_LISTEN_MS`).
- **Audio already crosses to the backend** on this provider (documented trust-boundary
  exception, `backend/app/voice/AGENTS.md` → "Wake word"). The MVP changes nothing
  about that; the content gate runs frontend-side on the live-mic RMS the browser
  already has.
- **Suspend/resume** is unchanged: `useWakeWord` suspends the detector on
  `voiceBusy` and re-arms on return to `idle`. A silent abandon (E) returns
  `status` to `idle` → detector re-arms via the existing effect. No new plumbing.
- No change to `wake_azure.py` itself. All MVP work is frontend + `prompt.py` +
  the Azure Voice Live adapter clamp below.

### Azure Voice Live — `app/voice/providers/azure_voice_live.py`, `app/voice/relay.py`

- **`reusable_grant = False`** — every turn mints a fresh single-use ticket, so a
  wake-surface endpointing clamp (below) cannot poison a cached grant for a later
  PTT turn. This is why the MVP is safe to scope to Azure and defer the Gemini
  case (Gemini's token is multi-use; clamping there needs the surface in the cache
  key — out of scope).
- **`default_endpointing = "hybrid"`**, and `azure_semantic_vad` is always on
  (its server echo canceller requires it). In `hybrid`, `voice_live_turn_detection`
  sets `create_response: false` → the kiosk owns the answer trigger via
  `activity-end`. This is exactly the lever P1-empty needs: withhold `activity-end`
  and the model never answers.
- **Endpointing clamp for wake turns.** `settings.azure_voice_live_endpointing` is
  `Literal["hybrid", "provider"]`. If an operator sets `provider`, a wake turn
  would let Azure auto-respond and the client could not withhold it. So:
  - Frontend: `startTurn({ viaWake: true })` requests the grant with a wake
    surface — `surface: 'kiosk-wake'` (thread a per-turn surface through
    `createVoiceProvider` → `fetchVoiceGrant`; today `surface` is the static
    `'kiosk'` from the `useVoiceSession` option).
  - Backend: `AzureVoiceLiveAdapter.create_grant` computes
    `endpointing = "hybrid" if _is_wake_surface(surface) else settings.azure_voice_live_endpointing`.
    `_is_wake_surface` = `surface in {"kiosk-wake"}` (a small helper in
    `app/voice/base.py` so other adapters can adopt it later).
  - `test_voice_*`: assert a `kiosk-wake` surface yields `endpointing == "hybrid"`
    even with `azure_voice_live_endpointing = "provider"`.
- **Pre-roll burst + semantic VAD.** When the pre-roll flushes as a burst right
  after connect, `azure_semantic_vad` will emit `speech-started` then
  `speech-stopped` (~500 ms silence after the keyword). `handleEvent`'s
  `speech-stopped` case calls `endUserTurn('server-vad')` when `status ===
  'listening'`. The `awaitingContentRef` guard (A) is what makes this deterministic
  — without it the turn ends on the keyword. `MIN_LISTEN_MS` (600 ms) is *not* a
  reliable guard here because connect + flush latency can exceed it.
- **Relay:** no change. `translate_client` already only appends `response.create`
  when `turn.endpointing != "provider"` and only on `activity-end`; the MVP just
  doesn't send `activity-end` for an empty wake turn.

---

## New constants / config

| Name | Where | Value | Notes |
| --- | --- | --- | --- |
| `WAKE_CONTENT_TIMEOUT_MS` | `useVoiceSession.ts` | `3500` | Gate-open deadline on a wake turn (a separate `setTimeout`, plus a `MAX_LISTEN_MS` check in `handleLevel`). Over the 2 s P0 floor with margin; bounds false-wake cloud exposure. |
| `WAKE_PREROLL_LEAD_MS` | `wake/preroll.ts` (+ `openWakeWord.ts` inline copy) | `1200` | Names the existing magic number. **No behaviour change in the MVP.** |
| `_is_wake_surface(surface)` | `app/voice/base.py` | — | `surface in {"kiosk-wake"}`. |
| wake surface string | `useVoiceSession.startTurn` | `'kiosk-wake'` | Per-turn override of the `'kiosk'` default for `viaWake` turns. |

No new env vars in the MVP. `WAKE_CONTENT_TIMEOUT_MS` / `WAKE_PREROLL_LEAD_MS`
becoming env-overridable is a parent-plan follow-up.

---

## Files touched

Frontend:
- `frontend/src/voice/useVoiceSession.ts` — activation-style + `awaitingContent`
  refs; content gate in `handleLevel` and `handleEvent` (`speech-*`, `user-transcript`);
  cue suppression; empty-abandon branch; per-turn wake surface; expose
  `activationStyle`.
- `frontend/src/voice/wake/preroll.ts`, `frontend/src/voice/wake/openWakeWord.ts` —
  `WAKE_PREROLL_LEAD_MS` constant (value unchanged).
- `frontend/src/voice/providers/index.ts`, `frontend/src/voice/providers/grant.ts` —
  accept a per-turn surface (or a surface override arg).
- `frontend/src/App.tsx` / voice overlay component — distinct "● Listening" render
  for a wake turn.
- `frontend/src/voice/types.ts` — `activationStyle` on the hook return (or a new
  `VoiceStatus`).

Backend:
- `app/voice/base.py` — `_is_wake_surface` helper.
- `app/voice/providers/azure_voice_live.py` — endpointing clamp on a wake surface.
- `app/voice/prompt.py` — one belt line about the vocative keyword.

Docs (on build): `backend/app/voice/AGENTS.md` (drop "proposed"), `docs/audio-pipeline.md`,
`docs/voice-commands.md`, `docs/voice-activation-ux-plan.md` (mark MVP slice done),
`docs/wake-word-plan.md` open questions.

---

## Risks & mitigations

| Risk | Mitigation |
| --- | --- |
| Content gate adds an activation-style dimension to a provider-neutral state machine. | One explicit ref pair, guard clauses only in `handleLevel` / `handleEvent`. No new `viaWakeRef` sprinkles — the parent plan's explicit constraint. |
| Quiet-talker: RMS content gate misses a soft command start → wrongful empty abandon. | Transcript-token trigger (A.2) is the alternate path; a genuinely inaudible command correctly abandons. Same weakness the existing endpointer already has. |
| Azure semantic VAD fires `speech-stopped` on the pre-roll keyword before the gate is wired. | `awaitingContentRef` guard is checked *first* in the `speech-stopped` handler. Covered by test 5. |
| Pre-roll lead still includes the keyword (unchanged 1.2 s). | Prompt belt + transcript strip. Accepted: shortening the lead is unverifiable without kiosk hardware. |
| Staged activation has no audible "go" until the §B earcon lands. | Instant visual "● Listening". Staged is broken today anyway; this is strictly better. Flagged as a decision point below. |
| `'kiosk-wake'` surface leaks into a cached grant. | Azure Voice Live `reusable_grant = False` — every turn mints fresh. MVP is Azure-only for exactly this reason. |
| No acoustic test. | Consistent with the rest of the audio stack — deterministic mock-detector / mock-provider state-machine tests only. |

---

## Tests (as built)

Deterministic, mock detector + mock provider.

`frontend/src/voice/wake/wakeSession.test.ts`:
- long keyword→command pause (2.5 s + a keyword `speech-stopped`) keeps the turn
  open; the command then finalises it normally;
- no content within `WAKE_CONTENT_TIMEOUT_MS` → silent abandon, no `activity-end`,
  detector re-arms;
- keyword-only transcript → abandon on Stop, no `activity-end`;
- content speech on the live mic opens the gate (Stop then submits);
- wake turn requests `surface === 'kiosk-wake'`;
- listening cue suppressed for a wake turn, still fires for the following PTT turn;
  `activationStyle` flips `wake` → `ptt`.

`backend/tests/test_voice_relay.py`:
- `create_grant(surface='kiosk-wake')` with `azure_voice_live_endpointing='provider'`
  → grant `endpointing == 'hybrid'`, `turn_detection.create_response is False`;
  a `kitchen` surface keeps `provider`.

`backend/tests/test_voice_prompt.py`: the wake-phrase belt line is in the system
instruction.

`WakePreroll` / `openWakeWord` pre-roll tests unchanged (`WAKE_PREROLL_LEAD_MS`
extraction is behaviour-preserving at 1200).

Timeline marks added: `wake-content-detected`, `turn-abandoned-empty`, and
`{ ignored: 'awaiting-content' }` on the suppressed `server-speech-*` marks.

---

## Deferred to the parent plan (`docs/voice-activation-ux-plan.md`)

- §B at-detection earcon + one-shot/staged pre-roll energy classifier.
- Shortening `WAKE_PREROLL_LEAD_MS` below 1.2 s (needs kiosk hardware).
- Warm / lingered provider session (the real latency win).
- "Didn't catch that" false-rejection affordance.
- Settings exposure of `WAKE_CONTENT_TIMEOUT_MS` / `WAKE_PREROLL_LEAD_MS`.
- Gemini / `azure_openai_realtime` wake-surface endpointing clamp (needs surface in
  the reusable-grant cache key).
- Wake barge-in over the assistant's reply.

---

## Decisions taken at go-ahead

1. **Earcon:** visual-only for wake turns. The at-detection earcon + classifier
   stays deferred to the parent plan.
2. **`activationStyle` surfacing:** a separate field on the hook return (no new
   `VoiceStatus` value) — `VoiceOverlay` branches on it.
3. **Wake surface:** the flat string `'kiosk-wake'` (no `VoiceTokenRequest` model
   change).
4. **`WAKE_CONTENT_TIMEOUT_MS` = 3500 ms** (6 s was judged too long a room-audio
   window for a false wake on the basic keyword tier).

## First hardware check

None of the pre-roll / fire-position assumptions are verified on the kiosk mic
(`docs/audio-pipeline.md` known gaps). On first hardware:
- confirm a staged "Mission Control" … pause … command answers the command, not
  an empty turn;
- confirm a barrelled one-shot is not clipped and its answer omits the keyword;
- if the keyword still bleeds into answers, that is the signal to revisit
  `WAKE_PREROLL_LEAD_MS` (down from 1200) — the deferred knob.
