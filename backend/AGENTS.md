---
name: Mission Control backend
description: Providers, auth, persistence, the real-time envelope, and the timer/list/privacy stores.
---

# Backend — providers, state, real-time

FastAPI + Pydantic v2, Python 3.12+. Read the repo-root `AGENTS.md` first. This file
carries the durable boundary rules; build history is in `docs/` (see `docs/README.md`).

## Calendar providers

- New providers satisfy the `CalendarProvider` protocol (`app/calendar/provider.py`);
  seams are annotated with the protocol, never a concrete class. `api.py` selects the
  provider from `get_settings().calendar_provider` and caches it; real providers are
  imported lazily so the mock path needs no `msal` / Graph dependencies.
- **`HouseholdCalendar` identity:** `name` (raw handle + stable id + last-resort
  fallback), `display_name` (the account holder's natural name, resolved best-effort —
  any lookup failure falls back to `name`; never fail a snapshot for a name), and
  `source` for the provider badge. People-facing surfaces and voice show/speak
  `display_name`. Detail: `docs/natural-names-notes.md`.
- **Two Microsoft providers, different auth.** `graph.py` is app-only
  client-credentials — Azure AD tenants only. `outlook_personal.py` is MSAL
  device-code for personal accounts, with a git-ignored on-disk token cache kept in
  sync across the provider, the CLI, and the poll thread via one process-wide MSAL
  client. Both share the event-mapping helpers in `graph.py` and are read-only
  (`create_event` raises).
- **Kiosk sign-in** (`personal_auth.py`, `/api/calendar/auth*`): the device-code flow
  runs non-blocking on a daemon thread; the kiosk polls. Endpoints are loopback/LAN
  only unless `allow_remote_auth`. Credentials are never entered on the kiosk.

## Persistence

No general datastore. Durable state is single JSON files — the MSAL token cache,
`lists.json` (`app/lists.py`), `privacy.json` (`app/privacy.py`) — atomic write,
reloaded at startup, corrupt file reseeds. A SQLite-backed store must drop in behind
the existing store shapes with no frontend change. Do not add more stores, Redis,
Postgres, or a broker.

## Real-time (`/api/ws`)

A deliberately small typed endpoint — **not an event bus.** `ApplicationMessage` in
`app/models.py` is the server→client envelope; `app/realtime.py` is a tiny connection
registry + `broadcast()`. The timer and list stores push typed messages on this one
channel, and the socket sends the current timers + lists on connect. One shared
frontend connection (`frontend/src/realtime/appSocket.ts` + `useAppSocket`) feeds both
`useTimers` and `useLists`. Keep any further push a small typed extension of the
envelope — no second socket, no bus.

## Feature stores — timer / list / privacy

All three are process singletons in the same mould (injected clock + broadcast, no
socket import), `_require_local`-gated, and `_require_unlocked`-gated on every mutation.

- **Timers** (`app/timers.py`, `docs/timer-plan.md`): one active timer, in-memory — a
  restart clears it (accepted). No feature flag. Creating a timer while one exists
  **replaces it silently**; every result/broadcast carries `replaced`. The six-hour
  cap lives in three places: the Pydantic model (source of truth), the voice tool
  check, and the touch dial. `DELETE /api/timers/{id}` is the one mutation allowed
  while privacy-locked, and only when that timer is `fired`.
- **Lists** (`app/lists.py`, `docs/lists-plan.md`): one grocery list, and unlike
  timers it is **durable** — persisted to `MISSION_CONTROL_LISTS_FILE` (a wall
  appliance that forgets the list on reboot is broken UX). One list only; no list
  CRUD or aisle grouping (root non-goals).
- **Privacy mode** (`app/privacy.py`, `docs/privacy-mode-plan.md`): a houseguest state
  that redacts specifics (event/list title, location, category → `•••`; the when / how
  many / whose stay) and locks the appliance read-only behind an on-screen PIN. One
  household-global flag drives both. **A social / glance barrier, not a security
  control** — physical access defeats it.
  - `_require_unlocked()` returns **423 Locked** while locked and is called after
    `_require_local()` on every mutating endpoint. **A new mutating endpoint MUST add
    it** (Definition of Done).
  - The voice session is not gated (the assistant still answers) but every tool is
    refused while locked except `request_privacy_unlock` and `enter_privacy_mode`.
    Voice can turn privacy mode *on*, never *off* (a spoken PIN would defeat it).
  - Redaction is a render choice on the frontend, not a data change — unlock is
    instant. A blank `MISSION_CONTROL_PRIVACY_MODE_PIN` disables the whole feature.

## The contract

`app/models.py` is authoritative. `frontend/src/App.tsx` re-declares the matching
TypeScript types by hand — change both sides in the same commit, or generate from
`http://localhost:8000/openapi.json`. Field names are `snake_case` on both sides.
