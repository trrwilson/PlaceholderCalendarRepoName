# Mission Control — frontend

React 19 + TypeScript (strict) + Vite. The disposable kiosk display client: it renders
provider-neutral calendar snapshots from the backend and owns only view state and
app-only presentation preferences.

## Develop

```powershell
npm install
npm run dev        # http://localhost:5173, expects the API at http://localhost:8000
```

Set `VITE_API_URL` in a local `.env` if the API is elsewhere. See the repo root
`README.md` for the full two-process setup.

## Check

```powershell
npm run test       # Vitest + Testing Library
npm run lint
npm run build
npm run test:e2e   # Playwright kiosk-layout checks; run when behaviour or layout changed
```

## Working here

Read `../AGENTS.md` (repo root) and `AGENTS.md` (this directory) first — the latter is
the durable UI/UX judgement (persistent chrome, event legibility, holidays, semantic
colour) that the code does not make obvious.

- `src/App.tsx` — app shell + Home / Week / Month views, and the hand-written
  TypeScript mirror of `backend/app/models.py` (keep both sides in sync).
- `src/App.css` — the single stylesheet: design tokens, layout, semantic marker
  classes. Spacing/type/colour/touch sizes are CSS custom properties.
- `src/voice/` — tap-to-talk session, audio pipeline, wake word, tools.
- `src/timers/`, `src/lists/`, `src/realtime/` — feature UIs over one shared `/api/ws`
  socket.
