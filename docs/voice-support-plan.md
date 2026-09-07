# Voice support — initial plan

Status: **initial version implemented** (backend token endpoint + `app/voice/`, frontend
`src/voice/` tap-to-talk session, Ask-button wiring, tests, docs). This document is kept as
the design record; the sections below describe the target and the decisions, and
`## What shipped` / `## Resolved open questions` record where it landed.

## Goal for this milestone

Give Mission Control a first, genuinely useful voice capability:

- A household member **taps the "Ask" button** (already present but inert in the header,
  `frontend/src/App.tsx`), speaks, and releases.
- The assistant can **answer schedule questions** and **drive the existing dashboard**
  (navigate to a date/range, switch mode, highlight an event, open the People filter).
- It gives a **brief spoken acknowledgement**; the screen carries the real answer, per the
  "the display is the assistant's output surface, not a detached chatbot" principle in
  `AGENTS.md`.
- **No calendar writes** in this milestone. `get`-style tools only.

> **Timer exception (added with `docs/timer-plan.md`).** Voice may now
> **set, cancel, extend, pause, resume, and restart a single kitchen timer** —
> `start_timer`, `cancel_timer`, `extend_timer`, `pause_timer`, `resume_timer`,
> `restart_timer`, plus read-only `get_timer`. These are the first
> state-mutating voice tools. They are a deliberate, narrow exception to the
> read-only rule: timer state is ephemeral, local, single-appliance, and has no
> external side effect and no calendar/provider write. Calendar writes remain out
> of scope. `start_timer` takes a duration or an absolute local target time and
> the six-hour cap is stated in its schema so the agent speaks the rejection.
> `pause_timer` / `resume_timer` freeze and continue the countdown; `restart_timer`
> resets it to its original full duration and works while running, paused, or
> ringing.
> Dismissing a ringing alarm by voice ("stop") maps to `cancel_timer`; a fired
> timer does **not** open a voice session on its own (one-session-per-turn), so
> there is no spoken announcement on fire in this task — the chime + forced Timer
> view are the notification. Revisit with the wake-word work.

Non-negotiable from `AGENTS.md` / `.prompts/0001-bootstrap.txt`:

> browser microphone → speech service → agent → **explicit application tools** → actions →
> real-time UI update → optional TTS. The agent must never touch calendar providers
> directly.

## Decisions locked in

| Question | Decision |
| --- | --- |
| Capability scope | Read + navigate the UI. No writes. |
| Activation | Tap-to-talk now (wire the existing "Ask" button). Design the session/state machine so a wake-word front end can be added later without rework. |
| Model class | Gemini **native-audio** Live model (end-to-end audio dialog). |
| Spoken output | Brief confirmations only; the display carries the substantive answer. |
| Secret handling | `GEMINI_API_KEY_MISSION_CONTROL` stays **server-side only**. The browser never sees it. |
| Browser ↔ Gemini | Browser connects **directly** to the Gemini Live API over WebSocket using a short-lived **ephemeral token** minted by our backend. |

## Architecture

```
┌─────────────────────────── kiosk browser ───────────────────────────┐
│  Ask button ─▶ VoiceSession (React)                                  │
│      │  1. POST /api/voice/token         (our backend, LAN-gated)    │
│      │  2. genai.live.connect(token)  ──────────────▶ Gemini Live API│
│      │  3. stream mic PCM  ────────────────────────▶  (Google)       │
│      │  4. ◀── audio out + input/output transcription                │
│      │  5. ◀── toolCall(get_events / navigate_view / …)              │
│      │  6. dispatch:                                                  │
│      │        • UI tools  → local React state (navigate, highlight)  │
│      │        • data tools → GET /api/calendar (our backend)         │
│      │  7. toolResponse ──────────────────────────▶  Gemini          │
└─────────────────────────────────────────────────────────────────────┘
        our backend only: mints tokens, serves calendar data, owns providers
```

Why this shape:

- The **API key never leaves the server**. The backend calls Google's
  `auth_tokens.create` and returns a token that expires in minutes and is constrained to a
  single new Live session.
- The **latency-sensitive audio path is browser ↔ Google directly** — we don't proxy
  audio frames through FastAPI.
- **Durable/side-effecting work stays server-side**: calendar provider access is still
  only reachable through our HTTP API; UI-control tools have no security surface because
  they only change local view state.

### Deliberate deviation to record in `AGENTS.md`

`AGENTS.md` currently says the server owns "any future AI/audio/video processing." With
ephemeral-token direct-connect, the **Live session is held in the browser**. The
compensating controls: the secret stays server-side, the token is short-lived and
constrained, and every tool that reads household data or could ever mutate state is a
backend endpoint. This trade needs a short paragraph in `AGENTS.md` when we start.

## Backend work

### Configuration (`app/config.py`)

- Add `gemini_api_key: str | None`. The existing settings use the `MISSION_CONTROL_`
  prefix, but the key is provisioned as `GEMINI_API_KEY_MISSION_CONTROL`. Use
  `validation_alias=AliasChoices("GEMINI_API_KEY_MISSION_CONTROL", "MISSION_CONTROL_GEMINI_API_KEY")`
  so either name works and the convention isn't broken.
- Add `voice_enabled: bool = False` (feature flag; the kiosk build opts in).
- Add `gemini_live_model: str` with a default once we confirm the exact native-audio model
  id (see open questions).
- Optional: `gemini_voice_name`, `voice_token_ttl_seconds` (default ~600),
  `voice_daily_session_cap` (cost guard).

### New module `app/voice/`

- `tokens.py` — wraps `google-genai`'s `client.aio.auth_tokens.create(...)`:
  - `uses=1`, short `expire_time`, short `new_session_expire_time`.
  - `live_connect_constraints` locking: model, generation/response config (audio, chosen
    voice, `output_audio_transcription`, `input_audio_transcription`), **system
    instruction**, and the **tool declarations**. The browser then cannot repurpose the
    token — it can only supply audio and tool responses.
  - Returns `{ token, expires_at }`.
- `tools.py` — the single source of truth for the tool schema (JSON schema / function
  declarations) shared into the token constraints and mirrored in the frontend dispatcher.
- `prompt.py` — the system instruction (household context: calendar names, today's date,
  available views, "prefer showing over telling").

### New endpoint (`app/api.py`)

- `POST /api/voice/token` → `VoiceToken` model. Gated with the existing `_require_local`
  helper (same LAN-only posture as the calendar sign-in endpoints). Returns 409 when
  `voice_enabled` is false or the key is missing.
- No new WebSocket. The existing `/api/ws` and `ApplicationMessage` are **not** needed for
  this milestone — the browser holds the session and applies UI changes to local state
  directly. (Revisit only if we later want one household device's voice command to move
  another screen.)

### New models (`app/models.py`)

- `VoiceToken { token: str, expires_at: datetime, model: str }`.
- Tool argument/result models if we want them validated on the data-tool endpoints
  (probably reuse `CalendarSnapshot` / a small `AgendaResult`).

### Dependencies

- `google-genai` added to `backend/pyproject.toml`. Import lazily in `app/voice/` so the
  mock/no-voice path never needs it (same pattern as the Graph providers).

## Frontend work

### Dependencies

- `@google/genai` in `frontend/package.json`.

### `VoiceSession` module (new, `frontend/src/voice/`)

- `useVoiceSession()` hook owning a small state machine:
  `idle → requesting → listening → thinking → speaking → idle` plus `error`.
- Token fetch from `POST /api/voice/token`, then
  `new GoogleGenAI({ apiKey: token, httpOptions: { apiVersion: 'v1alpha' } })` and
  `ai.live.connect({ model, callbacks })`.
- **Mic capture**: `getUserMedia({ audio })` → `AudioWorklet` down-sampling to 16 kHz
  mono 16-bit PCM → `sendRealtimeInput`. Mic track is **stopped between turns** (tap-to-
  talk; no always-on mic).
- **Playback**: 24 kHz PCM output → `AudioContext` queue with barge-in (drop the queue
  when the user starts a new turn or the model is interrupted).
- **Manual activity**: with tap-to-talk we can disable automatic VAD and send explicit
  activity start/end on button press/release, or simply gate the stream. Decide in the
  spike.
- **Tool dispatch**: on `toolCall`, route by name:
  - UI tools → call back into app state setters (see below), respond immediately.
  - Data tools → `fetch` our `/api/calendar`, shape the result, respond.
- **Transcription**: surface `input`/`output` transcripts for the overlay.

### App integration (`App.tsx`)

Today `App.tsx` holds all view state (`mode`, `viewDate`, `selectedEvent`,
`enabledCalendars`, `filterOpen`, …) locally. The voice tools need to *call* those setters.
Options, cheapest first:

1. Lift the handful of needed actions into a small `useDashboardActions` object passed to
   `useVoiceSession` (no architecture change).
2. Only if this gets unwieldy, introduce a reducer/context for view state.

New/changed UI:

- Wire the **"Ask" button** ([App.tsx:163](../frontend/src/App.tsx)) to
  `voice.startTurn()` / `stopTurn()`; reflect the state machine (pulse while listening,
  spinner while thinking).
- **Voice overlay**: a transient surface (not a permanent panel) showing the live
  transcript and, when the assistant proposes a navigation, a one-line "Showing Friday,
  Sep 12" confirmation. Lives in / over the contextual right rail that `0002/0003`
  reserved for exactly this.
- **Mic-active indicator**: unmistakable dot/badge whenever the mic track is live
  (privacy).
- Error toasts: token failure, mic permission denied, session dropped.

### Initial tool set

UI-control (frontend-only, no backend):

| Tool | Effect |
| --- | --- |
| `show_home` | `mode = 'home'` |
| `show_week(date?)` | `mode = 'week'`, set `viewDate` |
| `show_month(date?)` | `mode = 'month'`, set `viewDate` |
| `focus_date(date)` | navigate the active view to a date |
| `highlight_event(query)` | select the best-matching visible event → opens `EventDetail` |
| `open_people_filter()` / `set_calendar_enabled(name, on)` | drive the People popover |

Data (calls our backend):

| Tool | Backend |
| --- | --- |
| `get_events(start, end, people?)` | `GET /api/calendar` |
| `get_agenda(day)` | `GET /api/calendar` for that day, condensed |
| `check_conflicts(day)` | `GET /api/calendar` + overlap check (frontend or a tiny helper) |

All read-only. `create_event` / `update_event` are explicitly **out of scope** here but the
schema should leave room for them.

## Testing

- **Backend**: monkeypatch the `google-genai` client so `auth_tokens.create` returns a
  fake token; test `/api/voice/token` for the happy path, `voice_enabled=false` (409),
  missing key (409), and non-LAN caller (403). Add the API-endpoint test file that
  `AGENTS.md` already flags as missing while we're in there.
- **Frontend**: mock `@google/genai`; unit-test the state machine transitions and the
  tool dispatcher (tool name → correct action / fetch). Test that the mic indicator
  tracks track state.
- **Playwright**: a `VITE_VOICE_FAKE=1` mode that swaps in a scripted fake session, so the
  overlay / button states / navigation-by-tool can be exercised without real audio.
- Real audio round-trip is verified manually on the kiosk (documented checklist).

## Rollout / phases

1. **Spike** — add deps; `/api/voice/token`; minimal `VoiceSession` that connects, streams
   mic, prints transcripts, plays audio. No tools. Confirm native-audio model id, voice,
   latency, and manual-activity behaviour. Throwaway UI.
2. **Tool layer** — tool schema + token constraints; frontend dispatcher; UI-control tools
   wired to dashboard actions; data tools wired to `/api/calendar`. "Show me Friday" works.
3. **Voice UX** — Ask-button wiring, state machine, transcript overlay in the rail, mic
   indicator, barge-in, brief TTS acknowledgements, error handling.
4. **Hardening + docs** — session-limit / reconnect handling, daily session cap, LAN gate
   tests, `AGENTS.md` update (voice section + the direct-connect deviation),
   `.env.example` (`GEMINI_API_KEY_MISSION_CONTROL`, `MISSION_CONTROL_VOICE_ENABLED`),
   `README.md` run notes.

## Open questions / requirements still needed

1. **Exact model id + region.** Which native-audio Live model (and API version /
   availability from our location) do we target? Needs a quick check against current
   Google docs at spike time.
2. **Voice & language.** Which prebuilt voice? English-only for now?
3. **Transcript persistence.** Show the last turn only and discard, or keep a short
   rolling on-screen history? (No disk persistence either way this milestone — there's no
   datastore yet.)
4. **Cost ceiling.** Do you want a hard daily cap on voice sessions / minutes enforced by
   the backend, and what number?
5. **Kiosk microphone.** What mic hardware is on the 27" unit, and does the kiosk browser
   grant mic permission persistently (Chrome policy / `--use-fake-ui-for-media-stream` is
   not acceptable in prod)?
6. **Wake word (future).** Preferred on-device engine to design toward (e.g. Porcupine,
   Web Speech API)? Affects how the activation boundary in the state machine is drawn.
7. **Failure posture.** If the token endpoint or Gemini is unreachable, is a disabled Ask
   button with a small "voice offline" note acceptable?
8. **Multi-surface.** Is there ever more than one Mission Control screen? If yes, later we
   may want voice on screen A to move screen B via `/api/ws` + `ApplicationMessage`. Out
   of scope now, but changes whether tool effects should also round-trip the backend.

## Explicitly out of scope for this milestone

Calendar writes / event creation by voice; wake-word / always-on mic; on-device / local
speech processing; conversation persistence; multi-language; speaker identification;
Home Assistant control tools; TTS reading full agendas aloud.

## What shipped

Backend:
- `app/config.py`: `gemini_api_key` (aliases `GEMINI_API_KEY_MISSION_CONTROL`),
  `voice_enabled`, `gemini_live_model`, `gemini_voice`, `gemini_language_code`,
  `voice_token_ttl_seconds`.
- `app/voice/`: `tools.py` (6 read-only tool declarations + `build_tools`), `prompt.py`
  (system instruction), `tokens.py` (`mint_token` → constrained `auth_tokens.create`).
- `app/models.py`: `VoiceToken`, `VoiceTokenRequest`.
- `POST /api/voice/token` in `api.py`, `_require_local`-gated; 409 when disabled / no key.
- `google-genai` dependency; `tests/test_voice.py` (4 tests, client faked).

Frontend (`src/voice/`):
- `pcm-capture-worklet.js` + `audio.ts` (16 kHz PCM16 mic capture, 24 kHz playback sink
  with flush-on-interrupt).
- `session.ts` (`GeminiVoiceSession`: token fetch → lazy `@google/genai` → `live.connect`
  with locked config → typed `VoiceEvent`s). `VoiceUnavailableError` (409) and
  `VoiceSessionError` (kind-tagged connect failure).
- `tools.ts` (`dispatchToolCall` — UI tools to `DashboardActions`, data tools to
  `GET /api/calendar`), `types.ts` (incl. `VoiceError { kind, message }`).
- `useVoiceSession.ts` (one-session-per-turn state machine:
  idle→connecting→listening→thinking→speaking→idle, plus error / unavailable). Every
  failed turn is classified (`disabled` / `network` / `microphone` / `session` /
  `unknown`); `microphone` failures map `getUserMedia` `DOMException.name`.
- `VoiceOverlay.tsx` transient status + transcript + retryable-error surface.
- `VoiceToast.tsx` — transient "toast" shown when a failure switches the Ask button off:
  headline per kind, the detail message, "Try again" (except `disabled`), ×, auto-dismiss.
- `App.tsx`: `voiceActions` + hook wired; **Ask** button toggles a turn, shows
  listening/thinking/speaking/"Voice off" (disabled only for `disabled` kind); a "Mic on"
  indicator; `<VoiceOverlay>` + `<VoiceToast>`.
- CSS in `App.css`; `tools.test.ts` + `useVoiceSession.test.ts` + `VoiceToast.test.tsx`
  (15 tests); `e2e/voice.spec.ts` (2 tests).

## Resolved open questions

1–2. **Voice/language** — `gemini_voice` (default `Zephyr`) and `gemini_language_code`
   (blank; English pinned in the prompt) are backend settings, easy to tune later.
3. **Transcripts** — last turn only; cleared at the start of each turn; nothing persisted.
4. **Cost ceiling** — none enforced. `voice_token_ttl_seconds` bounds how long a minted
   token is usable; add a session/day cap later if needed.
5. **Microphone** — assumes an integrated far-field mic with persistently granted
   permission; `getUserMedia` is requested per turn and the track stopped after.
6. **Wake word** — deferred. `useVoiceSession` exposes `startTurn()` / `stopTurn()`; a
   detector would call those instead of the button. No stub code beyond that seam.
7. **Failure source + recovery** — `useVoiceSession` classifies each failed turn:
   `disabled` (backend 409), `network` (token endpoint / SDK unreachable), `microphone`
   (`getUserMedia` denied / no device / busy — from `DOMException.name`), `session`
   (Gemini Live connect or mid-session `onerror`), `unknown`. First two strikes show a
   dismissable `VoiceOverlay` with the message and allow immediate retry. The third
   strike (or an immediate `disabled`) → `status: unavailable`, "Voice off" on the
   button, and a transient `VoiceToast` naming the reason. `disabled` disables the button
   until reload; any other kind keeps it tappable and the toast offers "Try again"
   (which resets the failure count).
8. **Multi-screen** — not built. `VoiceTokenRequest.surface` is accepted and threaded to
   `mint_token` (currently unused) so a future design can route by screen without an API
   change; tool effects are applied to local view state for now.

## Diagnostics (2026-09-05)

Push-to-talk latency / behaviour issues were investigated and partly fixed:

- **Transcription no longer re-spaces fragments.** `useVoiceSession` was trimming
  each Live transcription fragment and re-inserting separators by heuristic,
  which turned "What's tomorrow?" into "What 's to morrow?". Gemini streams
  VERBATIM fragments that already carry whitespace; they are now concatenated
  as-is. `inputTranscription` is the settled text; `interimInputTranscription`
  is shown only as a preview until settled text arrives.
- **Response audio is more robust.** The playback `AudioContext` no longer
  forces a 24 kHz rate (which throws on some browsers); odd-length PCM chunks no
  longer throw; a decode failure can't wedge the state machine in `speaking`;
  and a spurious `interrupted` outside `listening` no longer flushes the reply.
  Mic down-sampling now averages instead of decimating (less aliasing → better
  transcript + server VAD).
- **Instrumentation.** `frontend/src/voice/instrument.ts` (`VoiceTimeline`)
  stamps every turn milestone (`tap → token → sdk → live-open → mic-started →
  input-transcript-first → stop-tap → tool-call → tool-response →
  audio-first-chunk → turn-complete → turn-finished`) to the console; disable
  with `localStorage['voice.trace'] = 'off'`. **Update (2026-09-06):** the
  token-path snapshot and the ephemeral token are now cached — see
  `docs/voice-token-caching-notes.md`. `session.ts` also logs
  `setup-complete`, `usage`, `generation-complete`, `turn-complete-reason`,
  `model-text-part` / `model-other-part` / `unhandled-message`,
  `tool-call-cancelled` and `live-close` (with reason/code), so a turn that
  produces no audio can be diagnosed. `prewarmVoice()` pulls the lazy SDK chunk
  + worklet into cache on mount. Backend `app/voice/trace.py` logs the
  token-endpoint steps; the calendar-snapshot call on the token path is a known
  synchronous Graph request that should be cached.
- **Audio capture (debug).** `frontend/src/voice/debugRecorder.ts`
  (`voiceDebugRecorder`) retains the exact PCM the kiosk streamed to the speech
  provider for the last **10** activations (`sendAudio` chunks, in order, at the
  provider input rate — 16 kHz Gemini / 24 kHz relay). A push-to-talk capture
  begins at the first mic chunk; a wake capture leads with the pre-roll
  `useVoiceSession` flushes in (so it starts shortly before the keyword) and then
  the live mic. So it is a faithful recording of what the model got. **On by
  default.**
  - **In-browser:** `window.__voiceDebug` — no kiosk UI (per the wake section's
    "no debugging console in the kiosk UI"). `list()` (metadata —
    provider/model/outcome/transcript/chunk counts/seconds), `wav(id?)` /
    `wavBytes(id?)` / `samples(id?)`, `save(id?)` (downloads a `.wav`; newest if
    no id), `clear()`. Ring size is `localStorage['voice.debug.count']`.
  - **On disk:** each finished capture is POSTed to `POST /api/voice/debug/capture`
    (LAN-gated; `app/voice/debug_capture.py`), which writes
    `<stamp>-<ptt|wake>-<provider>.wav` (a real RIFF/PCM16 mono WAV, trivially
    played back) plus a `<stamp>-….json` sidecar under
    `MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR` (default `backend/voice-captures/`,
    git-ignored), pruned to `…_KEEP` pairs (default 10). Best-effort: the upload
    failing (backend down / off) leaves the in-memory ring untouched.
  - Off with `MISSION_CONTROL_VOICE_DEBUG_CAPTURE_ENABLED=false` (disk) or
    `localStorage['voice.debug.capture'] = 'off'` (both).
- **Response watchdog.** If the model makes no progress (audio, text, or a tool
  call) for 20 s after the user's turn, the session is torn down with a
  retryable error instead of hanging. This is a guard, not a fix.

### Root cause of the no-response failure (2026-09-05)

1. **Stale model.** The default `gemini-2.5-flash-native-audio-preview-09-2025`
   connected, transcribed, and made a tool call, then produced **no output at
   all** after the tool response (no audio / output-transcript / text part) and
   the socket closed after ~64 s with `code 1011 "Internal error encountered."`
   Default is now `gemini-2.5-flash-native-audio-preview-12-2025` — the current
   native-audio model, and the one in Google's ephemeral-token example.
2. **API version ↔ model coupling.** Ephemeral tokens work **only on `v1alpha`**
   (ai.google.dev/gemini-api/docs/ephemeral-tokens: "only works for the live
   API, and only with the v1alpha version"; the JS SDK warns the same at
   runtime). A detour to `v1beta` + `gemini-3.1-flash-live-preview` (which needs
   v1beta) gave `code 1008 "... not found for API version ..."`. So both sides
   stay on `v1alpha` and the model must be a native-audio *preview* id.
   `gemini-3.1-flash-live-preview` is unavailable to this flow until ephemeral
   tokens support v1beta.
3. **Tool response shape.** Now `{ output: <result> }` / `{ error: <message> }`
   per Gemini's `FunctionResponse` contract (was the raw dispatcher object).

⚠️ The env var overrides the default — if `backend/.env` still has
`MISSION_CONTROL_GEMINI_LIVE_MODEL=gemini-live-2.5-flash-preview` (a wrong id
tried mid-debugging), delete that line.

### Second live run (2026-09-05) — model works E2E, three new issues

With `...-12-2025` the whole turn completed (75 audio chunks / 245 KB arrived,
scheduled into a running context) but: (1) **17 s** from first mic chunk to
first transcript, (2) the overlay rendered pages of the model's **thinking
text**, then a rapid final append, (3) still no audible speech. Fixes:

- **Thinking.** `...-12-2025` is a thinking model and its reasoning streams as
  `modelTurn` **text parts**. `session.ts` no longer renders text parts (logs
  size only — the spoken reply is `outputTranscription`). Backend now sets
  `thinking_config = {thinking_budget: 0, include_thoughts: false}` — the ~10 s
  of inter-tool reasoning was pure latency for a look-up assistant.
- **Endpointing.** The user does not tap Stop, so automatic VAD must end the
  turn; default sensitivity took 17 s. Now `START/END_SENSITIVITY_HIGH`,
  `prefix_padding_ms: 300`, `silence_duration_ms: 700`.
- **Audio path.** `AudioSink` now routes through a `GainNode` (logs channel
  counts), schedules with a 120 ms lead, logs every 25th chunk + drain + flush,
  and — key — a `closing` socket event no longer tears the sink down while
  buffers are still playing (it marks the turn done and lets it drain, with a
  15 s safety net). A **test tone** (`localStorage['voice.testtone'] = '1'`)
  plays a 440 Hz beep on connect through the same graph — if that is silent too,
  the problem is the kiosk's audio output/route, not the code.

### Third live run (2026-09-05) — audio confirmed, latency still unusable

Audio was a **system-wide** output problem on the kiosk; once fixed, the reply
(and the test tone) play fine. But the turn took ~1 min: ~20 s "Listening",
transcript dumped all at once, ~10 s more before audio, and `show_view` put
nothing useful on screen. Fixes:

- **Client-side end-of-speech.** Service VAD still would not endpoint the turn
  (the `automatic_activity_detection` constraint may not be honoured through the
  ephemeral-token path). `useVoiceSession` now watches the mic RMS: once it has
  heard speech (`SPEECH_RMS 0.01`) and then ~1 s below it, it ends the turn
  itself; hard cap `MAX_LISTEN_MS 15 s`. Server VAD stays on as a backstop.
  `[voice] mic level` logs the RMS each second so the threshold can be tuned.
- **Thinking, again.** `thinking_config` was added but the run predated it —
  keep it (`thinking_budget 0`).
- **`show_view` was useless for "tomorrow".** The model called
  `show_view('home')`, and Home only shows *today*. `prompt.py` now tells it to
  call `show_view('week', <that date>)` for any day/date question so the day is
  actually on screen, and to keep tool calls to the minimum.
- **Listening cue** promoted to default (`playTestTone` on entering `listening`);
  off with `localStorage['voice.cue'] = 'off'`. Placeholder tone for now.

### Fourth live run (2026-09-05) — 8 s turn, two content bugs

Turn time down to ~8 s (client endpoint fired at 4.4 s, transcript 37 ms later,
audio 6.7 s). Remaining:

- **Timezone.** Backend runs in UTC; `datetime.now()` made the agent think it
  was already Sunday at 11:30 pm Saturday Pacific. The kiosk now sends
  `client_time` (local wall clock, no offset) + `timezone` (IANA label) with the
  token request; `prompt.py` stamps from that and says "do not convert to UTC".
  No server tz database needed (this Windows box has no `tzdata`).
- **"What's today" was useless.** The prompt (my earlier edit) forced
  `show_view('week', date)` for every day question — but Home is the right view
  for *today*, and the spoken reply was a content-free "here's the agenda".
  `prompt.py` now: today/tonight/now -> Home; other single day -> Week; and the
  agent must speak a brief real answer (count + notable items), not just a
  pointer to the screen. This walks back the strict "confirmation only" rule
  from the original plan — a voice user in passing wants to *hear* the answer.

### Fifth live run (2026-09-05) — model produced nothing, watchdog fired

Identical timeline up to `audio-stream-end` at 4.7 s, then **nothing** — no
input transcript, no tool call, no audio — until the 20 s watchdog. Clean 1000
close (server was fine; the model just didn't answer). Same "silent model"
shape as the first 1011. Mitigations:

- **Stray audio after `audioStreamEnd`.** The mic `onChunk` callback could fire
  once more after the turn ended and send a late audio frame, which invalidates
  the "end" and makes the service wait forever. It now checks the status ref
  (flipped synchronously in `endUserTurn`) and drops anything after `listening`.
- **Prompt simplified.** The bulleted decision-tree / pseudo-code version was
  replaced with short prose — less for a native-audio model to trip on.
- **Watchdog 20 s → 12 s** so a stall fails fast instead of a long dead wait.
- **`mic level` logs peak RMS** (not the instantaneous value) vs. the threshold.

### Sixth run + the fix: manual activity detection (2026-09-05)

The silent-turn failure was **consistent, not flaky**: 3 of 4 runs, the model
produced nothing after `audioStreamEnd` — no input transcript, no reply, clean
1000 close. RMS detection itself was working well (`peakRms 0.066` on speech vs
`0.001` quiet, threshold `0.01`).

Root cause: **automatic service VAD + a client `audioStreamEnd` is not a
reliable end-of-turn signal here.** Switched to **manual activity detection**:

- Backend: `automatic_activity_detection.disabled = true`.
- `session.ts`: `startActivity()` (`sendRealtimeInput({activityStart:{}})`)
  before the first mic frame; `endActivity()` (`{activityEnd:{}}`) when the
  RMS silence detector fires. `audioStreamEnd` / `endAudioStream()` removed.
- The kiosk now fully owns the turn boundary. `MAX_LISTEN_MS 15 s` still caps it.

If the model still stalls after this, the fallbacks are a backend WS proxy (so
we own the whole lifecycle) or text + a separate TTS call.

### Seventh run (2026-09-06) — everything works, everything is slow

A complete, correct push-to-talk turn ("set a five minute timer"): connected in
238 ms, transcribed, called `start_timer`, spoke a confirmation. It just took
21.7 s. Measured from the console timeline:

| Segment | Cost | What was happening |
|---|---|---|
| tap -> `mic-first-chunk-sent` | 437 ms | fine — token + snapshot caching is working |
| speech | ~2.1 s | |
| `SILENCE_HOLD_MS` | 1.0 s | client waiting out the pause |
| `activity-end` -> `input-transcript-first` | **5.67 s** | server produced nothing at all |
| -> `tool-call` | 232 ms | |
| `tool-response` -> `output-transcript-first` | **4.67 s** | our tool dispatch itself took 18 ms |
| -> `audio-first-chunk` | **3.87 s** | |
| audio delivery | 3.68 s wall for **1.7 s** of speech | ~0.46x real time |

So ~6.9 s from "stopped talking" to the timer visibly starting, ~15.6 s to hear
anything, four playback underruns, and no `interimInputTranscription` at any
point. A previous turn in the same session died to the 12 s watchdog.

**None of it was thinking** (`thinking_budget: 0` is honoured — no
`model-text-part` marks) and none of it was our backend. Four causes:

1. **The model was deprecated.** Google's Live API guidance now lists
   `gemini-2.5-flash-native-audio-preview-12-2025` under "deprecated and will be
   shut down — migrate to `gemini-3.1-flash-live-preview`". Sub-real-time audio
   generation and multi-second per-stage stalls are what a wound-down preview
   endpoint looks like.
2. **The v1alpha pin that forced it was based on a stale doc.** #2 in the
   2026-09-05 root-cause list above quoted the ephemeral-tokens page as
   "v1alpha". That page now says **v1beta**, and its JS example connects with
   `gemini-3.1-flash-live-preview`. (The `.md.txt` mirror of the same page still
   says v1alpha — it is behind the HTML.) The v1beta + Gemini 3.1 path that
   returned `code 1008` in September is the documented path now.
3. **Manual activity detection switched off the server's streaming recogniser.**
   With `automatic_activity_detection.disabled = true` the service does not
   transcribe as the audio arrives; it buffers the utterance and runs ASR once
   `activityEnd` lands. That is exactly the 5.67 s hole, and it is why
   `interimInputTranscription` ("low latency transcription updated while the user
   is speaking") never appeared once. The fourth live run, which still used
   service VAD, got its transcript **37 ms** after endpointing.
4. **`AudioSink` had no jitter buffer.** It scheduled each chunk 120 ms after
   arrival, which cannot work against a stream the API documents as "generated as
   quickly as possible, and not in real time". On underrun it logged, then
   scheduled the next chunk at `now + 120 ms` — re-opening the gap it had just
   reported.

Not a free-tier throttle in any actionable sense: `gemini-3.1-flash-live-preview`
is free-tier eligible, and Priority Inference (the paid low-latency tier) does not
cover the Live API, so there is no "pay to make Live fast" lever to pull. Billing
is still worth enabling for a kitchen microphone: free-tier traffic is used to
improve Google's products, paid-tier traffic is not, and paid tiers get capacity
ahead of free. At $0.005/min audio in, $0.018/min audio out and $0.75/1M text in,
this turn would have cost ~$0.002 ($0.0015 of that the 1,937-token system
prompt, which the token cache already amortises) — a couple of dollars a month at
kiosk volumes.

### Fixes shipped (2026-09-06)

- **Model / API version.** Default is now `gemini-3.1-flash-live-preview` on
  `v1beta`. The version is minted into the token *and returned on the token
  response*, and the browser opens its socket with what it was given — the two
  sides can no longer drift into a 1008. `MISSION_CONTROL_GEMINI_LIVE_MODEL` +
  `..._LIVE_API_VERSION` revert the pair together.
- **`thinking_level: "minimal"`** for Gemini 3.x (`thinking_budget: 0` is kept for
  a `gemini-2.*` model id — sending the wrong one is a setup error).
- **Hybrid VAD is the default.** The service VAD runs (so ASR streams under the
  audio) with `END_SENSITIVITY_HIGH` / `silence_duration_ms: 250`, and the kiosk's
  RMS detector now sends `audioStreamEnd` instead of `activityEnd` so the turn
  still finalises the instant *we* hear the pause. `MISSION_CONTROL_VOICE_MANUAL_ACTIVITY=true`
  restores the fully-manual path if the silent-turn failure comes back.
- **`SILENCE_HOLD_MS` 1000 -> 600.** Dead time on every turn.
- **Real jitter buffer.** `AudioSink` holds 450 ms before starting, schedules
  queued chunks contiguously off `cursor`, and on underrun re-buffers instead of
  scheduling into the gap. `finalizeStream()` releases the cushion at
  `turnComplete` so a reply shorter than 450 ms still plays. Covered by
  `frontend/src/voice/audio.test.ts`.
- **Truncation fix.** `pending()` now counts buffered-but-unscheduled audio.
  Under underrun the sink emptied four or five times mid-reply; a `turnComplete`
  or `closing` in one of those windows used to tear the session down and clip the
  answer.
- **Watchdog re-arms on `user-transcript`.** It previously only re-armed on
  assistant text, audio and tool calls, so a turn that transcribed late but was
  otherwise healthy could still be killed.

Still open, and needing a real kiosk to settle:

- **On-kiosk verification of all of the above.** None of it is testable from here.
  Watch the timeline for `token-received {apiVersion, manualActivity}`, then
  `input-transcript-first` relative to `audio-stream-end`.
- **Recognised text while the person is still speaking.** The conversational
  models do not emit `interimInputTranscription` — it is a
  `gemini-3.5-transcribe-live` feature. Hybrid VAD gets the transcript on screen
  at roughly end-of-speech + 1 s, ahead of the action, which is the actual bug;
  true live text needs a second recogniser. The cheap option is a parallel
  `gemini-3.5-transcribe-live` session fed from the *existing* shared `MicSource`
  (a second socket, not a second microphone — no new `getUserMedia`), ~$0.009/min.
  The Web Speech API is free but opens its own mic stream, which is the exact
  two-audio-stacks-per-device failure mode `MicSource` exists to prevent.
- **`transcript` lives in `App`-level state** (`App.tsx:314`), so every streamed
  fragment re-renders the whole dashboard while the audio socket is being pumped
  on the same thread. Suspected minor contributor to the 3.87 s
  transcript-to-audio gap; measure with a Performance profile before restructuring.

### Eighth run (2026-09-06) — the listening cue ended the turn

First run on `gemini-3.1-flash-live-preview`. It **connected clean** — `live-open`
88 ms after the SDK loaded, `setup-complete` at 1477 ms — then nothing came back
and the watchdog fired at 14.4 s. No tool call was attempted, because no speech
was ever sent.

**The cue is what ended the turn.** `playTestTone` schedules 440 Hz at
`currentTime + 0.05` for 0.4 s, so it sounds until ~t+1922 ms. The mic opened at
t+1594 ms and delivered its first frame at t+1688 ms — the last ~230 ms of the
tone went straight into the capture. Speaker and mic run on separate
`AudioContext`s, so browser echo cancellation never touched it, and the level
detector read **0.063 RMS, six times `SPEECH_RMS`**. That set `spoke`, and the
silence timer then ended the turn 700 ms after the mic opened:

    last voice 1787 ms + SILENCE_HOLD_MS 700* = 2387 ms = observed user-turn-end
    (* the run used 600 ms; see below)

The person had 699 ms from mic-open to start talking, and did not. The comment on
that line — "Cue first (through the speakers), then open the mic turn — so the
tone isn't captured as the start of the user's speech" — was simply wrong;
ordering the calls does not keep a 450 ms tone out of a mic that opens 120 ms
later. The same `peakRms: 0.063` at `listenedMs ~200` is in the *seventh* run's
log too. It has always been there; it only became fatal when someone did not
start talking immediately, and dropping `SILENCE_HOLD_MS` to 600 ms narrowed that
window from ~1.1 s to ~0.7 s.

Then a second defect turned a non-event into a hard failure: we sent
`audioStreamEnd` on an empty turn, the model correctly had nothing to answer, and
the 12 s response watchdog reported "The assistant stopped responding." The
session was healthy throughout — a `sessionResumptionUpdate` arrived at 2659 ms
and the socket closed 1000.

### Correcting the record on `gemini-3.1-flash-live-preview`

The instability in the 2026-09-05 notes was **`gemini-2.5-flash-native-audio-preview-09-2025`**
(root cause #1: connected, transcribed, called a tool, then produced nothing and
1011'd after ~64 s). 3.1 Flash Live was never assessed for tool calling — root
cause #2 records the only attempt, and it failed at `connect` with `code 1008
"... not found for API version ..."`, i.e. the model was not reachable on the
version we were using. It never opened a session, never transcribed, never
reached a tool call.

The eighth run settles the connectivity half: 3.1 Flash Live on `v1beta` **opens
and completes setup**. Its tool calling remains genuinely unverified — the run
that was supposed to test it never sent any speech. Treat "3.1 is unsuitable" as
unproven in both directions until a turn with actual audio in it comes back.

One thing that looks alarming and is not: the SDK logs *"The SDK's ephemeral token
support is in v1alpha only."* That check is
`if (apiVersion !== 'v1alpha') console.warn(...)` in `@google/genai` 2.21.0 and
guards nothing — the next line builds
`.../ws/google.ai.generativelanguage.${apiVersion}.GenerativeService.BidiGenerateContentConstrained`
either way. `setup-complete` proves the v1beta constrained endpoint accepted the
token. It is a stale string, like the stale `.md.txt` mirror of the docs page.

### Fixes shipped (2026-09-06, second pass)

- **The cue can no longer be heard as speech.** `playTestTone()` now returns how
  long it will sound; `startTurn` records `deafUntil = now + cue + 150 ms` and
  `handleLevel` ignores levels until then, restarting the listen window at the
  cue's end so `MIN_LISTEN_MS` / `NO_SPEECH_TIMEOUT_MS` measure the person rather
  than the tone.
- **`SILENCE_HOLD_MS` back to 700 ms** (from the 600 ms of the seventh-run pass).
  The 400 ms it saves is not worth the cut-off risk on a ~7 s problem.
- **A turn with no speech is abandoned, not failed.** `NO_SPEECH_TIMEOUT_MS`
  (5 s) ends a silent turn quietly back to idle instead of waiting out
  `MAX_LISTEN_MS`; neither it nor `max-listen-silent` submits to the model or
  arms the response watchdog. **An explicit Stop tap always submits** regardless
  of the threshold — a quiet voice that never crossed `SPEECH_RMS` is exactly
  when the person needs the tap to go through. (The existing watchdog tests
  caught this: the first cut swallowed tapped turns too.)
- **`waitingForInput` is handled** — the server saying "I am waiting for more
  input" now ends the turn quietly rather than being indistinguishable from a
  stall for 12 s. `sessionResumptionUpdate` no longer logs as `unhandled-message`
  on a perfectly healthy session.
- Regression coverage in `useVoiceSession.test.ts`: the cue at 0.063 RMS must not
  end the turn; real speech then a pause must; a silent turn must land on `idle`
  with no error and nothing armed.

### Ninth run (2026-09-06) — 3.1 Flash Live works; the underrun is the last problem

The turn was correct end to end and the cue fix held (`user-turn-end
{reason: 'silence', spoke: true}` at 5040 ms, after the person actually stopped).
Two things worth recording:

**3.1 Flash Live tool-calls fine.** Two calls in one turn — `get_events` then
`start_timer` with a computed `fires_at` ("10 min before storm game") — both
answered in ~340 ms and ~16 ms. That closes the question left open after the
eighth run. The "3.1 is unsuitable" note was always about the 09-2025 native-audio
model; nothing about 3.1's tool use has ever failed here.

**Hybrid VAD did what it was supposed to.** `input-transcript-first` landed at
4955 ms — *85 ms before* `user-turn-end`, i.e. the transcript is now on screen
while the person is still finishing, instead of 5.7 s after they stopped. This
was the single biggest user-facing complaint and it is fixed.

**The underrun got worse, not better.** 21 chunks, ~5.4 s of speech, delivered
between `audio-first-chunk` 10052 ms and `generation-complete` 30521 ms:

    5.4 s of audio / 20.5 s of wall clock = 0.26x real time  (was 0.46x)

The drains tell the shape: roughly 0.5-0.9 s of audio arrives, plays out, then
~2 s of nothing. Eight underruns. **A fixed 450 ms cushion cannot fix this** —
450 ms of audio buys 450 ms of playback and the next burst is two seconds away.
The seventh-run fix was the right mechanism at the wrong depth.

**And `turnComplete` never arrived**, which is what actually failed the turn. The
server holds it back until it believes playback has finished (the SDK documents
exactly this: "there will be delay between generation_complete and turn_complete
that is caused by model waiting for playback to finish"). On a reply arriving at
a quarter of real time it had not come 10.3 s after `generationComplete`, and the
response watchdog killed a turn that had already said everything it had to say.
The sink flushed with `stillQueued: 1` — the last chunk of the reply was dropped.

### The open question: whose fault is 0.26x?

Two mechanisms produce identical arrival timestamps and the log cannot yet tell
them apart:

1. **The server is generating slowly.** Nothing client-side will fix it; the
   answer is to buffer more, or to leave native-audio generation behind (see the
   split-pipeline option below).
2. **This thread is too busy to drain the socket.** The browser stops reading,
   TCP backpressure throttles the sender, and slow arrival is *self-inflicted*.
   Plausible here: `transcript` lives in `App`-level state and neither `WeekView`
   nor `MonthView` is memoised, so every streamed transcript fragment re-renders
   the whole calendar — and output transcription streams alongside the audio
   (`output-transcript-first` and `audio-first-chunk` were the same millisecond).

`MainThreadLagProbe` (`instrument.ts`) now settles it. It samples how late a
100 ms interval actually fires for the duration of the turn and the timeline
reports `main-thread-lag {maxLagMs, meanLagMs}` alongside
`audio-arrival {realtimeRatio, maxGapMs, underruns, prebufferMs}`.

- `maxLagMs` near zero while `realtimeRatio` stays ~0.26 → **server-bound**.
  Accept the buffering, or split the pipeline.
- `maxLagMs` in the hundreds → **we are starving the socket**. Memoise the
  calendar views and move `transcript` out of `App` state; expect the ratio to
  jump once the render work is off the message pump.

### Fixes shipped (2026-09-06, third pass)

- **Adaptive jitter buffer.** Depth starts at 450 ms, doubles on every underrun
  up to 3 s, and relaxes by 25% after a clean turn. It persists across turns
  (`learnedPrebufferSeconds`), so the second reply of a session starts with a
  cushion sized for this kiosk's actual link. On a 0.26x stream it settles at
  "wait for most of the reply, then play it perfectly", which is the right trade
  for a five-second spoken answer — a reply that starts 2 s late and is smooth
  beats one that starts instantly and stutters eight times.
- **`generationComplete` is now the end-of-audio signal**, not `turnComplete`.
  It releases the jitter buffer (`finalizeStream`) so the tail is never stranded,
  and starts a bounded `PLAYOUT_GRACE_MS` (20 s) play-out window instead of
  leaving the response watchdog to kill a finished turn.
- **`voiceActivity` is handled**, so the server's own VAD signals stop appearing
  as `unhandled-message` on a healthy session.
- Coverage: the underrun test now asserts the depth actually doubles, and
  `resetLearnedPrebuffer()` keeps the suite order-independent.

### Reverted: the adaptive jitter buffer (2026-09-06, fourth pass)

The Gemini Live path frequently had audible "beep"/click artifacts in its output.
The jitter buffer above is the prime suspect: on underrun it reset the playback
cursor to 0 and re-buffered mid-reply, so a single reply could stop and restart
several times, and each restart is a discontinuity the DAC can click on.

`AudioSink` is back to scheduling each chunk the moment it decodes, contiguously
off `cursor` — no prebuffer cushion, no `learnedPrebufferSeconds`, no
cursor-reset on underrun. `underruns` is still counted for the timeline but
nothing acts on it; `finalizeStream()` is a no-op kept for API compatibility.
`audio.test.ts` was rewritten to cover plain play-as-it-arrives scheduling. If a
slow stream stutters again, the fix is a *fixed* lead on the first chunk (hold N
ms once, never reset), not a re-buffering state machine.

If the probe says server-bound, the remaining option is to stop using a
native-audio model for the *speaking* half: `gemini-3.5-transcribe-live` or the
existing Live session for understanding plus a normal text model for the answer,
spoken by Gemini TTS or the browser's `speechSynthesis`. A kiosk with eight fixed
intents does not need audio-to-audio nuance, and a locally-synthesised reply
cannot underrun at all.

### Echo cancellation — phase 1 shipped (2026-09-07)

The cue-silencing workaround from the second pass (`deafUntil = now + cueMs +
150ms`, `handleLevel` deaf for that whole window) is **removed**. Root cause was
never the ordering — it was that Chromium's `getUserMedia({ echoCancellation:
true })` only folds *remote* peer-connection streams into the AEC reference, never
WebAudio playout, so the cue (and the assistant's own reply) hit the open mic
uncancelled.

Fix: `frontend/src/voice/aecPlayback.ts` — render `AudioSink` output into a
`MediaStreamAudioDestinationNode`, loop it through a local `RTCPeerConnection`
pair, play the far end through an `<audio>` element. Chromium now treats the
playout as a remote stream and cancels it from capture. `useVoiceSession` keeps
only a 250 ms `AEC_SETTLE_MS` for canceller convergence (no clock manipulation).
`getUserMedia` gains `autoGainControl: false` (the app has its own gain stage).

Also fixed alongside it: `OpenWakeWordDetector.suspend()` was dropping pre-roll
retention the instant a turn opened (`connecting`), seconds before the live mic
starts — so a single-shot "Mission Control, what's on today" lost everything after
the phrase. `suspend()` now stops inference only; `takeRetainedAudio()` ends
retention until `resume()`.

Phase 1 covers audio *this page* plays. Audio from other processes on the kiosk
box (a debug WAV in a media player, Windows sounds) needs **phase 2**: a Windows
backend audio worker capturing the mic + WASAPI render loopback as the reference,
running a real WebRTC APM, streaming clean PCM over `WS /api/voice/capture`;
`MISSION_CONTROL_VOICE_AEC_ENABLED` is the off switch for a hardware-AEC mic. Not
built — spike the APM binding (`webrtc-audio-processing` vs `speexdsp`) first.

### Tenth run (2026-09-07) — the quiet tail of a command was being cut off

`mission control, set a timer for five minutes` came back truncated at the "f" of
"five" (`user-turn-end {reason: 'silence', spoke: true}` ~1.7 s in, mid-word).
There was no acoustic gap — the waveform is continuous to the cut. The client
endpointer went deaf; the speaker never paused.

Cause: `handleLevel` refreshed "still talking" only on `rms >= SPEECH_RMS` (0.01,
absolute). Peak speech RMS that turn was 0.051, so the gate sat at 0.2x the
loudest speech — inside the utterance's own dynamic range. Prosodic declination
drops an unstressed final foot 15–20 dB under the stressed head, `autoGainControl:
false` means nothing levels it, and `noiseSuppression: true` dug the tail down
further, so "five minutes" fell under 0.01 for the whole 700 ms hold. Via wake
word the loud head of the phrase is mostly in the pre-roll / first live chunks, so
the endpointer only ever watches the quiet half — hence "voice-activation
specific".

Fixes:

- **Relative speech gate.** `handleLevel` tracks the turn's running peak RMS
  (clamped to `SPEECH_LEVEL_CEILING` 0.25) and, once `spoke` is armed, counts
  continued speech at `max(SPEECH_RMS_FLOOR 0.004, 0.12 x that)`. Arming `spoke`
  the first time stays absolute (`SPEECH_RMS`) so room noise can't open a turn.
  The `[voice] mic level` log now prints `gate` instead of the fixed `threshold`.
- **Provider VAD is the primary endpoint.** The relay forwards
  `input_audio_buffer.speech_started` / `speech_stopped` (from `semantic_vad` /
  `azure_semantic_vad`, which run for the echo canceller with `create_response`
  off) as `speech-started` / `speech-stopped` VoiceEvents. `speech-stopped` ends
  the user's turn (`reason: 'server-vad'`); after `speech-started` the mic-level
  check relaxes to `SERVER_VAD_BACKSTOP_MS` (2.5 s) instead of 700 ms. Semantic
  VAD does not endpoint an incomplete phrase ("set a timer for…"), which is
  exactly where a raw-energy detector fails.
- **`noiseSuppression: false`.** The loopback AEC (phase 1) handles echo now; NS
  was only hurting the endpointer. `autoGainControl` stays off.
- **AEC settle window keeps the silence clock fresh.** It still won't arm `spoke`
  or grow the speech-level estimate in the first 250 ms, but it now stamps
  `lastVoiceAtRef` each frame so the hold isn't already spent when the window
  lifts.

Coverage in `useVoiceSession.test.ts`: a quiet tail (0.009 after 0.06) keeps the
turn open where the old floor cut it; `speech-stopped` ends the turn; the
mic-level backstop waits longer once `speech-started` has arrived. In
`test_voice_relay.py`: both VAD signals translate.

Not touched, worth a look if this recurs: `azure_semantic_vad`'s
`silence_duration_ms` is still 500; if `speech-stopped` ever fires mid-phrase,
raise it there rather than re-tuning the client backstop.

## Follow-ups / not done

- Confirm the exact native-audio Live model id and region availability against current
  Google docs (the default is a best guess).
- No session-resumption / `goAway` recovery beyond "close and let the next tap reconnect".
- Manual on-kiosk verification of the real audio round-trip (no automated audio test).
- `@google/genai` adds a ~390 kB lazy chunk (loaded only on first use).
- **Cold-start latency: token + snapshot caching shipped 2026-09-06**
  (`docs/voice-token-caching-notes.md`). The remaining per-turn cost is the Live
  WebSocket handshake — lingering the session for fast follow-ups is the next
  step, written up there but deferred (needs on-kiosk audio testing).
