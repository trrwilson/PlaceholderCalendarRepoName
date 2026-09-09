---
status: historical
summary: How display_name is resolved per calendar provider.
---

# Natural account names — implementation notes

Added 2026-09-06 (scheduled task `name-updates`, executed headless).

## Goal

Calendar connections that come from a real account (personal Outlook, tenant
Graph) should surface the account holder's *natural* name — "Travis", not
"trrwilson" — everywhere a person is shown or spoken, alongside a small provider
badge.

## What changed

- **`HouseholdCalendar`** (`backend/app/models.py`) gains two fields:
  - `display_name: str` — the natural name. Empty in →filled by a model
    validator to `name`, so every existing construction still works.
  - `source: CalendarSource` (`mock` | `outlook` | `google`, default `mock`) —
    drives the kiosk's provider badge. `google` is defined but unused (no
    provider yet); it costs nothing and matches the roadmap.
  - `name` is unchanged: the raw handle (email local-part / UPN prefix / mock
    label), kept as a stable id and the last-resort fallback.
- **Name resolution order:** given/first name → full name → `name`.
- **`ProfileNameCache`** (`backend/app/calendar/graph.py`) — per-account, 1-hour
  TTL (misses cached too). Reads `GET /me?$select=givenName,displayName`
  (personal) or `GET /users/{id}?$select=…` (tenant). **Any** failure is
  swallowed and the caller falls back to `name` — a friendly name is never worth
  failing a snapshot. The broad `except Exception` is deliberate (also keeps the
  many `respx`-mocked provider tests green without each one stubbing `/me`).
- **Personal Outlook** additionally prefers the **ID-token claims** from the
  silent auth (`given_name`, then `name`) *before* calling `/me`. This is the
  reliable path: the existing sign-in only holds `Calendars.Read`, which usually
  cannot read `/me`. `_natural_name_for()` tries claims → `/me` → claims-full-name.
  `self._id_claims` is populated in `_acquire_token_silent`.
  - **Fixed 2026-09-06 (regression):** `acquire_token_silent` only echoes
    `id_token_claims` back when it actually refreshes over the network. On the
    common warm-cache hit (and the on-disk cache survives restarts) it returns
    just the access token, so `self._id_claims` stayed empty, `/me` 403'd, and
    the display name fell back to the raw handle (`sshapro`). Fix:
    `_cached_id_token_claims()` decodes the ID-token JWT that MSAL always has in
    its cache from the device-code sign-in, keyed by `home_account_id`;
    `_acquire_token_silent` uses it whenever the silent result carries no claims.
  - Personal Microsoft accounts (via the public "Graph Command Line Tools"
    client) carry only `name` in the ID token — no `given_name` — so the resolved
    display name is normally the **full name** ("Sarah Shapro"). First-name-only
    would need `/me` (an AAD work account, or the `User.Read` scope).
- **Voice:** `POST /api/voice/token` now seeds the prompt with `display_name`s,
  and `prompt.py` tells the model to refer to people by those names. The kiosk's
  `tools.ts` `fetchRange` maps `who` from `display_name || name`, so
  "what's next" answers say "Travis has…".
- **Frontend:** `Calendar` type gains optional `display_name` / `source`.
  `personName()` helper + `<ProviderBadge>` (inline SVG, no asset). Badge shown
  in the People filter, the Settings "Calendar colors" rows, the event-owner
  label, and the event detail sheet. Older snapshots without the fields render
  exactly as before.

## Decisions a human might want to revisit

1. **Did not add `User.Read` to `GRAPH_SCOPES`.** Expanding scopes would force
   the already-signed-in household to re-consent (silent-auth for a superset of
   scopes fails → "sign-in expired"), breaking the working setup while nobody is
   awake. ID-token claims cover the personal case well enough; if `/me` is
   wanted for the tenant provider, grant `User.Read.All` as an *app* permission
   out of band.
2. **`display_name` filled by validator, not required.** Keeps ~15 existing test
   constructions and any external callers working.
3. **`source` enum includes `google`** despite no Google provider (roadmap item;
   frontend badge is ready).
4. **Broad `except Exception` in `ProfileNameCache`.** Justified by "never break
   a snapshot for a display nicety" + test ergonomics; noted here in case a
   future reader wants it narrowed to `httpx.HTTPError` (then every mocked
   provider test must stub the profile route).
5. **Badge SVGs** are simplified provider marks drawn inline (Outlook = blue
   tile + "O"; Google = the 4-colour "G"). Swap for licensed brand assets if
   that ever matters. Logged in `docs/credits.md`.
