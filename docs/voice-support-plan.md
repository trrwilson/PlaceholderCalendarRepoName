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

## Follow-ups / not done

- Confirm the exact native-audio Live model id and region availability against current
  Google docs (the default is a best guess).
- No session-resumption / `goAway` recovery beyond "close and let the next tap reconnect".
- Manual on-kiosk verification of the real audio round-trip (no automated audio test).
- `@google/genai` adds a ~390 kB lazy chunk (loaded only on first use).
