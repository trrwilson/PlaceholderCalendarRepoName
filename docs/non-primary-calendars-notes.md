---
status: historical
summary: Opt-in display of an account's non-primary calendars, plus a configured hide-list.
---

# Non-primary calendars — implementation notes

Added 2026-09-12.

## Goal

Every connected Outlook account was previously shown as exactly one calendar —
its default one. Real accounts usually carry more: a shared calendar, an
auto-added "Holidays" calendar, a hobby group, a "Tasks" list Outlook exposes
as a calendar. The ask was to surface these too, off by default so the wall
display doesn't get noisy, with an opt-in per calendar from the kiosk's people
flyout. A follow-up ask added a second, coarser knob: some non-primary
calendars (Outlook's auto-added "US Holidays" and "Your family", for this
household) are never a household member's own and should be dropped entirely
rather than left as an opt-in nobody wants.

## What changed

- **`HouseholdCalendar`** (`backend/app/models.py`) gains two fields:
  - `is_primary: bool` (default `True`) — `False` for a non-primary calendar.
  - `account_id: str | None` — for a non-primary calendar, the id of the
    primary calendar (account) it belongs to; lets the kiosk group "extra
    calendars" under the account they came from.
  - The existing `enabled: bool` field (previously always `True` and
    unused by any caller) now carries real meaning for a non-primary
    calendar: whether a household member has turned it on.
- **`app/calendar/secondary.py`** (new) — `SecondaryCalendarStore`, the
  "one JSON file, no datastore" pattern already used by `privacy.py` /
  `lists.py`: an atomic-replace JSON file of enabled non-primary calendar
  ids, no broadcast (the kiosk picks up a toggle on its next `GET
  /api/calendar` poll, same as it already does for a newly linked account).
  `MISSION_CONTROL_CALENDAR_SECONDARY_STATE_FILE` (default
  `secondary_calendars.json`); blank disables persistence.
- **Both Graph providers** (`app/calendar/graph.py`,
  `app/calendar/outlook_personal.py`) now additionally call `GET
  {mailbox}/calendars` per account, skip the default calendar (already
  covered by the existing `calendarView` call), and for each other one:
  - Build a non-primary `HouseholdCalendar` with id
    `{account}::{graph calendar id}` (the `::` also marks a calendar as
    non-primary — see `set_calendar_enabled`'s validation below) — always,
    regardless of enabled state, so the flyout can offer it.
  - Only call `calendarView` for that specific calendar (and merge its
    events in) once the secondary store says it's enabled. An account with
    many non-primary calendars nobody opted into costs one extra listing
    call, not N extra event-fetch calls.
- **`PUT /api/calendar/calendars`** (`backend/app/api.py`) — body
  `{calendar_id, enabled}`, LAN- and privacy-mode-gated like every other
  mutating calendar endpoint. Rejects a primary calendar's id (400). No
  broadcast; the frontend bumps its existing `reloadKey` poll-trigger after
  a successful call, the same mechanism `addCalendar`/`cancelConnect`
  already used.
- **`MISSION_CONTROL_CALENDAR_HIDDEN_NAMES`** (`Settings.calendar_hidden_names`,
  `Settings.is_calendar_name_hidden`) — comma-separated calendar display
  names (as Graph reports them), matched case-insensitively and
  whitespace-trimmed. A non-primary calendar whose name matches is skipped
  entirely in the loop above, before an id is even minted for it — it is
  never listed, never toggleable, and its `calendarView` is never called,
  regardless of what the secondary store says. This is a coarser, "never
  offer this" knob layered on top of the opt-in; the two aren't mutually
  exclusive (a calendar can be opted-in in the store from before it was
  added to the hide-list — the hide-list wins, since the loop skips it
  before checking the store).
- **Frontend** (`frontend/src/App.tsx`) — the People flyout nests a
  primary calendar's non-primary calendars as indented `.filter-subrow`
  rows directly under it, each wired straight to `PUT
  /api/calendar/calendars` (not the pre-existing per-browser
  `enabledCalendars` show/hide filter, which is a different, client-only
  concept). The "N/M shown" count and Settings' calendar-colour picker now
  only count a calendar once it's actually part of the household display
  (every primary calendar, plus a non-primary one only once enabled) — the
  seeding effect that auto-shows a newly-seen calendar id now checks
  `calendar.enabled !== false` first, so a not-yet-opted-in (or hidden)
  calendar doesn't silently become "shown" the moment it's first fetched.
- **`app/calendar/provider.py`** — `MockCalendarProvider` gained one demo
  non-primary calendar (`family::holidays`, disabled by default, one seed
  event) so the opt-in flow is exercisable without real Outlook. It does not
  take `Settings`, so it does not participate in the hidden-names filter —
  that knob only applies to the two real Graph providers.

## Decisions a human might want to revisit

1. **The hide-list is a name filter, not an id filter.** Chosen because
   the two calendars a household member actually wants gone ("US
   Holidays", "Your family") are Outlook-managed calendars every personal
   account gets, with stable *names* but not portable across accounts —
   matching by name catches the same auto-added calendar on every linked
   account (both `sshapro@live.com` and `trrwilson@hotmail.com` carry a
   "Your family" calendar) with one config entry. The trade-off: a
   household member who deliberately names their own calendar "Your
   family" would also get it hidden. Nothing today disambiguates that.
2. **No UI for the hide-list.** Unlike the opt-in (which needed to be
   reachable without editing config), a "never offer this" list was asked
   for as configuration, not a toggle — so it's `.env`-only
   (`MISSION_CONTROL_CALENDAR_HIDDEN_NAMES`), read once at process start.
   Changing it needs a backend restart.
3. **`MicrosoftGraphCalendarProvider` (tenant, app-only) got the same
   treatment as `PersonalOutlookCalendarProvider`** even though this
   household only runs the personal provider, to avoid the two Graph
   providers drifting apart on a shared code shape. Untested against a
   real tenant mailbox.
4. **No websocket push for a visibility change.** `ApplicationMessage`
   already declares an unused `snapshot` field (see
   `docs/lists-plan.md`-style precedent for reusing the envelope), but
   calendar data has only ever been polled, never pushed; wiring a push
   here felt like scope creep for what a `reloadKey` bump already handles
   adequately on the one screen that changed it.

## Two live bugs found and fixed the same day

Both real Outlook accounts (`trrwilson@hotmail.com`, `sshapro@live.com`) had
already had a few non-primary calendars opted in via direct API calls before
the frontend toggle ever shipped, which is how both of these surfaced
immediately on the host once households actually used the feature:

1. **One malformed event took down the whole snapshot.** `_map_event`
   (`app/calendar/graph.py`) raised straight out of
   `CalendarEvent`'s `end_follows_start` validator when Graph returned an
   all-day event whose `end` was not after its `start` — real data from one
   of Sarah's opted-in calendars had one. Because `snapshot()` builds the
   whole `CalendarSnapshot` in one pass, that one bad event turned into a 500
   on every `GET /api/calendar` call, for every account, for any date range
   that included it — which from the kiosk looked like "nothing I tap in the
   People flyout does anything" (the toggle's `PUT` succeeded, but the
   `reloadKey`-triggered refetch that's supposed to show the result never
   came back). Fixed by having `_map_event` catch `ValidationError` and
   return `None` for that one event instead of raising; both providers now
   filter `None`s out of `events.extend(...)` rather than letting one
   mailbox's bad data fail every other calendar's snapshot too.
2. **A calendar shared between household members duplicated itself.** Sarah's
   mailbox had a calendar named "Travis Wilson" — Travis's own calendar,
   shared into her account (a normal Outlook feature, e.g. so a partner can
   see it from their own sign-in). The non-primary listing had no way to
   distinguish that from a calendar of Sarah's own, so it showed up nested
   under her row with the same name as Travis's real primary calendar, and
   toggling it on double-counted his events. Fixed by adding `owner` to the
   `$select` on `GET {mailbox}/calendars` and skipping any calendar whose
   `owner.address` doesn't match the mailbox being listed
   (`is_foreign_calendar` in `app/calendar/graph.py`) — a calendar owned by
   someone else is that person's own calendar, already shown as their
   primary, not a new one to offer.
