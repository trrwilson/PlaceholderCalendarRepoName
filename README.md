# Mission Control

Mission Control is a touch-first household calendar dashboard designed for a full-screen
27-inch 4K wall display. It runs continuously in a kiosk browser and shows the household's
schedule for glanceable, ambient viewing. The current milestone exercises Home / Week /
Month navigation, agenda display, calendar identity colors, an event detail sheet, a
category-vs-person color mode, and a minimal live WebSocket connection.

## Architecture

- `frontend/`: React + TypeScript + Vite disposable display client. It requests
  provider-neutral calendar snapshots from the backend and owns only view state.
- `backend/app/models.py`: Pydantic domain and API models shared by the backend boundary.
- `backend/app/calendar/provider.py`: the `CalendarProvider` protocol with the in-memory
  `MockCalendarProvider` (default).
- `backend/app/calendar/graph.py`: `MicrosoftGraphCalendarProvider` — configuration-driven,
  app-only (client-credentials) read access to one or more Outlook mailboxes, mapped to the
  same domain models.
- `backend/app/config.py`: `MISSION_CONTROL_*` settings (provider selection + Graph
  credentials), read from the environment and an optional `.env` file.
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

By default the backend serves in-memory mock data. To serve live Outlook calendars, copy
`backend/.env.example` to `backend/.env` and set `MISSION_CONTROL_CALENDAR_PROVIDER=graph`
plus the `MISSION_CONTROL_GRAPH_*` values. The `.env.example` file documents the Azure app
registration prerequisites (an app registration with the **application** Graph permission
`Calendars.Read` and admin consent). Onboarding is entirely backend configuration; there is
no in-app account management yet.

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
