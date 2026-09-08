# Mission Control: Lists — design plan

Status: **implemented (2026-09-07).** All six phases below are built and covered
by tests (`backend/tests/test_lists.py`, `frontend/src/lists/*.test.*`,
`frontend/src/voice/tools.test.ts`, `frontend/src/App.test.tsx`,
`frontend/e2e/lists.spec.ts`). This is kept as the design record; the open
questions were resolved as noted in §11.

**Resolved (2026-09-07):** O1 — a list voice command always `show_view('lists')`.
O2 — no on-screen keyboard; deferred. O3 — extend `ApplicationMessage`
(`lists` / `list` / `removed`), no new type. O4 — recent item names persist on the
store (`GroceryList.recent_names`). O5 — categories deferred. O6 — the Undo is an
on-screen notice only; no spoken "undo".

**Follow-up (2026-09-07):** drag-to-reorder the unchecked "to get" section, order
persisted — see the **Item ordering** row in §2 and `frontend/src/lists/dragReorder.ts`.

The rest of this document describes the intended design.

Scope owner note. The request: research how comparable products handle a
shared/household list, then propose an approach that is a good ambient-appliance
UX and a tidy code addition. Minimally it must let a household **see what is on
the list at a glance, remove a single item, clear the list, and add items by
voice** ("add meatballs to the grocery list"). Build **one** list (grocery);
shape the model, API, and UI so a later move to several named lists is a small
change, not a redesign — the same discipline the timer work used for "one timer
now, *N* later".

---

## 1. Pattern inspirations

Surveyed: dedicated grocery apps (AnyList, Bring!, OurGroceries, Any.do grocery
mode, "Simple Grocery List by Aisle"), household organisers (Cozi, Google Keep,
Apple Reminders), and — most relevant, because they are wall/counter appliances
driven partly by voice — Google Nest Hub (Google Keep / "shopping list") and
Amazon Echo Show (Alexa Shopping List).

### What the category does

| Capability | Who does it | Relevance to Mission Control |
| --- | --- | --- |
| **Voice add is the primary input** on smart displays — "add milk to my shopping list" → spoken confirmation, item appears | Nest Hub, Echo Show | This is the headline requirement. The kiosk is touch-first but far-field; typing is not viable, so voice must be a first-class add path, not an afterthought. |
| **One tap to check an item off**; checked items strike through and sink to the bottom, not deleted | AnyList, Bring!, OurGroceries, Echo Show | "Bought it" and "remove it" are *different* actions. Shoppers want to see what they already grabbed. Checked ≠ gone. |
| **Clear = clear the checked ones**, with "clear all" a separate, deliberate action | AnyList, OurGroceries | "Clear the list" almost always means "clear what we bought", not "erase everything". Full clear needs a guard or an undo. |
| **Real-time sync across every screen**, instantly | OurGroceries (its whole pitch), Bring! | Mission Control already has `/api/ws` + `ApplicationMessage`; a list is exactly the kind of small shared state it is for. |
| **Auto-grouping by aisle / category** (Produce, Dairy…) | AnyList, Bring!, Any.do, "…by Aisle" | Powerful in-store, but it needs an item→category dictionary and is visual clutter at 6–10 ft. **Defer** — flat list for v1, grouping is a later increment. |
| **Recent / staple items as quick-add chips** — tap to re-add what you buy every week without retyping | Bring! (tile grid), AnyList (autocomplete), "…by Aisle" (quick-add bar) | This is how the kiosk gets a *touch* add path with no keyboard: a grid of recently-used items. Doubles as the "history" pattern. |
| **Quantity / notes per item** ("2 %", "the big bag") | AnyList, Bring! | Keep minimal: one free-text `name` plus an optional `note`. No structured quantity in v1 — "two bags of flour" is just the name. |
| **Dedupe on add** — adding an item already present doesn't create a second row | Bring!, OurGroceries | Adding "milk" when milk is on the list should be a no-op (or un-check it), and say so. |
| **Undo after a destructive action** | AnyList, Keep | A full clear (especially by voice) must be recoverable — a brief "Cleared 9 items · Undo". |
| Recipe import, meal planning, price tracking, store-specific layouts, barcode scan | AnyList, Bring!, Echo Show | All **out of scope**. Mission Control is a calendar appliance that also holds a list; it is not becoming a grocery app. |

### Layout lessons

- **Single scannable column, big rows.** OurGroceries and the Echo Show list are
  just that. Unchecked at the top in reverse-add order (newest first, so a
  just-added item lands where the eye is), checked collapsed and dimmed below.
- **The count is the ambient signal.** "Grocery · 9" read across the room is the
  whole point; the items are the interactive detail.
- **The add control is fixed**, never scrolls away (quick-add bar / FAB in every
  app surveyed).
- On a shared display, **who added it and when** is faint metadata, not a column.

### Voice-flow lessons

- Nest Hub / Echo Show: one utterance, one item, **spoken confirmation naming the
  item** ("I've added milk"), list visually updates. No follow-up dialogue.
- "Add eggs and bread and butter" — the good apps split conjunctions into
  separate items. Worth supporting.
- Removing by voice is rarer and fuzzier ("take milk off the list") — match
  loosely against current items, and if nothing matches say so rather than guess.

**Sources:**
[Best Grocery List Apps 2026 (LystBot)](https://lystbot.com/blog/best-grocery-list-apps/) ·
[7 Best Grocery List Apps in 2026 (GroceriesTracker)](https://groceriestracker.com/blog/best-grocery-list-apps-2026) ·
[Best Shared Grocery List App 2026 (Homsy)](https://gethomsy.com/blog/meal-planning/shared-grocery-list-app) ·
[Which Digital Grocery List Reigns Supreme in 2025? (Ithy)](https://ithy.com/article/best-shopping-list-apps-2025-g8bss5cb) ·
[How to use Google's built-in shopping list (Android Police)](https://www.androidpolice.com/google-shopping-list-tutorial/) ·
[Voice shopping with Alexa and Google Assistant (GearBrain)](https://www.gearbrain.com/voice-shopping-with-alexa-explained-2534870941.html) ·
[How to create Alexa Shopping Lists (Amazon)](https://www.amazon.com/b?ie=UTF8&node=21213736011) ·
[Simple Grocery List by Aisle (App Store)](https://apps.apple.com/us/app/simple-grocery-list-by-aisle/id6772209387) ·
[Bring! Grocery Shopping List (App Store)](https://apps.apple.com/us/app/bring-grocery-shopping-list/id580669177) ·
[Any.do Smart Grocery Lists](https://support.any.do/en/articles/8635928-smart-grocery-lists)

---

## 2. Decisions locked in

| Question | Decision |
| --- | --- |
| **How many lists** | **One** — a grocery list, server-created on first run with a fixed id (`grocery`). The store keys lists by id (a `dict`, like the timer store) and every API path and UI component takes a list id, so adding named lists later is config + a picker, not a rewrite. No multi-list UI, no list CRUD, no per-list settings now. |
| **Persistence** | **Backend-owned, single JSON file** (`MISSION_CONTROL_LISTS_FILE`, default `lists.json` in the backend working dir, git-ignored) — atomic write on every mutation, loaded at startup. This is the **one deliberate departure from the timer model**: a wall appliance that forgets the grocery list on every reboot is broken UX, whereas a forgotten 10-minute timer is merely annoying. It is the same "one JSON file, no datastore" class as the MSAL token cache, and `AGENTS.md` already anticipates "a SQLite-backed store should drop in behind the same protocol" — the store is written to that protocol. Still **no SQLite, no new dependency.** |
| **Item = check vs. delete** | Two distinct operations. **Check off** toggles `checked` (strike through, sink to a "Got it" section, stays on the list). **Remove** deletes the row. Both are one touch; both are voice-reachable. |
| **"Clear the list"** | Two scoped actions. **Clear checked** (the common case — removes only checked items, no confirmation). **Clear all** (removes everything) — guarded by a confirm on touch, and always followed by a transient **"Cleared N items · Undo"** notice (reuses the `timerNotice` pattern). Voice "clear the grocery list" → clear **all**, with the Undo notice; "clear the checked stuff" / "clear what we got" → clear **checked**. |
| **Touch add with no keyboard** | Follows the timer precedent (`docs/timer-plan.md`: "no on-screen keyboard; free-text labels come from voice"). The Lists view shows a **quick-add grid of recent items** — the last ~20 distinct item names ever added, most-recent first — tap to re-add. **Novel items are added by voice.** An on-screen keyboard is a possible later increment (open question O2), not v1. |
| **Is Lists a calendar view or an appliance mode?** | An **appliance / role mode**, exactly like Timer. It sits *outside* the Home/Week/Month group in the dock (after Timer), carries its own identity colour (**`fern`** — the green already in the palette, reads "fresh / checklist", and is not `coral`, which is reserved for now/live/alarm), and renders as a **warm self-contained panel** rather than a borderless calendar grid. `AGENTS.md` → "Persistent chrome" gets Lists added alongside Timer in the "not a calendar-viewing peer" rule. |
| **Does a voice add switch the display to Lists?** | **Yes.** Every other voice command moves the display to show its answer ("the display is the assistant's output surface"); a list mutation calls `show_view('lists')` so the change is visible and the household sees it landed. It is **not** an ambient default — no `false→true` edge effect, no lock; explicit navigation always wins and a future idle-revert goes Home. (Alternative considered — stay on the calendar, rely on the spoken confirmation — recorded in O1.) |
| **Voice may now write list state** | The **second** documented exception to voice being read-only, after timers. Rationale is identical: ephemeral, local, single-household state with **no external side effect** and no calendar/provider write. `add_to_list` / `remove_from_list` / `check_off_item` / `clear_list` / `get_list`. The read-only rule was always specifically about *the calendar*; that stays absolute. |
| **Item ordering** | Unchecked first, **newest-add first** within that (a voice add appears at the top, where attention is). Checked items below in check order. **Manual drag-reorder added 2026-09-07** (grip handle per unchecked row, pointer-capture drag so it works on touch; `POST /api/lists/{id}/reorder` persists the `items` array order; a new add still prepends; `restore` no longer re-sorts so Undo keeps a custom order). See `frontend/src/lists/dragReorder.ts`. |
| **Dedupe** | Adding a name that matches an existing **unchecked** item is a no-op that returns the existing item ("milk's already on the list"). Matching a **checked** item **un-checks it** ("put milk back on"). Match on a normalised name (lowercased, trimmed, singular/plural-insensitive if cheap). |
| **Multi-item add** | "add eggs, bread and butter" splits on commas / "and" into separate items in one call. The tool accepts `items: string[]`; the interpreter and the cloud prompt both split. |
| **Real-time** | Same as timers: the store pushes an `ApplicationMessage` on every change over `/api/ws`; the socket sends the current lists on connect; the kiosk reconciles from `GET /api/lists`. Not a new channel. |

---

## 3. What a list is

Domain model (`backend/app/models.py`):

```
ListItem
  id: str                    # opaque, server-generated
  name: str                  # "meatballs", "2% milk" — free text, 1..200 chars
  note: str | None            # optional "the big bag", "for Sarah"
  checked: bool = False
  added_at: datetime          # naive local (per AGENTS.md time handling)
  checked_at: datetime | None
  source: Literal["voice", "touch"] = "touch"   # diagnostics + subtle UI only

GroceryList        # v1: exactly one, id == "grocery"
  id: str
  title: str = "Grocery"
  items: list[ListItem]
  updated_at: datetime

ListItemCreateRequest  { name: str, note: str | None, source: ... }   # or `names: list[str]` for multi-add
ListItemUpdateRequest  { checked: bool | None, name: str | None, note: str | None }
ListClearRequest       { scope: Literal["checked", "all"] = "checked" }
ListMutationResult     { list: GroceryList, removed: list[ListItem] = [] }   # `removed` powers Undo
```

- `ListMutationResult.removed` is what a clear / remove returns so any surface can
  offer Undo without a second lookup (mirrors `TimerMutationResult.replaced`).
- Validation: `name` non-empty after strip; `title` non-empty; `checked_at` set
  iff `checked`.
- The single-list rule lives in the **store**, not the model (as the
  single-timer rule does).

`ApplicationMessage` (already `type` / `message` / `snapshot` / `timers` /
`timer` / `replaced`) gains two optional fields:

```
  lists: list[GroceryList] | None   # full current set, for reconciliation
  list:  GroceryList | None          # the one that changed
```

Message types: `list-item-added` / `list-item-removed` / `list-item-checked` /
`list-item-unchecked` / `list-cleared`. Keep it a small typed addition to the
envelope — **not** a general event bus (`AGENTS.md`).

---

## 4. Architecture

```
┌───────────────────────── kiosk browser ─────────────────────────┐
│  Lists tab   ◀── list rendered from GET /api/lists + ws pushes   │
│  useLists() hook                                                 │
│     │  add / check / remove / clear:                             │
│     │     • touch  → POST/PATCH/DELETE/clear /api/lists/grocery   │
│     │     • voice  → dispatchToolCall → same endpoints            │
│     │  state in:                                                 │
│     │     • /api/ws  ApplicationMessage {type:"list-…", lists}    │
│     │     • GET /api/lists on connect / reconnect (authority)    │
│     ▼                                                            │
│  dock Lists button shows the unchecked count when > 0            │
└─────────────────────────────────────────────────────────────────┘
        backend: owns the list, persists to lists.json, broadcasts
```

Why this shape:

- **Backend authority + JSON file** matches "the server owns everything durable"
  and the existing single-file precedent (MSAL cache). The store never imports
  the WebSocket layer (broadcast is an injected callback), so it is unit-testable
  without a socket — same as `TimerStore`.
- **The kiosk holds no list state of its own.** No `localStorage` (per-viewer, a
  second screen wouldn't see it, clears with site data). Everything flows through
  the backend so every screen converges.
- **One socket.** `useTimers` currently owns the `/api/ws` connection. Rather
  than open a second one for `useLists`, extract a tiny shared
  `frontend/src/realtime/useAppSocket.ts` (connect once, `subscribe(cb)`,
  reconcile-on-open) that both hooks consume, dispatching by message `type`. Small
  refactor, called out in the rollout.

---

## 5. Backend work

### Models (`app/models.py`)
`ListItem`, `GroceryList`, the three request models, `ListMutationResult`; the
two new optional `ApplicationMessage` fields. `LIST_ITEM_NAME_MAX = 200`.

### List store (`app/lists.py`, new — mirrors `app/timers.py`)
- Module-level singleton, `dict[str, GroceryList]` keyed by id; `get_list_store()`
  / `reset_list_store()` (tests).
- On first construction: load `MISSION_CONTROL_LISTS_FILE` if present; else seed
  one empty `GroceryList(id="grocery")`. A missing/corrupt file logs and seeds
  fresh (never crash a startup over the grocery list).
- `add_items(list_id, names, *, source)` — dedupe per §2; returns
  `ListMutationResult`.
- `update_item(list_id, item_id, req)` — toggle `checked` (sets/clears
  `checked_at`), edit name/note.
- `remove_item(list_id, item_id)` — returns the removed item in `removed`.
- `clear(list_id, scope)` — `checked` drops checked items, `all` drops
  everything; returns them in `removed` for Undo.
- `restore(list_id, items)` — re-inserts items (the Undo path).
- Every mutation: persist (atomic temp-file + `os.replace`, debounced ~150 ms so
  a burst of voice adds writes once) **then** call the broadcast callback with the
  full `lists`.
- `clear_all()` for lifespan shutdown / tests (no broadcast, no persist toggle).

### Endpoints (`app/api.py`) — all `_require_local`-gated, like timers
| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| `GET` | `/api/lists` | — | All lists (v1: one). |
| `GET` | `/api/lists/{id}` | — | One list; 404 unknown. |
| `POST` | `/api/lists/{id}/items` | `ListItemCreateRequest` (`name` or `names[]`) | Add (deduped); 404 unknown list; 422 empty name. |
| `PATCH` | `/api/lists/{id}/items/{itemId}` | `ListItemUpdateRequest` | Check/uncheck/edit; 404. |
| `DELETE` | `/api/lists/{id}/items/{itemId}` | — | Remove one; 404. |
| `POST` | `/api/lists/{id}/clear` | `ListClearRequest` | Clear checked/all; returns `ListMutationResult` with `removed`. |
| `POST` | `/api/lists/{id}/restore` | `{ items: ListItem[] }` | Re-add removed items (Undo). |

Every mutating endpoint returns the resulting state **and** triggers the
broadcast, so the initiating kiosk and any other screen converge through one
path.

### Config (`app/config.py`, `.env.example`)
- `lists_file: str = "lists.json"` — relative → backend working dir; absolute ok.
- `lists_recent_items_max: int = 20` — how many distinct past item names the
  quick-add grid remembers (persisted alongside the lists, or derived from a
  retained `history: list[str]` on the store).
- No feature flag — like timers, lists are core, not opt-in.

### `.gitignore`
Add `backend/lists.json` (and any `*.lists.json`).

---

## 6. Frontend work

### `frontend/src/lists/` (new, mirrors `frontend/src/timers/`)
- **`types.ts`** — `ListItem`, `GroceryList`, message shape, mirrored constants.
  Keep field names `snake_case` in step with `app/models.py`.
- **`useLists.ts`** — owns the lists, subscribes to the shared app socket,
  reconciles via `GET /api/lists` on open. Actions: `add(name)`,
  `addMany(names)`, `toggle(itemId)`, `remove(itemId)`, `clear(scope)`,
  `restore(items)` — thin wrappers over the endpoints; the ws echo corrects
  optimistic UI. Exposes `list`, `uncheckedCount`, `recentItems: string[]`.
- **`ListsView.tsx`** — the panel (see §7).

### `App.tsx`
- `ViewMode` gains `'lists'`; the `view-frame` switch renders `<ListsView>`.
- Dock: a **Lists** button after the Timer button — same "outside the group"
  treatment (gap + hairline divider, `fern` identity: `fern` fill when active, a
  quiet `fern` outline + the unchecked count when a list has items and another
  view is on screen). Hidden count on the Lists view itself.
- `voiceActions.showView` already covers `'lists'` once the `ViewMode` union
  includes it — no other `DashboardActions` change (list mutations go to the API
  through `dispatchToolCall`, not through view-state actions).
- Reuse `timerNotice` (rename to a generic `notice` or add a sibling
  `listNotice`) for "Cleared N items · Undo".

### `frontend/src/voice/tools.ts`
Add dispatch cases for the new tools — `fetch` against `/api/lists/...`, same as
the timer cases. No `ctx.actions` involvement beyond the existing `show_view`.

### `frontend/src/voice/types.ts`
`ViewMode` gains `'lists'`.

### `App.css`
One `fern`-keyed dock treatment mirroring `.dock-timer`, and a
`.lists-view` warm panel mirroring `.timer-view`. Rows reuse the existing
`compact-event` sizing sensibility (tall touch targets, `clamp()` type). No new
tokens — `--fern` exists.

---

## 7. The Lists view

Fits a 16:9 kiosk viewport at 3840×2160 and 1920×1080. Like the Timer view it is
a **warm self-contained panel**. The list content area is a **bounded internal
scroll region** when it overflows (consistent with "overlays/dialogs may scroll
internally"; the header, count, and quick-add stay pinned) — a grocery list is
inherently variable-length and the Month-style "+N more" collapse would be wrong
here.

```
┌ Grocery · 9 to get ─────────────────────────────  [Clear checked] ┐
│                                                                   │
│   ☐  Meatballs                                     (just added)    │   ← unchecked,
│   ☐  2% milk                                                       │     newest first,
│   ☐  Sourdough                                                     │     big rows,
│   ☐  Coffee beans — the dark one                                   │     tap = check
│   ☐  …                                          (scrolls if long)  │
│  ───────────────────────────────────────────────────────────────  │
│   ☑  Eggs           ☑  Butter          ☑  Bananas   (Got it — 3)   │   ← checked, dim,
│                                                                    │     struck, tap = uncheck
├────────────────────────────────────────────────────────────────────┤
│  Add again:  [ Milk ] [ Eggs ] [ Paper towels ] [ Onions ] [ … ]   │   ← recent items,
│                                                       Say "Mission │     tap to re-add
│                              Control, add …" for something new     │
└────────────────────────────────────────────────────────────────────┘
```

- **Heading**: `title` + unchecked count ("9 to get"; "All done" when 0 unchecked
  with items present; empty-state card when the list is empty).
- **Row**: whole row is the check toggle; a trailing `×` removes. A voice-added
  row briefly highlights on arrival. `note` renders as a dim suffix.
- **"Got it" section**: checked items, compact, wrap; a "Clear checked" action in
  the header (not per-row) is the bulk path.
- **Quick-add**: recent item chips; tapping one adds instantly (and un-checks if
  it's a checked match). The only always-visible hint that new items come from
  voice.
- **Clear all**: not a primary button — behind an overflow (`⋯`) with a confirm
  ("Clear all 9 items?"), then the Undo notice.

### Cross-view presence
The dock **Lists** button shows the unchecked count when > 0 and another view is
on screen — the ambient "7 things to get" signal, matching how the Timer button
carries remaining time. Calm: just the number, `fern`, no animation.

---

## 8. Voice work

Lists are the **second** state-mutating voice capability. The read-only rule
(`AGENTS.md`, `docs/voice-support-plan.md`) is about the **calendar** and stays
absolute; timers and now lists are the documented, narrow exceptions —
ephemeral/local household appliance state, no external side effect.

### Tool contract — `backend/app/voice/tools.py` (source of truth) + `frontend/src/voice/tools.ts` (mirror)

| Tool | Args | Dispatch | Result to agent |
| --- | --- | --- | --- |
| `add_to_list` | `items: string[]` (one or many), `list?: string` (default `grocery`) | `POST /api/lists/{id}/items` | `{ ok, added: string[], already_present: string[], list }` — agent confirms by naming items; mentions dupes |
| `remove_from_list` | `item: string`, `list?: string` | resolve against current items → `DELETE …/items/{itemId}` | `{ ok, removed }` or `{ ok: false, error: "…isn't on the list" }` |
| `check_off_item` | `item: string`, `list?: string` | resolve → `PATCH …/items/{itemId} {checked:true}` | `{ ok, checked }` / `{ error }` |
| `clear_list` | `list?: string`, `scope?: "checked" \| "all"` (default `all` for a bare "clear the list") | `POST …/clear` | `{ ok, removed_count, scope }` — agent says "cleared the list, say undo to put it back" |
| `get_list` | `list?: string` | `GET /api/lists/{id}` | `{ items: [{name, checked}], unchecked_count }` |

- `show_view` enum gains `"lists"` on **both** sides.
- Item resolution for `remove_from_list` / `check_off_item` is a loose match
  against current item names (substring / normalised equality / simple fuzzy).
  No match → a clean spoken "milk isn't on the list", never a guess.
- `clear_list` with `scope` unset from a bare "clear the grocery list" → `all`;
  the dispatcher/prompt maps "clear the checked / the ones we got" → `checked`.

### System prompt — `backend/app/voice/prompt.py`
Add a short paragraph: the agent can add items to the household **grocery list**
(splitting "x, y and z" into separate items), remove or check off a single item,
clear it (say that "undo" restores it), and read it back; after any list change
call `show_view('lists')`; it still cannot touch the calendar.

### Local / Hybrid pipeline — `backend/app/voice/local/`
The `list.add` and `list.show` intents **already exist** in `intents.py` with
`supported=False` (they currently escalate). This work:

- Flips `list.add` / `list.show` to `supported=True`; adds `list.remove`,
  `list.check`, `list.clear` intents (weighted-regex evidence, `mutating=True`
  where they change state, tier 0–1).
- `entities.py` `resolve_list()` — currently *always unresolved* — gains a real
  implementation: fuzzy-match the spoken list name against the **known list
  names** (passed in per turn, like the snapshot; v1 that set is just
  `{"grocery"}` + aliases `groceries` / `shopping` / `shopping list`). An
  unrecognised list name → `needs_clarification` ("I've only got the grocery
  list") — **not** a guess, and no longer an escalation.
- `interpreter.py` `_plan` — replace the `intent.name.startswith("list.")`
  escalation branch with real plans emitting `add_to_list` / `remove_from_list` /
  `check_off_item` / `clear_list` / `get_list` + `show_view('lists')` tool calls.
  Item-name extraction reuses `_extract_list_span()` (already parses "add milk and
  eggs to the costco list"); extend it to split conjunctions into a list.
- **Safety** (`AGENTS.md` local-pipeline rule): a list mutation below the
  mutation-confidence threshold becomes `needs_clarification`, never an executed
  guess. `clear_list` scope `all` is a mutation — a low-confidence "clear it"
  with no list context asks first.
- The kiosk executes these through the **same** `dispatchToolCall` the cloud
  path uses — the backend local pipeline only *decides* the calls.
- Update `backend/tests/data/voice_commands.jsonl` with list utterances and
  keep the `benchmark_local_stt intent` sweep green.

### Docs
`docs/voice-commands.md` gains a "Lists" section (the phrasings, what each does,
the grocery-only limit, "undo" for a clear). `AGENTS.md` "Voice assistant" +
"Current non-goals" update the read-only exception to name lists alongside
timers. `docs/voice-support-plan.md` gets the same one-paragraph note.

---

## 9. Testing

**Backend (`pytest`):**
- Model validation: empty `name` rejected; `checked_at` consistency.
- Store: add dedupes an unchecked match; add un-checks a checked match; remove
  returns the item; `clear("checked")` vs `clear("all")`; `restore` round-trips;
  the broadcast callback fires on every mutation; persistence — a store built
  over a temp file reloads its items, a corrupt file seeds fresh.
- Endpoints via `TestClient`: happy paths + 404s + 422 empty name; `_require_local`
  403 from a non-LAN client (matches the timer/voice tests).
- WebSocket: on connect the client receives the current lists; an add broadcasts
  a `list-item-added` `ApplicationMessage`.
- `test_voice.py` — the locked-tool-set assertion
  (`test_token_minted_with_locked_constraints`) must include the five list tools;
  a case that `clear_list`'s schema documents the undo/scope behaviour.

**Frontend (`vitest`):**
- `useLists`: applies add/remove/check/clear ws messages; reconciles to
  `GET /api/lists` on (re)open; `uncheckedCount` / `recentItems` derived
  correctly.
- Tool dispatch: each list tool calls the right endpoint with the right body; a
  404 becomes a spoken-friendly `{ ok: false, error }`.
- `ListsView`: tapping a row toggles checked; `×` removes; a quick-add chip adds;
  "Clear all" needs the confirm; the Undo notice appears and `restore` re-adds.
- Nav: the Lists tab switches `mode`; a voice `show_view('lists')` routes there;
  the dock count shows only off the Lists view and doesn't shift the mode group.

**Local / hybrid (`test_voice_local_intent.py`, text-only):**
- "add meatballs to the grocery list" → `add_to_list` plan, `handled_locally`.
- "add eggs, bread and butter" → three items.
- "take the milk off the list" → `remove_from_list`; unknown item → clarify.
- "clear the grocery list" → `clear_list` all; "clear what we got" → checked.
- "add milk to the costco list" → `needs_clarification` (grocery only), **not**
  escalation.
- low-confidence "clear it" with no context → `needs_clarification`.

**Playwright:** the Lists view fits 3840×2160 and 1920×1080 with no
document-level scroll (the list body may scroll *internally*); adding via a
quick-add chip shows the row; checking an item moves it to "Got it".

---

## 10. Rollout / phases

1. **Backend core** — models, `app/lists.py` store + JSON persistence,
   `/api/lists` CRUD + clear + restore, `_require_local`, unit tests. No UI.
2. **Push** — `ApplicationMessage` `lists`/`list` fields, broadcast on mutation,
   list-on-connect; extract `useAppSocket` and move `useTimers` onto it, tests.
3. **Lists tab** — `ViewMode='lists'`, dock button (`fern`, count badge),
   `ListsView` (unchecked / got-it / quick-add), `useLists`, Undo notice.
4. **Voice** — five tool declarations both sides, prompt paragraph, dispatcher →
   REST, `show_view` enum, `docs/voice-commands.md` + `AGENTS.md` + token test.
5. **Local / hybrid** — flip `list.add`/`list.show` supported, add
   `list.remove`/`list.check`/`list.clear`, real `resolve_list`, `_plan` cases,
   corpus + intent tests.
6. **Docs + DoD** — `AGENTS.md` (a "Lists" section + the read-only exception +
   the persistence note), `.env.example` (`LISTS_FILE`, `LISTS_RECENT_ITEMS_MAX`),
   `.gitignore`. Full `pytest` / `ruff` / `vitest` / `tsc` / `eslint` /
   `vite build` / Playwright.

---

## 11. Open questions (fine to settle during build)

- **O1 — view switch on voice add.** Recommended: `show_view('lists')` after any
  list mutation (consistent with every other voice command). Alternative: stay
  put, rely on the spoken confirmation, so "add milk" mid-meal-planning doesn't
  yank the wall display off the calendar. Could be split: switch for
  remove/clear, stay for a single add.
- **O2 — on-screen keyboard.** v1 has none (voice for new items, chips for
  repeats). If the recent-items grid proves insufficient in use, a compact
  on-screen keyboard for the Lists view only is the follow-up — it would be the
  first in the app and needs its own layout pass.
- **O3 — `ApplicationMessage` growth.** Same call as timer open question O6:
  extend the shared envelope with `lists`/`list` (recommended, keeps one type),
  or introduce a `ListMessage`. Mirror whatever the timer work settled.
- **O4 — recent-items history storage.** Persisted on the store (a capped
  `history: list[str]`) vs. derived from removed/checked items. Persisted is
  simpler and survives a clear.
- **O5 — categories / aisle grouping.** Deferred. If added later it needs an
  item→category dictionary (ship a small built-in one, like the holiday table)
  and a grouped render mode toggle — a clean increment on top of the flat list.
- **O6 — multi-item `clear_list` undo by voice.** The Undo notice is on-screen;
  a spoken "undo" immediately after a clear would need the turn to carry
  "last removed" context. v1: the on-screen notice is the undo path; voice "undo"
  is a nice follow-up.

---

## 12. Explicitly out of scope

Multiple named lists (the model accommodates, the UI does not build);
list creation/deletion/rename; per-item quantity as structured data;
categories / aisle grouping / store layouts; recipe import; meal planning; price
or purchase history; barcode scanning; sharing a list outside the household;
push notifications; a spoken announcement when someone else adds an item;
voice-driven calendar writes (still out); SQLite / any datastore beyond the one
JSON file.
