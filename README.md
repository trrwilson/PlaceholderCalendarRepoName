# Mission Control

Mission Control is a touch-first household calendar dashboard designed for a full-screen
27-inch 4K wall display. It runs continuously in a kiosk browser and shows the household's
schedule for glanceable, ambient viewing. The current milestone exercises Home / Week /
Month navigation, agenda display, calendar identity colors, an event detail sheet, a
category-vs-person color mode, per-calendar identity color overrides, a configurable
start-of-week (default Monday), an on-kiosk calendar sign-in flow, and a minimal live
WebSocket connection.

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
- `backend/app/api.py`: HTTP calendar/health endpoints and the minimal WebSocket endpoint
  at `/api/ws`.
- `backend/tests/`: focused provider, model, and Graph-mapping tests.
- `AGENTS.md`: durable architecture, product constraints, conventions, and definition of
  done for future coding-agent work (`.github/copilot-instructions.md` points here).

Credentials, OAuth tokens, important household state, and future AI/audio/video processing
belong on the server. Future voice and AI work should call explicit application tools such
as `get_calendar_events` or `create_calendar_event`, never providers directly. There is no
persistence yet; SQLite is the natural next step.

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
```

The frontend targets pointer/touch interaction and does not depend on keyboard input.
