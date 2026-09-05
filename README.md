# Homebase

Homebase is a touch-first household calendar dashboard designed for a full-screen 27-inch 4K wall display. The first milestone uses realistic in-memory calendar data and already exercises month navigation, agenda display, calendar colors, and a minimal live WebSocket connection.

## Architecture

- `frontend/`: React + TypeScript + Vite disposable display client. It requests provider-neutral calendar snapshots from the backend and owns only view state.
- `backend/app/models.py`: Pydantic domain and API models shared by the backend boundary.
- `backend/app/calendar/provider.py`: small provider boundary with `MockCalendarProvider`; future Microsoft Graph and Google implementations should return these models rather than provider SDK types.
- `backend/app/api.py`: HTTP calendar/health endpoints and the minimal WebSocket endpoint at `/api/ws`.
- `backend/tests/`: focused provider and model behavior tests.
- `AGENTS.md`: durable architecture, product constraints, conventions, and definition of done for future coding-agent work (`.github/copilot-instructions.md` points here).

Credentials, OAuth tokens, important household state, and future AI/audio/video processing belong on the server. Future voice and AI work should call explicit application tools such as `get_calendar_events` or `create_calendar_event`, never providers directly. No external integrations or persistence are included yet; SQLite is the natural next persistence step.

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

Open `http://localhost:5173`. The frontend expects the API at `http://localhost:8000`; set `VITE_API_URL` in a local `.env` if needed.

## Validation

```powershell
cd backend
pytest

cd ..\frontend
npm run test
npm run lint
npm run build
```

The frontend currently targets pointer/touch interaction and does not depend on keyboard input.