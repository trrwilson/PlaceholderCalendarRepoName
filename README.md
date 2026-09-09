# Mission Control

Mission Control is a touch-first household calendar dashboard designed for a full-screen
27-inch 4K wall display. It runs continuously in a kiosk browser and shows the household's
schedule for glanceable, ambient viewing. The current milestone exercises Home / Week /
Month navigation, agenda display, calendar identity colors, an event detail sheet, a
category-vs-person color mode, per-calendar identity color overrides, a configurable
start-of-week (default Monday), an on-kiosk calendar sign-in flow, a minimal live
WebSocket connection, a dedicated kitchen-timer tab (backend-owned, one active timer),
and a voice assistant (tap-to-talk plus dormant local wake word) that answers schedule
questions, drives the display, and controls the timer — but never writes the calendar.

## Architecture

- `frontend/`: React + TypeScript + Vite disposable display client. It requests
  provider-neutral calendar snapshots from the backend and owns only view state.
- `backend/app/models.py`: Pydantic domain and API models shared by the backend boundary.
- `backend/app/calendar/provider.py`: the `CalendarProvider` protocol with the in-memory
  `MockCalendarProvider` (default).
- `backend/app/calendar/graph.py`: `MicrosoftGraphCalendarProvider` — configuration-driven,
  app-only (client-credentials) read access to Azure AD tenant mailboxes, mapped to the same
  domain models.
- `backend/app/calendar/outlook_personal.py`: `PersonalOutlookCalendarProvider` — delegated
  (MSAL device-code) read access to a personal outlook.com / hotmail.com account.
- `backend/app/calendar/personal_auth.py` + `/api/calendar/auth*`: the device-code sign-in
  the kiosk drives (status polling, start, cancel, sign out); `python -m app.auth
  {login,status,logout}` is the headless equivalent.
- `backend/app/config.py`: `MISSION_CONTROL_*` settings (provider selection + credentials),
  read from the environment and an optional `.env` file.
- `backend/app/api.py`: HTTP calendar/health endpoints, the `/api/timers` control surface,
  and the WebSocket endpoint at `/api/ws` (calendar + timer push).
- `backend/app/timers.py`: the in-memory single-timer store and `asyncio` scheduler.
- `backend/app/voice/` + `POST /api/voice/token`: mints a short-lived, capability-locked
  grant for the selected voice provider — a Gemini Live ephemeral token the kiosk uses
  directly, or a single-use ticket for the Azure relay (`WS /api/voice/live`) or the
  local pipeline (`WS /api/voice/local`). `backend/app/voice/local/` is the on-device
  STT + intent/entity pipeline; `frontend/src/voice/` holds the session, audio, wake
  word, and tools. `docs/audio-pipeline.md` is the authority on capture/playout.
- `backend/tests/`: focused provider, model, Graph-mapping, timer, and voice tests.
- `AGENTS.md`: durable architecture, product constraints, conventions, and definition of
  done for future coding-agent work (`.github/copilot-instructions.md` points here).

Credentials, OAuth tokens, important household state, and AI/audio/video processing belong
on the server. Voice and AI work calls explicit application tools (`get_events`,
`get_agenda`, `start_timer`, …), never providers directly. There is no persistence yet;
SQLite is the natural next step.

## Local development

Create the backend environment and install dependencies:

```powershell
cd backend
python -m venv .venv
.\.venv\Scripts\Activate.ps1
python -m pip install -e ".[dev]"
```

Run the API in one terminal:

```powershell
cd backend
python -m uvicorn app.main:app --reload --port 8000
```

Run the display in a second terminal:

```powershell
cd frontend
npm install
npm run dev
```

Open `http://localhost:5173`. The frontend expects the API at `http://localhost:8000`; set
`VITE_API_URL` in a local `.env` if needed.

### Using a real Outlook calendar

By default the backend serves in-memory mock data. Onboarding a real calendar is entirely
backend configuration — copy `backend/.env.example` to `backend/.env` — with no in-app
account management. Two providers exist:

- **Personal account** (outlook.com / hotmail.com): set
  `MISSION_CONTROL_CALENDAR_PROVIDER=outlook_personal` and `MISSION_CONTROL_GRAPH_CLIENT_ID`
  (a "personal Microsoft accounts" app registration with public client flows enabled — no
  client secret, no tenant admin). Then sign in once, either from the kiosk itself (it
  shows a "Calendar sign-in" prompt with a QR code and a device code — scan with a phone,
  sign in there, approve access) or headless from `backend/`:

  ```powershell
  python -m app.auth login     # enter the printed code at microsoft.com/devicelogin
  python -m app.auth status
  ```

  The refresh token is cached to `MISSION_CONTROL_GRAPH_TOKEN_CACHE` (git-ignored) and
  renewed silently; you only re-sign-in if it is revoked, and the kiosk prompts when that
  happens. Read-only. The `/api/calendar/auth*` endpoints are loopback/LAN-only unless
  `MISSION_CONTROL_ALLOW_REMOTE_AUTH=true`.

- **Azure AD tenant** (work/school mailboxes): set `MISSION_CONTROL_CALENDAR_PROVIDER=graph`
  plus the `MISSION_CONTROL_GRAPH_*` tenant/client/secret/users values. Needs an app
  registration with the **application** Graph permission `Calendars.Read` and admin consent.

`backend/.env.example` documents every variable and the registration steps for both.

### Enabling the voice assistant

Voice is off by default. In `backend/.env` set `MISSION_CONTROL_VOICE_ENABLED=true` and
configure at least one provider. Credentials stay on the backend — the kiosk gets only a
short-lived grant from `POST /api/voice/token` (loopback/LAN-only, same as calendar
sign-in). Tap **Ask** in the header, speak, tap again to finish. The assistant answers
schedule questions, moves the display, and controls the kitchen timer; it cannot change
the calendar.

`MISSION_CONTROL_VOICE_PROVIDER` picks who handles a turn (also switchable at runtime in
Settings). It is a bake-off — see `docs/voice-provider-bakeoff-plan.md`:

- `gemini` (default): browser-direct Gemini Live (native audio). Provide a key as
  `GEMINI_API_KEY_MISSION_CONTROL` (from Google AI Studio; `MISSION_CONTROL_GEMINI_API_KEY`
  also works). Verify the native-audio model id against current Google documentation.
- `azure_openai_realtime` / `azure_openai_realtime_mini` / `azure_voice_live`: run through
  the backend relay; fill in the matching `MISSION_CONTROL_AZURE_*` block.
- `local` (experimental): on-device STT + intent/entity interpretation, cloud only for
  genuine reasoning. Degrades to a text bypass when no STT engine is installed. See
  `docs/local-voice-plan.md` and `docs/local-stt-evaluation.md`.

Each provider 409s until its own credential block is filled in. Local "Mission Control"
wake-word activation is integrated but off by default and needs `MISSION_CONTROL_WAKE_WORD_ENABLED=true`
plus a trained model asset — see `docs/wake-word-plan.md`. `backend/.env.example`
documents every variable.

The wake detector is a two-way bake-off (`openwakeword` | `azure`), orthogonal to
the voice provider (`MISSION_CONTROL_WAKE_WORD_PROVIDER` / Settings → "Keyword
provider").

Independent of that, the **on-device Invoke gate** can be layered in front of the
selected detector: the `invoke-gate` daemon on a Harman Kardon Invoke
(`ReInvoke2026 wakeword/`) runs a loose first stage and only streams real audio
after a candidate; the selected detector then re-checks it and both must agree.
**Off by default** — turn it on via Settings → "On-device audio gate",
`MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_ENABLED=true`, or
`PUT /api/voice/wake-config {"invoke_gate_enabled": true}`. Needs
`MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST=<ip>`. Run the device side with
`ReInvoke2026 wakeword/harness/invoke_gate.sh up|down|status`. See
`docs/wake-word-provider-bakeoff.md` and `ReInvoke2026 wakeword/RUN_END_TO_END.md`.

## Validation

```powershell
cd backend
pytest
ruff check .
ruff format --check .

cd ..\frontend
npm run test
npm run lint
npm run build
npm run test:e2e   # Playwright; when frontend behavior or layout changed
```

The frontend targets pointer/touch interaction and does not depend on keyboard input.
