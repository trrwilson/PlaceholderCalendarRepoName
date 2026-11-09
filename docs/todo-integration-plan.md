---
status: future
summary: Data-source vetting and implementation sketch for showing Microsoft To Do tasks (issue #5). Not built.
---

# Mission Control: To Do tasks — integration plan

Issue: trrwilson/PlaceholderCalendarRepoName#5 ("To Do Items Listed"). Related, not a
duplicate: #3 (project planner; in-app multi-step projects, an unsolved data source).

**Requirement as refined:** show tasks from household members' **Microsoft To Do**
accounts in a Home summary and on a dedicated To Do mode. Show due dates; colours
match the rest of Mission Control; **never** mix tasks into the Home/Week/Month
calendar displays. The backend keeps a cached local copy that it updates
incrementally ("rolling"), like the calendar providers. **Read-only to start.**

This is research and design only. Nothing here is built.

> **Evidence note.** This session's network could not reach `learn.microsoft.com`,
> so the official pages are cited by URL but were checked through search-engine
> extracts, not read in full. Each claim is marked **[doc]** (stated on an official
> Microsoft or Google page as seen in extracts), **[community]** (Microsoft Q&A /
> third-party, no official statement found), or **[verify]** (unconfirmed; the live
> validation script in §7 must settle it before build). Re-read the cited pages
> before implementing.

---

## 1. Summary and recommendation

| Candidate | Personal (outlook.com) accounts | Incremental sync | Verdict |
|---|---|---|---|
| **Microsoft To Do via Graph** (`/me/todo/...`) | Yes, delegated `Tasks.Read` | `lists/delta` + per-list `tasks/delta` | **Recommended.** The source the household already uses. |
| Microsoft Planner (`/planner`) | **No** (work/school only) | `delta` exists only in beta | Not relevant for this household. Revisit only for #3 on a work tenant. |
| Outlook tasks (`/me/outlook/tasks`, `baseTask` beta) | — | — | **Deprecated/retired.** Do not use. |
| Google Tasks API | Google accounts | No delta; `updatedMin` polling | Documented fallback only (and Google is a root non-goal). |

Recommended shape: a new, feature-flagged, read-only **`TodoProvider`** that reuses the
personal-Outlook MSAL client and token cache, adds `Tasks.Read` to the requested
scopes, and runs a background delta-sync loop into an in-memory snapshot with delta
tokens persisted in one JSON file. Tasks get their own API route, their own
`ApplicationMessage` push, a Home summary tile and a To Do appliance mode. They
never enter `CalendarSnapshot`.

---

## 2. Phase 1: data-source vetting

### 2.1 Microsoft To Do (Microsoft Graph v1.0): recommended

**Endpoints** (all delegated, under `https://graph.microsoft.com/v1.0`):

| Purpose | Request |
|---|---|
| All lists the user can see | `GET /me/todo/lists` |
| List-level change tracking | `GET /me/todo/lists/delta` |
| Tasks in one list | `GET /me/todo/lists/{listId}/tasks` |
| Task-level change tracking | `GET /me/todo/lists/{listId}/tasks/delta` |
| Checklist (sub-steps) | `GET /me/todo/lists/{listId}/tasks/{taskId}/checklistItems` (or `$expand=checklistItems` on the tasks list) |
| Linked resources | `GET .../tasks/{taskId}/linkedResources` (or `$expand`) |

Docs: [todoTask delta](https://learn.microsoft.com/en-us/graph/api/todotask-delta),
[todoTaskList delta](https://learn.microsoft.com/en-us/graph/api/todotasklist-delta),
[todoTask resource](https://learn.microsoft.com/en-us/graph/api/resources/todotask),
[todoTaskList resource](https://learn.microsoft.com/en-us/graph/api/resources/todotasklist),
[list lists](https://learn.microsoft.com/en-us/graph/api/todo-list-lists),
[To Do API overview](https://learn.microsoft.com/en-us/graph/api/resources/todo-overview).

**Fields that matter** (`todoTask`) **[doc]**:

- `id`, `title`, `body` (itemBody), `importance` (`low` | `normal` | `high`)
- `status`: `notStarted` | `inProgress` | `completed` | `waitingOnOthers` | `deferred`
- `dueDateTime`, `startDateTime`, `reminderDateTime`, `completedDateTime`: each a
  `dateTimeTimeZone` (`{ "dateTime": "...", "timeZone": "..." }`)
- `isReminderOn`, `recurrence` (patternedRecurrence), `hasAttachments`
- `categories`: `string[]` of category **names**
- `createdDateTime`, `lastModifiedDateTime`, `bodyLastModifiedDateTime`
- relationships: `checklistItems` (`displayName`, `isChecked`), `linkedResources`
  (`webUrl`, `applicationName`, `displayName`), `attachments`, `extensions`

`todoTaskList` **[doc]**: `id`, `displayName`, `isOwner`, `isShared`,
`wellknownListName` (`none` | `defaultList` | `flaggedEmails` | `unknownFutureValue`).

**Incremental sync (delta).** Standard Graph delta semantics
([delta query overview](https://learn.microsoft.com/en-us/graph/delta-query-overview)) **[doc]**:

1. First call returns pages linked by `@odata.nextLink`. The last page carries an
   `@odata.deltaLink`. Query parameters (`$select`, page size) are encoded into the
   token, so the follow-up call is the opaque link verbatim.
2. Later calls to the stored `deltaLink` return only added/changed tasks, plus
   deleted ones as `{ "id": ..., "@removed": { "reason": "deleted" } }`.
3. Changing `$select` or the request shape invalidates the token **[community]**.

There is **one task delta token per list** plus one for `lists/delta`. A household
with 3 accounts × 6 lists keeps ~21 tokens: trivial in a JSON file.

**Token lifetime / resync.** Microsoft publishes **no fixed TTL** for Outlook-family
delta tokens (To Do is stored in Exchange Online). An expired or invalid token comes
back as **HTTP 410 Gone** with codes such as `syncStateNotFound` / `resyncRequired` /
`SyncStateInvalid` **[community]**:
[Q&A: mailbox delta token expiry](https://learn.microsoft.com/en-us/answers/questions/5881861/delta-token-expiry-on-microsoft-graph-mailbox-delt).
Design consequence: treat a token as a cache, not a checkpoint. On 410, **drop that
token and re-baseline that one list** (one full delta round) and replace the list's
cached tasks wholesale. Never retry the dead link. A fresh baseline is cheap at
household scale, so also re-baseline on any parse surprise. **[verify]** the
observed lifetime on a personal account; the live script records it.

**Completed tasks.** Delta includes completed tasks. The cache keeps them (status
`completed`) so a task ticked on a phone disappears/strikes through on the next pass
rather than lingering. Filtering is a presentation choice (§4).

**Is `$filter` allowed on delta?** Do not rely on it. Filter client-side. **[verify]**
whether `$select` is honoured on To Do delta (it is on most delta resources).

**Auth and scopes** ([permissions reference](https://learn.microsoft.com/en-us/graph/permissions-reference),
[merill: Tasks.Read.Shared](https://graphpermissions.merill.net/permission/Tasks.Read.Shared)):

| Scope | Meaning | Personal MSA |
|---|---|---|
| `Tasks.Read` | Read the signed-in user's tasks and task lists, **including lists shared with them** | Yes (delegated) **[doc]** |
| `Tasks.Read.Shared` | "Read user and shared tasks". Historically the Outlook-tasks scope for shared *folders*; no To Do method lists it as least-privileged | Not needed **[doc/community]** |
| `Tasks.ReadWrite` | Needed later to check tasks off (§5) | Yes |
| `Tasks.Read.All` / `Tasks.ReadWrite.All` (application) | App-only, work tenants only; per the To Do pages application permissions are not supported on the list endpoints (Planner uses them) | No **[verify]** |

**Verdict on scopes: request `Tasks.Read` only.** Shared To Do lists already appear in
`/me/todo/lists` for the member they were shared with (`isShared: true`,
`isOwner: false`). `Tasks.Read.Shared` adds nothing for To Do.

**Several household members.** Two viable models:

- **A. Several signed-in accounts (recommended default).** Each member signs in once
  through the existing kiosk device-code flow. This already supports adding further
  accounts; `snapshot()` iterates `get_accounts()`. Tasks are attributed to their
  owner, which is what "user colours" needs.
- **B. One account + shared lists.** Members share lists with one signed-in account.
  Works, but attribution is only per list (all items look like the hub account's),
  and To Do list sharing between *personal* accounts has known join failures
  **[community]**: [Microsoft support: why can't I join a shared list](https://support.microsoft.com/en-US/ToDo/why-can-t-i-join-a-shared-list).
  Sharing between a personal and a work account is not supported.

Either way, a shared list appears under **every** member who can see it, with the
same task ids. The provider must **de-duplicate by list id** (keep the owner's copy
when `isOwner`), or a shared "Groceries" list shows twice.

**Personal account vs Azure AD.** `/me/todo` is delegated-only for our purposes. The
existing app-only `graph.py` (client credentials) **cannot** read To Do. The
**`outlook_personal.py` / `personal_auth.py` MSAL device-code path is the one to
extend.** The same flow works against an Azure AD tenant authority if the household
ever moves (`MISSION_CONTROL_GRAPH_AUTHORITY`).

**Can the existing MSAL client + token cache add `Tasks.Read`?** Yes, in principle,
with caveats:

- The default client is Microsoft's first-party **Microsoft Graph Command Line Tools**
  app (`DEFAULT_DEVICE_CLIENT_ID`), which uses dynamic consent: requesting
  `["Calendars.Read", "Tasks.Read"]` in `initiate_device_flow` shows a consent prompt
  that includes tasks. **[verify]** that this first-party client grants `Tasks.Read`
  to a *personal* account without an error. If it does not, set
  `MISSION_CONTROL_GRAPH_CLIENT_ID` to a household app registration (public client,
  "personal Microsoft accounts" audience, delegated `Calendars.Read` + `Tasks.Read`).
  No secret is needed; it is a public client.
- One MSAL cache holds tokens per (account, scope set). `acquire_token_silent(["Tasks.Read"])`
  can mint a tasks token from the **same refresh token** once the user has consented
  to that scope. A household member who signed in before the scope was added has
  **not** consented, so silent acquisition fails until they sign in again. The kiosk
  must surface "re-sign-in needed for To Do" through the existing auth-status
  pattern, **without** marking the calendar disconnected (failure isolation).
- Change: `GRAPH_SCOPES` becomes a requested set built from enabled features
  (calendar always, tasks when `todo_enabled`). Keep token acquisition per feature
  so a missing tasks consent never breaks calendar tokens.

**Categories and colours.** To Do tasks carry category *names* only. Outlook stores
categories per mailbox in the master category list
(`GET /me/outlook/masterCategories`), which `CategoryColorCache` in `graph.py` already
reads and resolves `presetN` → hex. Because To Do lives in the same Exchange mailbox,
task category names *should* resolve against that same list, so a "Kids" category
gets the same colour on a task as on an event. **Catch:** `masterCategories` needs
`MailboxSettings.Read` / `Calendars.Read`-class access, which the calendar token
already has. Reusing the calendar token (or the shared `CategoryColorCache`) for the
lookup avoids a new scope. **[verify]** (a) that To Do category names match master
categories exactly (case-insensitive, the existing cache casefolds), and (b) that
the To Do apps expose categories at all for personal accounts (they are often only
set from Outlook). Unknown categories degrade to the neutral marker, as for events.

**Time zones.** `dueDateTime` is a `dateTimeTimeZone`. In practice To Do returns
`timeZone: "UTC"`, and a due date is set as a *date* (midnight in the user's zone,
shifted to UTC), so a naive UTC read can land on the **previous day**. Rules for the
provider boundary (root AGENTS.md: naive local time):

1. Convert with the existing `_to_local_naive({dateTime, timeZone})` helper in `graph.py`
   (resolves Windows/IANA names, converts to the household zone, drops tzinfo).
2. Expose `due_on: date` (the local date) as the primary field; most To Do due dates
   carry no meaningful time. Keep `due_at` only if the live script shows tasks with
   real times.
3. **[verify]** whether `Prefer: outlook.timezone="..."` (sent by the calendar
   provider) is honoured by `/me/todo`. Do not depend on it; convert explicitly.

**Throttling** ([throttling limits](https://learn.microsoft.com/en-us/graph/throttling-limits)):
Outlook-service limits apply per **app ID + mailbox**: 10,000 requests / 10 min and 4
concurrent requests **[doc for Outlook; community that To Do counts as Outlook]**.
Throttled calls return **429** with `Retry-After`. Household budget: a 60 s sync of
1 lists-delta + ~8 task-deltas per account ≈ 90 req / 10 min / mailbox, under 1% of
the limit. Because delta responses are near-empty when nothing changed, 30–60 s is
safe. Honour `Retry-After`, run requests per account sequentially, and back off
exponentially on 5xx.

**Limitations:** delegated-only (a person must sign in, and consent can lapse); no
documented delta TTL; flagged-email list (`wellknownListName: flaggedEmails`) is
noisy and should probably be hidden by default; checklist items are not in the delta
payload unless expanded **[verify]**; change notifications (webhooks) exist for
`todoTask` but need a public HTTPS endpoint, so they are a non-starter for a LAN
kiosk. Polling delta is the right mechanism.

**Verdict: use it.**

### 2.2 Microsoft Planner (`/planner`): not relevant

- Endpoints: `/me/planner/tasks`, `/planner/plans/{id}/tasks`, `/groups/{id}/planner/plans`.
- Auth: delegated `Tasks.Read` / `Group.Read.All` on **work/school accounts only**.
  Personal-account delegated access is listed as *not supported* **[doc]**
  ([create plannerPlan](https://learn.microsoft.com/en-us/graph/api/planner-post-plans?view=graph-rest-1.0),
  [Q&A: Planner for personal accounts](https://learn.microsoft.com/en-us/answers/questions/5416967/planner-for-personal-accounts)).
- Plans belong to Microsoft 365 Groups; `planner/delta` is beta-only **[verify]**.
- **Verdict:** irrelevant to a household on outlook.com accounts. Planner's buckets
  and assignees are a natural fit for #3 (projects), but only if the household had an
  M365 business tenant. Note this on #3; don't build on it.

### 2.3 Outlook tasks (`/me/outlook/tasks`, beta `baseTask`): retired

The old Outlook Tasks API and the beta `baseTask`/`baseTaskList` (with its own
`delta`) are deprecated in favour of `/todo`
([baseTask delta (deprecated)](https://learn.microsoft.com/en-us/graph/api/basetask-delta?view=graph-rest-beta)).
**Verdict:** do not use.

### 2.4 Google Tasks API: documented fallback only

- Endpoints: `GET https://tasks.googleapis.com/tasks/v1/users/@me/lists`,
  `GET /tasks/v1/lists/{tasklist}/tasks`
  ([Google Tasks API reference](https://developers.google.com/tasks/reference/rest)).
- Auth: OAuth 2.0, scope `https://www.googleapis.com/auth/tasks.readonly`. A
  limited-input device flow exists but restricts scopes; Tasks is **[verify]**.
- Incremental sync: **no delta tokens.** Poll `tasks.list` with `updatedMin=<last sync>`
  plus `showDeleted=true&showHidden=true`, and reconcile tombstones yourself.
- Fields: `due` is RFC 3339 but **date-only in practice** (the time portion is
  discarded); no categories, no importance; subtasks via `parent`.
- **Verdict:** workable fallback with weaker sync and no category colours. Google is
  a root non-goal, so build nothing for it now. The provider-neutral task model below
  should not preclude it.

---

## 3. Phase 2: backend sketch

### 3.1 Model (`app/models.py`, mirrored by hand in `App.tsx`)

```python
class TaskStatus(StrEnum):
    not_started = "not_started"; in_progress = "in_progress"; completed = "completed"
    waiting = "waiting"; deferred = "deferred"

class TaskImportance(StrEnum): low = "low"; normal = "normal"; high = "high"

class TaskList(BaseModel):
    id: str                  # provider list id (stable)
    name: str                # displayName
    owner_id: str            # HouseholdCalendar.id of the owning account (person identity)
    is_shared: bool = False
    is_default: bool = False
    enabled: bool = True     # viewer/household toggle, like secondary calendars

class TaskItem(BaseModel):
    id: str
    list_id: str
    title: str
    status: TaskStatus
    importance: TaskImportance = TaskImportance.normal
    due_on: date | None = None        # local household date (naive)
    completed_at: datetime | None = None  # naive local
    category: EventCategory | None = None # reuse: name + resolved #rrggbb
    checklist_total: int = 0
    checklist_done: int = 0
    has_note: bool = False            # body present; body itself not shipped by default

class TaskSnapshot(BaseModel):
    lists: list[TaskList]
    tasks: list[TaskItem]
    synced_at: datetime | None        # naive local; drives a stale-data warning only
    status: Literal["ok", "stale", "needs_sign_in", "disabled"]
```

Person identity comes from `owner_id` → the same `HouseholdCalendar` the calendar uses,
so a task inherits the person's palette colour (including the viewer's per-calendar
remap in `localStorage`). Category reuses `EventCategory`, so the same
`--category-color` CSS path works.

### 3.2 Provider and sync loop

- New package `app/todo/` (`provider.py` protocol + `mock.py` + `graph_todo.py` +
  `store.py`), so a failure cannot touch `app/calendar/`.
- `TodoProvider` protocol: `baseline(list_id)`, `delta(list_id, link)`,
  `lists_delta(link)`. It returns already-mapped `TaskItem`s / `TaskList`s plus the next link.
- `TodoSyncService` (same mould as the feature stores: injected clock + broadcast, no
  socket import) owns a daemon thread or asyncio task:
  1. every `todo_sync_interval_seconds` (default 60), per signed-in account:
     `lists/delta` → add/remove lists; then each enabled list's `tasks/delta`;
  2. apply `@removed` / upserts to the in-memory map keyed by `(list_id, task_id)`;
  3. on 410 → drop that link, re-baseline that list; on 401/consent error → mark
     that account `needs_sign_in`, keep its last cached tasks (marked stale);
     on 429 → sleep `Retry-After`; other errors → exponential backoff, cap ~10 min;
  4. if anything changed, `broadcast(ApplicationMessage(type="tasks", ...))`.
- **Durable state:** `todo_state.json` (`MISSION_CONTROL_TODO_STATE_FILE`) holds the delta
  links per list and the last task snapshot. Write it atomically, reload at startup so
  Home is populated before the first Graph call, and reseed (full baseline) if it is
  corrupt. Same pattern as `lists.json` / `privacy.json`. No new datastore. The file
  holds task titles, so it is git-ignored like the token cache.
- **Feature flag:** `MISSION_CONTROL_TODO_ENABLED=false` by default; also
  `todo_provider: Literal["mock","graph"]`, `todo_hidden_list_names` (default hides
  `flaggedEmails`). Disabled → no thread, no scope requested, route returns `disabled`.
- **Failure isolation:** the calendar never awaits the To Do sync; a To Do exception
  is caught at the loop boundary and only changes `TaskSnapshot.status`. Token
  acquisition for tasks uses its own scope set, so a missing `Tasks.Read` consent never
  sets `outlook_personal.auth_error` (which drives the calendar's sign-in warning).
  Track it in a separate `todo_auth_error`.

### 3.3 Routes (`app/api.py`)

- `GET /api/tasks` → `TaskSnapshot`. Read-only: `_require_local()`. Redaction under
  privacy mode is a frontend render choice, like events and lists.
- `PUT /api/tasks/lists/{id}/enabled` (if per-list toggles are wanted) is **mutating**:
  `_require_local()` then `_require_unlocked()`. Persisted in `todo_state.json`.
- `/api/ws` on connect also sends the current tasks; push `tasks` on change. This is
  one small typed extension of `ApplicationMessage`, no second socket.
- Sign-in reuses `/api/calendar/auth*`; status gains a `missing_scopes` /
  `todo_needs_consent` hint so the kiosk can ask the member to sign in again.

### 3.4 Voice (out of scope; one note)

A future read-only `get_tasks` tool would fit the explicit-tool rule and the locked
set. Voice adding or completing To Do tasks would be a new write exception; root
AGENTS.md lists voice writes as narrow and deliberate. Not proposed.

---

## 4. Phase 2: frontend sketch

- **To Do appliance mode** in the dock, beside Timer and Lists (set apart with its
  own identity colour, same size; spatially stable). Content: tasks grouped by
  **Overdue / Today / Upcoming / No date**, or by person; see open questions. Rows are
  full-size touch rows: title, due label ("Today", "Thu", "Nov 14"), a person
  identity marker, a restrained category marker, importance as a star glyph,
  checklist "2/5". Tap opens a detail sheet (`.detail-sheet` family) with the note,
  checklist and list name. No checkbox affordance while read-only.
- **Home summary tile:** NOW/NEXT only. Overdue + due today (+ high-importance),
  capped at the rows that fit, then "+N more" → To Do mode. Collapses entirely when
  there is nothing due (no "all done" filler). Ambient badge on the dock button:
  overdue/due-today count, as an absolute overlay.
- **Never** rendered in Home's schedule, Week, or Month; no due-date chips on the grid.
- **Colours:** person = palette colour of the owning account via the same
  `.calendar-<name>` classes and viewer remap; category = `--category-color` path.
- **Privacy mode:** titles/notes/categories → `•••`; counts, due dates and person stay,
  matching events/lists.
- **Health:** stale/needs-sign-in uses the header's warning slot, not inline text.
- Types hand-mirrored in `App.tsx` in the same commit as `models.py`; a `useTasks`
  hook fed by the shared `appSocket`.

---

## 5. What checking tasks off would cost later (not designed)

- Scope `Tasks.ReadWrite` → every member re-consents (new device-code sign-in).
- `PATCH /me/todo/lists/{listId}/tasks/{taskId}` `{ "status": "completed" }`.
- A mutating route → `_require_local()` + `_require_unlocked()`, plus a decision on
  whether touch-completing someone else's task is acceptable (shared-list semantics).
- An optimistic UI with rollback; delta then echoes the change on the next pass.
- It reopens the "Graph providers are read-only" stance in root AGENTS.md (two-way
  calendar sync stays a non-goal regardless), so it needs an explicit product call.

---

## 6. Testing approach

- **pytest (`backend/tests/test_todo_*.py`)** with a fake `httpx` transport serving
  canned Graph JSON:
  - baseline across two `nextLink` pages → `deltaLink` stored;
  - incremental: upsert, `@removed`, completed-status change;
  - **410 Gone** → token dropped, list re-baselined, no retry of the dead link;
  - 429 with `Retry-After` honoured (injected clock), 401 → `needs_sign_in` with
    cached tasks kept and the calendar `auth_error` untouched;
  - `dueDateTime` in UTC at local midnight → correct local `due_on` across DST
    (the tz-conversion test class the root AGENTS.md calls domain core);
  - shared list visible from two accounts → de-duplicated once, owner attribution;
  - category name → master-category hex; unknown → neutral;
  - state file: atomic write, reload, corrupt → reseed;
  - flag off → no thread, `/api/tasks` returns `disabled`; LAN gate and (for the toggle)
    privacy 423.
- **Frontend:** vitest for grouping/due-label/redaction; Playwright for To Do mode and
  Home tile with no document scroll at 3840×2160 and 1920×1080.
- **Live validation script** `backend/scripts/validate_todo_graph.py` (hardware/live
  only, never CI): signs in with the configured client, then records answers to every
  **[verify]** item above: `Tasks.Read` consent on the CLI-tools client, lists and
  `isShared`/`isOwner`, raw `dueDateTime` shapes, whether `Prefer` is honoured,
  `$select`/`$expand` on delta, category names vs master categories, and a long-lived
  delta link re-used after N hours/days (logs the 410 when it happens).

---

## 7. Open product/design questions (undecided)

1. **Whose tasks:** every signed-in member (model A), one hub account with shared lists
   (B), or a chosen subset of lists?
2. **Which lists by default:** all, the default "Tasks" list only, or opt-in per list?
   Hide "Flagged email"?
3. **Grouping in To Do mode:** by due bucket, by person, or by list?
4. **Home tile rule:** due today + overdue only? Include high-importance undated tasks?
   How many rows before "+N more"?
5. **Completed tasks:** hide immediately, show struck-through until end of day, or a
   "recently done" section?
6. **Colour precedence:** person colour as the dominant marker with category as the
   secondary marker (current calendar rule), or category-first for tasks?
7. **Privacy mode:** redact like events, or hide the To Do tile entirely?
8. **Checking off from the wall:** wanted at all, and by whom (§5)?
9. **Sync cadence vs freshness:** is 60 s acceptable after a phone edit?
10. **Relationship to #3:** should To Do lists or checklist items back the project
    planner (a list per project, checklist = steps), or does #3 stay in-app?
