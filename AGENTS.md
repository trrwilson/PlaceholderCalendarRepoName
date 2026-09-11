# AGENTS.md

Durable context for coding agents (Claude Code, Copilot, Cursor, …). This file is read
at the **start of every session** — it carries only what applies to most tasks or what
an agent gets wrong without it. `.github/copilot-instructions.md` points here.

## Keep this file tight

- Add a line only when an agent has actually got something wrong; delete it when the
  convention changes. Treat it like code, not documentation.
- Describe **decisions and constraints, never mechanism.** If a sentence explains what
  the code does (event names, function names, control flow, config keys), cut it to a
  path reference.
- No status, no build history, no bake-off standings — those live in `docs/` or issues.
- **Budgets:** this file ≤ ~180 lines; each nested `AGENTS.md` ≤ ~150. Over budget →
  move something down a level or out to `docs/`.

## Read next, when the task touches that area

| File | Covers |
|---|---|
| `frontend/AGENTS.md` | UI/UX judgement: chrome, event legibility, holidays, colour |
| `backend/AGENTS.md` | Calendar providers, auth, persistence, real-time, feature stores |
| `backend/app/voice/AGENTS.md` | Voice assistant, local/hybrid pipeline, wake word |
| `docs/README.md` | Index of the deep-dive docs (design records vs history vs plans) |
| `docs/audio-pipeline.md` | The authority on mic capture, gain, and playout |

## What this project is

**Mission Control** is a touch-first household calendar dashboard for a wall-mounted
27-inch 4K touchscreen running a full-screen browser 24/7 — an *ambient household
appliance*, not a web app and not an Outlook/Google Calendar clone.

- The browser client is disposable and near-stateless: it renders provider-neutral
  calendar snapshots and owns only view state (mode, focused date, filters) and
  app-only presentation preferences (colour mode, week start, per-calendar colour).
- The server owns everything durable: provider access, OAuth tokens, household state,
  timers, lists, privacy state, and AI/audio processing. The one deliberate exception
  is the Gemini Live voice session, which the browser holds directly via a short-lived
  backend-minted token.
- The default calendar provider is an in-memory mock. Microsoft Graph *read* providers
  exist for an Azure AD tenant and for a personal outlook.com / hotmail.com account,
  configured entirely by backend env vars with no in-app account management. No
  frontend auth, no general datastore.
- Voice (tap-to-talk) answers schedule questions and drives the display. It **cannot
  write the calendar.** It has two narrow write exceptions — one kitchen timer and one
  grocery list — and can turn privacy mode *on* (never off). Wake-word activation is
  integrated but off by default.

## Repository layout

```
backend/                FastAPI service (Python 3.12+)
  app/main.py            ASGI app + CORS
  app/api.py             HTTP + WebSocket routes under /api; provider selection; LAN + privacy gates
  app/config.py          MISSION_CONTROL_* settings (pydantic-settings)
  app/models.py          Pydantic v2 domain + API models — the frontend/backend contract
  app/calendar/          CalendarProvider protocol + mock / Graph / personal-Outlook providers
  app/voice/             shared voice plumbing + providers/ adapters; local/ hybrid pipeline; wake*
  app/eufy/              eufy clip gallery: bridge client, event mapping, EufyEventService
  app/timers.py  app/lists.py  app/privacy.py    backend-owned feature stores
  tests/                pytest
frontend/               React 19 + TypeScript (strict) + Vite
  src/App.tsx           App shell + Home/Week/Month views + hand-written API types
  src/App.css           Design tokens + layout + semantic markers (single stylesheet)
  src/voice/            tap-to-talk session, audio pipeline, wake word, tools
  src/camera/            eufy clip gallery hook + mirrored types
  src/timers/  src/lists/  src/realtime/         feature UIs + one shared /api/ws socket
  e2e/                  Playwright kiosk-layout checks
eufy-bridge/            Node >= 24 sidecar wrapping eufy-security-client — not a Python dep,
                        spawned/supervised by app/eufy/bridge_process.py; see docs/eufy-sdk-integration.md
```

## Product & design principles

1. **Ambient appliance, not a web app.** Optimize each screen in this order: (a) what a
   person grasps in ~2s walking past from 6–10 ft; (b) what they can do in one or two
   touches at arm's length; (c) only then, information density.
2. **Two viewing distances.** Ambient: date/time, today's schedule, actionable status
   readable across a room. Interactive: richer detail on touch (progressive
   disclosure), not living on screen permanently.
3. **Prioritize NOW, NEXT, and UNUSUAL.** Actionable exceptions ("Garage open 43
   minutes") earn prominent space; normal status ("all quiet") earns little or none.
4. **Low cognitive load is not low information density.** The screen may be
   information-rich if the hierarchy is instantly clear. Whitespace builds hierarchy,
   distance readability, and touch targets — it never fills fixed-height containers or
   substitutes for content.
5. **One authoritative location per fact.** Never render the same date, time, nav, or
   status prominently twice. Region size follows real content; collapse sparse regions
   instead of stretching them.
6. **4K is for legibility, not desktop density.** Large crisp typography and semantic
   colour, not tiny controls or hover-dependent affordances.
7. **Distinct purpose-built modes.** Every normal mode fits a 16:9 kiosk viewport with
   no document-level scrolling at 3840×2160 and 1920×1080. Overlays/dialogs may scroll
   internally.
8. **The display is the assistant's output surface.** Voice navigates, highlights,
   proposes, and confirms within this UI — it never becomes a detached chatbot panel.

Before designing user-facing behaviour that someone outside this repo has almost
certainly shipped (a smart display, a family calendar, a shared list, a kiosk-lockdown
tool), do a short comparative pass — `docs/comparative-product-research.md` has the
method and a maintained catalogue.

## Architecture & boundaries

- **Provider-neutral domain.** Frontend and API speak only the models in
  `app/models.py`. Providers return those models, never SDK types, and convert
  timezone-aware datetimes to naive local time at the provider boundary.
- **`app/models.py` is the contract.** `App.tsx` re-declares the matching TypeScript
  types by hand — change both sides in the same commit. Field names are `snake_case`
  on both sides.
- **All domain datetimes are naive local time** for the household's location. Revisit
  only if the product ever spans time zones.
- **Persistence is deliberately minimal.** No datastore: state lives in process memory
  or single JSON files (MSAL token cache, `lists.json`, `privacy.json`). A SQLite store
  must drop in behind the existing shapes with no frontend change. Do not add a second
  store, Redis, Postgres, or a broker.
- **Real-time is one small typed endpoint** (`/api/ws`, `ApplicationMessage`), not an
  event bus. Keep any addition a small typed extension. See `backend/AGENTS.md`.
- **Unofficial third-party integrations** (eufy: `eufy-security-client`, against
  Anker's ToS) stay feature-flagged, isolated in their own package/sidecar, and
  severable — failure must never degrade the core calendar experience. Full
  account credentials server-side is heavier than this repo's other read-only
  OAuth flows; justified only when there is no official API. Any config value
  feeding a timer/interval must be validated against platform limits before
  shipping (a too-large `pollingIntervalMinutes` overflowed Node's 32-bit
  `setTimeout` and burst extra authenticated cloud calls — see
  docs/eufy-sdk-integration.md §5.6.1). The eufy clip gallery is the first
  capability that writes decrypted media to disk, however briefly (a
  short-lived, TTL-evicted cache, never persisted).
- **Voice/AI calls explicit application tools** (`get_events`, `start_timer`, …), never
  a provider directly. See `backend/app/voice/AGENTS.md`.
- **Privacy mode is a global read-only lock.** Every mutating endpoint calls
  `_require_unlocked()` after `_require_local()` (returns 423 while locked). A new
  mutating endpoint MUST add it. See `backend/AGENTS.md`.

## Conventions

- **Backend:** Python 3.12+, FastAPI, Pydantic v2, type hints throughout, async
  handlers where they help. Ruff (`ruff check`, `ruff format`) is configured in
  `pyproject.toml`. Keep modules small; avoid an interface with no foreseeable second
  implementation.
- **Frontend:** React + TypeScript strict + Vite, no component framework. Keep state
  local until real complexity demands otherwise. Pointer/touch-first — never rely on
  keyboard or hover for primary functionality (defensive Escape/`aria-*` is fine).
  Spacing/type/colour/touch sizes are CSS custom properties, not scattered magic
  numbers.
- **Both:** small, readable changes tied directly to the requested behaviour. No
  credentials, fake secrets, or vendor SDKs committed — secrets live in git-ignored
  `.env` files.
- **Bundled media** gets a one-line source + licence in `docs/credits.md`. **Trained
  model artifacts** additionally get their weights-vs-runtime licence and provenance
  recorded there (an MIT runtime says nothing about the weights); model binaries are
  provisioned per install, never committed.

## Testing expectations

Test meaningful behaviour, not a coverage number. Match the existing suites in
`backend/tests/` and `frontend/src/**/*.test.{ts,tsx}` + `frontend/e2e/`; when you
change behaviour, update its tests in the same change. Keep coverage for the domain
core: calendar range querying, model validation, category-vs-identity separation,
Graph mapping + tz conversion, the LAN and privacy gates, and the voice tool
locked-set. Real ML/ONNX models and live provider endpoints are validated on hardware
by scripts under `backend/scripts/`, never in CI.

## Definition of done

- `pytest` passes from `backend/`; `ruff check` and `ruff format --check` pass.
- `npm run test`, `npm run lint`, and `npm run build` pass from `frontend/`.
- `npm run test:e2e` (Playwright) passes when frontend behaviour or layout changed.
- No document-level scrolling in Home/Week/Month at 3840×2160 or 1920×1080.
- A new mutating API endpoint calls `_require_unlocked()` after `_require_local()`.
- Changes are small, readable, and scoped to the requested behaviour.

## Current non-goals (do not start without an explicit request)

Google Calendar, Home Assistant, frontend auth / account management, a real datastore
(SQLite / Postgres / Redis), Docker, message brokers, cloud infra. Voice-driven
calendar writes and conversation persistence. Multiple lists, list CRUD, aisle
grouping, an on-screen keyboard. Two-way calendar sync (the Graph providers are
read-only). Voice's cloud-text escalation and local TTS (extension points only — keep
its seams inside `app/voice/local/`). In-app privacy-PIN management, passphrases,
multiple privacy levels, presence-triggered privacy.
