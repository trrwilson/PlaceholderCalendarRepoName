# AGENTS.md

Durable context for any coding agent (Claude Code, Copilot, Cursor, etc.) working in
this repository. Keep this file current; it is the single source of architectural,
product, and process truth. `.github/copilot-instructions.md` is a thin pointer to
this file.

## What this project is

**Mission Control** is a touch-first household calendar dashboard for a wall-mounted
27-inch 4K (3840x2160, 16:9) touchscreen running a full-screen browser 24/7. It is an
*ambient household appliance*, not a desktop web app and not an Outlook/Google Calendar
clone.

- The browser client is disposable and mostly stateless: it renders provider-neutral
  calendar snapshots and owns only view state (current mode, focused date, filters).
- The server owns everything durable: provider access, OAuth tokens, credentials,
  household state, and AI/audio/video processing — with one deliberate exception, the
  voice assistant's Gemini Live session, which the browser holds directly using a
  short-lived backend-minted token (see **Voice assistant** below).
- The default calendar provider is an in-memory mock. A configuration-driven Microsoft
  Graph (Outlook) provider also exists (`MISSION_CONTROL_CALENDAR_PROVIDER=graph`),
  app-only / read-focused, with no in-app account management. No persistence, no auth
  for the frontend yet.

An initial voice assistant now exists: tap-to-talk, Gemini Live (native audio),
read-only — it answers schedule questions and drives the dashboard. Long-term
direction (do **not** build until explicitly asked): a Google Calendar provider,
Home Assistant, wake-word activation, voice-driven calendar writes, and optional
local media processing. `.prompts/` holds the dated prompt history that produced the
repo and is useful background.

## Repository layout

```
backend/                FastAPI service (Python 3.12+)
  app/main.py            ASGI app + CORS
  app/api.py             HTTP + WebSocket routes under /api; provider selection
  app/config.py          MISSION_CONTROL_* settings (pydantic-settings)
  app/models.py          Pydantic v2 domain + API models (the contract)
  app/calendar/provider.py  CalendarProvider protocol + MockCalendarProvider
  app/calendar/graph.py  MicrosoftGraphCalendarProvider (tenant, app-only) + shared mapping
  app/calendar/outlook_personal.py  PersonalOutlookCalendarProvider (MSA, delegated/MSAL)
  app/calendar/personal_auth.py  device-code sign-in for the kiosk + CLI
  app/auth.py            `python -m app.auth {login,status,logout}` headless sign-in
  app/voice/            mints constrained Gemini Live ephemeral tokens (tokens/tools/prompt)
  tests/                 pytest
  .env.example           documented MISSION_CONTROL_* variables
  pyproject.toml
frontend/                React 19 + TypeScript (strict) + Vite
  src/App.tsx            App shell + Home/Week/Month views + helpers
  src/App.css            Design tokens, layout, semantic markers (single stylesheet)
  src/App.test.tsx       Vitest + Testing Library
  e2e/                   Playwright kiosk-layout checks
.prompts/                Historical build prompts (context, not instructions)
```

## Product & design principles

1. **Ambient appliance, not a web app.** Optimize each primary screen in this order:
   (a) what a person grasps in ~2 seconds walking past from 6–10 ft; (b) what they can
   do in one or two touches at arm's length; (c) only then, information density.
2. **Two viewing distances.** Ambient: date/time, today's schedule, and actionable
   status readable across a room. Interactive: richer detail and controls appear on
   touch (progressive disclosure) rather than living on screen permanently.
3. **Prioritize NOW, NEXT, and UNUSUAL.** Near-future household information beats
   treating every date/entity equally. Actionable exceptions (e.g. "Garage open 43
   minutes") earn prominent space; normal status ("all quiet") earns little or none.
4. **Low cognitive load is not low information density.** The screen may be
   information-rich if the hierarchy is instantly clear. Whitespace must separate
   useful information, build hierarchy, aid distance readability, or form touch
   targets — never substitute for content or fill fixed-height containers.
5. **One authoritative location per fact.** Do not render the same date, time,
   navigation, or status prominently twice. Let region size follow real content;
   collapse sparse regions instead of stretching them.
6. **4K is for legibility, not desktop density.** Large, crisp typography and semantic
   color, not tiny controls or hover-dependent affordances.
7. **Distinct purpose-built modes.** Home/Today, Week, Month now; Tasks and
   Home-control anticipated. Every normal mode must fit a 16:9 kiosk viewport with no
   document-level scrolling at 3840x2160 and 1920x1080. Overlays/dialogs may scroll
   internally.
8. **The display is the assistant's output surface.** Future voice should navigate,
   highlight, propose, and confirm within this UI — not become a detached chatbot
   panel. Keep the contextual region (right rail / detail sheet) able to host event
   detail, exceptions, and later assistant proposals with Confirm/Cancel.

## Semantic color

- **Calendar/person identity** is the dominant ambient signal and uses a fixed named
  palette (`CalendarColor`: coral, ocean, gold, fern, violet). **Event category** is a
  restrained secondary marker. Never paint one large surface with both classifications
  competing.
- Categories carry a stable id, display name, and a concrete `#rrggbb` color, without
  leaking provider SDK types into React. Names stay authoritative; accessibility and
  contrast beat exact provider colors.
- Calendar identity colors render through shared `.calendar-<name>` marker classes in
  `App.css` (swatches, dots, bars, event surfaces), so a new `CalendarColor` needs a
  token plus those rules. Category color is different: the provider resolves it to a
  hex value (`EventCategory.color`), the frontend passes that through a
  `--category-color` custom property, and `.category-dominant` / `.category-dot` /
  `.category-label` derive their fill (and a `color-mix` tint for event surfaces) from
  it — no per-color CSS. The Graph/personal-Outlook providers read the mailbox's
  `masterCategories` list and map each Outlook `presetN` swatch to hex
  (`_PRESET_HEX` in `graph.py`); a name missing from that list, or a mailbox the
  provider can't read categories from, degrades to the neutral `_NEUTRAL_CATEGORY_HEX`
  marker. Keep any new provider's category colors as hex with the same neutral fallback.
- Keep identity/category treatment consistent across Home, Week, Month, filters, and
  detail. Popovers dismiss on outside interaction, Escape, and navigation without
  swallowing intended inside clicks.

## Architecture & boundaries

- **Provider-neutral domain.** Frontend and API speak only the models in
  `app/models.py`. Providers (`MockCalendarProvider`, `MicrosoftGraphCalendarProvider`,
  `PersonalOutlookCalendarProvider`, a future `GoogleCalendarProvider`) return these
  models, never provider SDK types, and convert any timezone-aware datetimes to naive
  local time at the boundary. New providers satisfy the `CalendarProvider` protocol;
  seams are annotated with that protocol, not a concrete class. `api.py` picks the
  provider from `get_settings().calendar_provider` and caches it; each real provider is
  imported lazily so the mock path never needs `msal`/Graph credentials.
- **Two Microsoft providers, different auth.** App-only client-credentials only works
  for Azure AD tenants (`graph.py`). Personal accounts (outlook.com/hotmail.com) require
  delegated auth, so `outlook_personal.py` uses MSAL device-code sign-in and a
  git-ignored on-disk refresh-token cache (`MISSION_CONTROL_GRAPH_TOKEN_CACHE`), kept in
  sync across the provider, the CLI, and the sign-in poll thread via one process-wide
  MSAL client. Both providers share the event-mapping helpers in `graph.py` (imported by
  name) and are read-focused (`outlook_personal` raises on `create_event`).
- **Kiosk sign-in.** `personal_auth.py` runs the device-code flow non-blocking (a daemon
  thread blocks on MSAL; the kiosk polls `GET /api/calendar/auth`). `POST
  …/auth/device` starts it and returns the code + an `segno` QR data-URI;
  `DELETE …/auth/device` cancels; `DELETE …/auth` signs out. These endpoints are
  loopback/LAN-only unless `allow_remote_auth`. The frontend surfaces "needs sign-in" as
  a header pill + Home exception card and shows the code/QR in a sheet; credentials are
  never entered on the kiosk. Onboarding stays backend-config only — no account
  management UI, no multi-account.
- **Persistence.** No datastore yet; the MSAL token cache is a single JSON file. A
  SQLite-backed provider or token store should drop in behind the same protocol without
  any frontend change.
- **Real-time.** `/api/ws` is a deliberately small typed endpoint. Do not build a
  generalized event bus. `ApplicationMessage` in `app/models.py` is the intended
  server→client envelope; wire it when the first real push exists (today the endpoint
  only sends a hello).

## Voice assistant

Initial voice support (see `docs/voice-support-plan.md`). Tap-to-talk, **read-only** —
it answers schedule questions and moves the display; it cannot change the calendar.

- **Direct-connect via ephemeral token.** `POST /api/voice/token` (loopback/LAN-gated,
  409 unless `MISSION_CONTROL_VOICE_ENABLED`) calls Google's `auth_tokens.create` and
  returns a short-lived token with the model, system instruction, tools, voice, and
  transcription config **locked in**. The Gemini API key
  (`GEMINI_API_KEY_MISSION_CONTROL`, aliased in `config.py`) never leaves the backend.
  The kiosk opens the Gemini Live session itself (`frontend/src/voice/`), streaming mic
  audio and playing the reply; `@google/genai` is lazy-loaded.
- **One session per turn.** Simple and robust against Live session limits. A wake-word
  front end would call the same `startTurn()` / `stopTurn()` on the hook.
- **Classified failures + recovery.** `useVoiceSession` tags every failed turn with a
  `VoiceError.kind` (`disabled` / `network` / `microphone` / `session` / `unknown`).
  After 3 in a row — or an immediate `disabled` (backend 409) — `status` goes
  `unavailable`: the Ask button reads "Voice off" and a transient `VoiceToast` names the
  reason. `disabled` also disables the button until reload; every other kind stays
  tappable (and the toast offers "Try again"). `VoiceOverlay` shows the retryable
  `error` state before the third strike.
- **Tools = explicit application tools, never providers.** `backend/app/voice/tools.py`
  is the contract, mirrored in `frontend/src/voice/tools.ts`. `show_view` / `focus_date`
  / `highlight_event` mutate local view state only; `get_events` / `get_agenda` /
  `check_conflicts` are answered from `GET /api/calendar`. Agent code must never reach a
  calendar provider directly. Adding a tool = update both files (the backend copy is
  what gets locked into the token).
- **The display is the output surface.** Spoken replies are one-sentence confirmations;
  the dashboard carries the answer. The `VoiceOverlay` is transient, not a chat panel.
- `surface` is accepted on the token request and threaded through unused — reserved for
  a future multi-screen setup where one screen's command drives another.

## The frontend/backend contract

`app/models.py` is authoritative. `frontend/src/App.tsx` currently re-declares the
matching TypeScript types by hand — when you change a model, update both sides in the
same change, or generate types from the API's OpenAPI schema
(`http://localhost:8000/openapi.json`). Field names are `snake_case` on both sides.

## Time handling

All datetimes in the domain are **naive local time** for the household's location.
Providers that return timezone-aware datetimes must convert at the provider boundary
before constructing domain models. Revisit if the product ever spans time zones.

## Conventions

**Backend:** Python 3.12+, FastAPI, Pydantic v2, type hints throughout, async handlers
where they help. Ruff is configured in `pyproject.toml` (`ruff check`, `ruff format`).
Keep modules small; avoid interfaces with no foreseeable second implementation.

**Frontend:** React + TypeScript strict + Vite, no component framework. Keep state
local until real complexity demands otherwise. Pointer/touch-first; do not rely on
keyboard or hover for primary functionality (defensive Escape/`aria-*` handlers are
fine). Establish spacing/type/color/touch sizing as CSS custom properties rather than
scattering magic numbers.

**Both:** small, readable changes tied directly to the requested behavior. No
credentials, fake secrets, or vendor SDKs committed. Secrets live in git-ignored
`.env` files.

## Testing expectations

Test meaningful behavior, not a coverage number. At minimum keep coverage for:

- calendar time-range querying and mock-provider behavior
- domain-model validation (event time ordering, all-day boundaries, range ordering)
- category vs. calendar-identity classification staying separate
- Graph providers: event mapping, all-day handling, tz→naive conversion, pagination,
  token caching, missing-credential / not-signed-in errors (HTTP mocked with `respx`,
  MSAL exercised offline against a temp cache — no network)
- API endpoint behavior via `fastapi.testclient`: health, `/api/calendar` range params /
  defaults / reversed-range 422, and `/api/calendar/auth*` (state machine, local guard,
  provider guard) with MSAL patched
- meaningful frontend interactions (mode switching, event detail, filters, color mode,
  week start, calendar sign-in prompt + device-code sheet)
- voice: `/api/voice/token` (disabled → 409, missing key → 409, non-LAN → 403, minted
  token locks tools + calendar names) with the `google-genai` client faked; frontend
  tool dispatch and the `useVoiceSession` state machine with `@google/genai` mocked
- Playwright: each primary mode fits the kiosk viewport with no document overflow at
  3840x2160 and 1920x1080; the Ask button starts a turn, and a 409 disables it and shows
  the "Voice is turned off" toast. Unit: `VoiceToast` (headline per kind, retry only when
  recoverable, auto-dismiss) and `useVoiceSession` failure classification / retry.

## Definition of done

- `pytest` passes from `backend/`.
- `ruff check` and `ruff format --check` pass from `backend/`.
- `npm run test`, `npm run lint`, and `npm run build` pass from `frontend/`.
- Playwright (`npm run test:e2e`) passes when frontend behavior or layout changed.
- Changes are small, readable, and scoped to the requested behavior.
- No document-level scrolling in Home/Week/Month at 3840x2160 or 1920x1080.

## Current non-goals (do not start without an explicit request)

Google Calendar, Home Assistant, frontend authentication / account management,
persistence/SQLite, Docker, Redis, Postgres, message brokers, cloud infrastructure.
Voice exists but stays **read-only and tap-to-talk** — no voice-driven calendar
writes, no wake word / always-on mic, no conversation persistence, no local speech
processing without an explicit request. (Microsoft Graph *read* providers exist for
both tenant and personal accounts; do not expand them into write-heavy two-way sync
without being asked.)
