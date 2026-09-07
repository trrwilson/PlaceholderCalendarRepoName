# Mission Control: Timers — design plan

Status: **implemented (2026-09-06).** All six phases below are built and covered by
tests (`backend/tests/test_timers.py`, `frontend/src/timers/*.test.*`,
`frontend/src/voice/tools.test.ts`, `frontend/e2e/timer.spec.ts`). Push-to-talk
timer voice support is included. Wake-word integration is deliberately **not**
done (owned by `docs/wake-word-plan.md`). Build notes and the arbitrary decisions
taken headlessly are in `docs/timer-implementation-notes.md`. This section is kept
as the design record; the rest of the document still describes the intended
behaviour.

**Amendment (2026-09-07) — pause / resume / restart.** The timer now supports
pausing (freeze the countdown into `Timer.remaining_seconds`, `state = "paused"`),
resuming (rebase `created_at`/`fires_at` from now, keeping the original
`duration_seconds`), and restarting (reset to the full `duration_seconds` from any
state). New endpoints `POST /api/timers/{id}/pause|resume|restart`; new voice tools
`pause_timer` / `resume_timer` / `restart_timer` (cloud + local pipelines);
`TimerView` running state gains a Pause/Resume toggle and a Restart button; the dock
button shows `Paused`. Extending a paused timer keeps it paused. Cross-referenced
against the pause/resume/reset treatment common to Google Assistant and Alexa
timers. See `docs/timer-implementation-notes.md` for the build decisions.

**Amendment (2026-09-06) — the running timer no longer locks the display.**
The first cut let a running timer capture the "return to default" affordance, so
the brand / Home control could not reach Home while a timer ran. That is fixed:
the Timer view is the *ambient* default while a timer is active, but explicit
navigation always wins, and the soonest-to-fire timer's remaining time now rides
on the Timer dock button on every other view. See **Default view while a timer is
active** and **Cross-view timer tracking** below; both sections have been
rewritten to match.

Scope owner note: the requester asked for a plan that (a) gives timers a dedicated
tab that becomes the default view while a timer is active, (b) supports
voice-first, mixed-modality, and touch-only configuration, (c) caps timer
duration/lookahead at six hours and rejects anything longer, (d) keeps the
physical display awake while a timer runs (once display-power control exists), and
(e) plays a recognisable, not-irritating audio cue on repeat when a timer fires
until a person dismisses it.

## Decisions locked in

| Question | Decision |
| --- | --- |
| Timer state ownership | **Backend-owned, in-memory.** The backend is the single source of truth, holds timers in process memory, and pushes changes to the kiosk over the existing `/api/ws` WebSocket using the `ApplicationMessage` envelope. **A backend restart clears active timers** — accepted limitation. No SQLite, no JSON sidecar, no new datastore. |
| Concurrency | **One active timer at a time** for this task. Model, API, and UI must be shaped so a later change to *N* concurrent timers does not require a redesign — but do **not** build multi-timer UI, disambiguation, or storage now. Starting a timer while one exists **replaces it silently** (no confirmation prompt), but every output path — spoken reply, the tab, any toast — states that a previous timer was replaced and what it was. |
| Default view | Once a timer exists the Timer view becomes the **ambient default** — the view the app settles on when *it* chooses (starting a timer, a timer firing, cold boot, a future idle-revert). It is **not** a lock: any explicit navigation (a mode tab, the brand / Home control, a voice `show_view`) goes exactly where asked while the timer keeps running. When the Timer view is not on screen, the soonest-to-fire timer's remaining time is shown on the Timer dock button so it stays visible and adjustable from one tap. See **Default view while a timer is active** and **Cross-view timer tracking**. |
| Alarm | Chime loops while `fired`; audio stops after a 5-minute backstop but the visual finished-state persists until dismissed. Dismiss from the Timer tab, by tapping the alarm surface, or by voice ("stop"). **No spoken announcement when a timer fires** in this task. |
| Display wake | While a timer is `running` or `fired` the kiosk acquires `navigator.wakeLock('screen')` as a best-effort stopgap. The formal keep-awake / revert-to-timer contract for the future OS-level display-power controller is specified but not built here. |
| Voice capability | Voice gets **`start_timer`, `cancel_timer`, `extend_timer`, `pause_timer`, `resume_timer`, `restart_timer`** (plus a read-only `get_timer`). These are the **first state-mutating voice tools** in the project; the read-only boundary in `AGENTS.md` / `docs/voice-support-plan.md` gets a documented, narrow exception (see [Voice work](#voice-work)). |
| Expiry audio | Bundle one short, gentle chime asset (CC0 / permissively licensed / self-made), looped while a timer is in the `fired` state. Record where it came from in `docs/credits.md`. A WebAudio-synthesised tone is the fallback if no suitable asset is found. Licensing rigour here is deliberately light — note provenance, don't over-engineer. |
| Time model | A timer is a **duration** counting down to an absolute `fires_at` (naive local time, per `AGENTS.md`). The tool/API take `duration_seconds`; the kiosk dial is a duration. Absolute-time targets ("timer until 3:45") are resolved to a duration by the caller (the voice agent already resolves relative dates this way). |
| Six-hour cap | Enforced in **three** places: the Pydantic model validator (source of truth), the voice tool-argument check (agent speaks the rejection), and the touch dial (cannot travel past 6h). `0 < duration_seconds <= 21600`. |

## What a timer is

Domain model (`backend/app/models.py`):

```
Timer
  id: str                      # opaque, server-generated
  label: str | None            # optional ("pasta", "laundry") — used in the
                               #   alarm screen and the spoken confirmation
  created_at: datetime         # naive local
  fires_at: datetime           # naive local; created_at < fires_at
  duration_seconds: int        # 1 .. 21600 (6h). fires_at == created_at + duration
  state: "running" | "fired" | "dismissed"
```

- `duration_seconds` is redundant with `fires_at - created_at` but is stored so the
  UI can render "45:00 timer" without recomputing, and so `extend_timer` has an
  unambiguous base.
- Validator: `fires_at > created_at`, `1 <= duration_seconds <= 21600`,
  `fires_at == created_at + timedelta(seconds=duration_seconds)` (tolerance for
  serialisation rounding).
- `state` transitions: `running → fired` (scheduler, at `fires_at`), `running ↔
  paused` (pause / resume), `* → running` (restart), `running / paused / fired →
  dismissed` (cancel or dismiss). `dismissed` timers are
  removed from the in-memory store immediately after the push; the state exists so
  a single push can say "this timer is gone and why".
- Single-timer rule lives in the store, not the model: creating a timer while one
  is `running` or `fired` **replaces** it. The create response and the broadcast
  both carry a `replaced: Timer | None` so every surface can announce "replaced
  your 25-minute pasta timer" without a second lookup.

## Architecture

```
┌──────────────────────── kiosk browser ────────────────────────┐
│  Timer tab  ◀── countdown rendered locally from `fires_at`     │
│  useTimers() hook                                              │
│     │  create/cancel/extend:                                   │
│     │     • touch  → POST/DELETE/PATCH /api/timers             │
│     │     • voice  → dispatchToolCall → same endpoints         │
│     │  state in:                                               │
│     │     • /api/ws  ApplicationMessage {type:"timer", ...}    │
│     │     • GET /api/timers on connect / reconnect (authority) │
│     │  expiry:                                                 │
│     │     • backend scheduler fires at `fires_at` → push       │
│     │     • local clock fires too (safety net if ws dropped)   │
│     ▼                                                          │
│  alarm state → loop chime + force Timer tab + Dismiss control  │
└───────────────────────────────────────────────────────────────┘
        backend: owns the timer, schedules the fire, broadcasts
```

Why this shape:

- **Backend authority** matches "the server owns everything durable" and finally
  gives `ApplicationMessage` its first real use (`AGENTS.md` says to wire it "when
  the first real push exists" — this is it).
- **Countdown math is local.** The backend pushes discrete events
  (created / extended / cancelled / fired); the kiosk renders the ticking seconds
  from `fires_at` itself. No per-second traffic.
- **The kiosk also fires locally.** `/api/ws` has no reconnect today (known gap in
  `AGENTS.md`). If the socket is down when `fires_at` passes, the kiosk must still
  ring, driven by the last `fires_at` it holds. The backend push remains
  authoritative for *create/cancel/extend*; local firing is a safety net only, and
  is reconciled on the next `GET /api/timers`.

## Backend work

### Models (`app/models.py`)

- `Timer` as above. `duration_seconds` minimum is **5** (guard against a 0/near-0
  timer); resolution is 1 second.
- `TimerCreateRequest { duration_seconds: int, label: str | None }`.
- `TimerMutationResult { timer: Timer, replaced: Timer | None }` — returned by
  `POST` and carried on the broadcast so surfaces can say what was replaced.
- `TimerExtendRequest { add_seconds: int }` — the resulting `fires_at - now` must
  still satisfy the 6h cap.
- Extend `ApplicationMessage` usage (it already has `type: str`, `message: str`,
  and an optional `snapshot`): add an optional `timer: Timer | None` and an
  optional `timers: list[Timer]` field, or introduce a dedicated
  `TimerMessage` — decide during build (open question O6). Keep it a small typed
  envelope; do **not** build a general event bus (`AGENTS.md`).

### Timer store (`app/timers.py`, new)

- Process-global singleton (module-level, like the MSAL client pattern) holding at
  most one `Timer` for now, written as a dict keyed by id so *N* is a later config
  change, not a rewrite.
- `create(req)` — replaces any existing timer, cancels its scheduled fire, returns
  the new `Timer`.
- `cancel(id)` / `dismiss(id)` — stop the scheduled fire, mark `dismissed`, drop.
- `extend(id, add_seconds)` — recompute `fires_at`, re-arm, re-validate the cap.
- `list()` / `get(id)`.
- Firing: an `asyncio` task per timer (`await asyncio.sleep(remaining)`, then mark
  `fired` and broadcast). Guard for "no running loop" so imports are test-safe;
  create the task lazily from the request handler / lifespan. A single sweep loop
  is also acceptable — implementer's call given only one timer.
- The store calls a broadcast callback on every change; it does not import the
  WebSocket layer directly (keeps it unit-testable without a socket).

### WebSocket (`app/api.py`)

- Replace the single-socket hello with a tiny connection registry (a `set` of
  live `WebSocket`s + an async `broadcast(message)` helper). One kiosk today, but
  a `set` costs nothing and covers a second screen.
- On connect: send the current timer list so a just-loaded / just-reconnected
  kiosk is immediately correct.
- Broadcast `ApplicationMessage` on create / extend / cancel / fire.
- Still no inbound message handling beyond keep-alive.

### Endpoints (`app/api.py`)

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| `GET` | `/api/timers` | — | List timers (0 or 1). |
| `POST` | `/api/timers` | `TimerCreateRequest` | Create/replace; 422 if `duration_seconds` outside `1..21600`. |
| `PATCH` | `/api/timers/{id}` | `TimerExtendRequest` | Extend; 404 unknown id; 422 if the new lookahead exceeds 6h. |
| `DELETE` | `/api/timers/{id}` | — | Cancel or dismiss (same call for both states); 404 unknown id. |

- Gate all of them with the existing `_require_local` helper, matching the
  calendar-auth and voice-token posture (the appliance is LAN-only anyway; timers
  are control surface).
- Every mutating endpoint returns the resulting `Timer` (or `204`/empty for
  delete) **and** triggers the broadcast, so the initiating kiosk and any other
  screen converge through the same path.

### Config (`app/config.py`, `.env.example`)

- `timer_max_seconds: int = 21600` — the 6h cap, overridable but documented as the
  product ceiling.
- `timer_alarm_max_ring_seconds: int = 300` — how long the chime loops before it
  stops on its own (the visual "finished" state persists until dismissed). See
  open question O4.
- No feature flag — timers are core, not opt-in like voice.

## Frontend work

### `useTimers()` hook (`frontend/src/timers/`, new)

- Owns: the current `Timer | null`, a derived `remainingMs`, and an `alarm`
  boolean (`state === 'fired'`).
- Subscribes to the app WebSocket (today `App.tsx` opens it only to flip the
  connection pill — lift it, or add a second consumer). Applies
  `ApplicationMessage` timer events.
- On socket open/reopen: `GET /api/timers` and reconcile (authoritative).
- Ticks a **1s interval only while a timer is `running` or `fired`** — not a
  permanent per-second re-render of the whole app. Scope the interval to the hook
  and only publish `remainingMs` at ~1Hz.
- `visibilitychange` / wake: on returning to foreground, recompute against
  `fires_at` and enter `alarm` immediately if it has passed.
- Actions: `start(durationSeconds, label?)`, `cancel()`, `extend(addSeconds)`,
  `dismiss()` — thin wrappers over the REST endpoints. Optimistic UI is optional;
  the WS echo will correct it.

### Timer tab

- New `ViewMode` value: `'timer'`. This touches four places that currently hard-code
  `home | week | month`:
  1. `App.tsx` `ViewMode` type + the `<section className="view-frame">` switch.
  2. The `.bottom-dock nav` — add a **Timer** button after Month. Always visible
     (touch-only discoverability); shows a small count/indicator dot when a timer
     is active and pulses while `fired`.
  3. `frontend/src/voice/tools.ts` + `backend/app/voice/tools.py` `show_view` enum.
  4. `frontend/src/voice/types.ts` `ViewMode`.
- `TimerView` component:
  - **No active timer:** the setup surface. A large duration dial / +/− steppers
    in 1-minute steps with quick presets (1, 3, 5, 10, 15, 30, 45 min, 1h, 2h),
    a row of preset label chips ("Food", "Oven", "Laundry", "Kids" — no on-screen
    keyboard; free-text labels come from voice), and a Start button. The dial
    hard-stops at 6h; Start is disabled below the 5-second minimum. Sub-minute
    timers have no touch path (voice can still pass seconds).
  - **Running:** one big `MM:SS` (or `H:MM:SS` past an hour) countdown, the label,
    a progress ring, and **Cancel** + **+1 min / +5 min** controls.
  - **Fired (alarm):** full-bleed attention state — large "Timer finished" + label,
    the looping chime, a full-width **Dismiss**, and a **+5 min** snooze (reuses
    extend from `created_at = now`). Tapping anywhere on this surface dismisses.
  - Must fit a 16:9 kiosk viewport with no document scroll at 3840×2160 and
    1920×1080 (`AGENTS.md` DoD; Playwright covers it).
- Styling goes in the single `App.css` with the existing custom-property tokens.

### Default view while a timer is active

Once a timer exists the Timer view is the **ambient default** — but it never
locks the display. The distinction:

- **The app chooses the Timer view** when a return-to-default happens on its own:
  - **Starting a timer** (any modality) switches to the Timer tab.
  - **On fire**, force-switch to the Timer tab regardless of the current view and
    enter the alarm state.
  - **Cold boot** with a timer already running lands on the Timer view. (This
    falls out of the "a timer appeared" edge effect below, which also covers a
    timer arriving from another screen — no separate cold-boot branch needed.)
  - Any **future idle-revert / display-wake** (owned by the display-power work in
    `docs/camera-support-plan.md`) must land on the Timer view while a timer is
    `running`/`fired`, and on Home/Today otherwise.
- **Explicit navigation always wins and is never overridden.** A mode tab, the
  brand lockup / Home control, and a voice `show_view` all go exactly where asked
  while the timer keeps counting. `goHome()` goes Home — full stop. There is no
  `defaultView()` indirection on the navigation path; the only automatic switch is
  the edge effect:

  ```
  useEffect(() => {
    if (timers.hasActiveTimer && !hadActiveTimerRef.current) setMode('timer')
    hadActiveTimerRef.current = timers.hasActiveTimer
  }, [timers.hasActiveTimer])
  ```

  It fires **once**, on the `false → true` edge, so replacing a timer (which stays
  `hasActiveTimer` throughout) does not re-yank the view — `onStarted` handles
  that case by design.
- There is still **no generic idle-return-to-default** in the app; "revert after N
  seconds of no touch" belongs with the display-state work.

### Cross-view timer tracking

When the Timer view is not on screen, the soonest-to-fire timer's remaining time
lives on the **Timer dock button** — not the header (whose budget is reserved for
temporal context + the two global actions, per `AGENTS.md`), not a floating chip
(which would occlude content).

- The dock button is already the timer's spot in the persistent chrome and its
  position is spatially stable, so augmenting it displaces nothing and stays
  durable across Home / Week / Month.
- Format is calm: `M:SS` under an hour, `H:MM` past it — a multi-hour timer must
  not tick seconds in the chrome. `Done` while `fired` (button blinks).
- It is **hidden on the Timer view itself** — the full-bleed countdown there
  already carries it (the "one authoritative location per fact" rule).
- "Soonest-to-fire" is worded for the eventual N-timer world; with one timer it is
  just that timer. `useTimers()` already exposes `remainingMs` / `alarm`.
- No new render cost: `useTimers()` already publishes `remainingMs` at 1 Hz while
  a timer is active, so `App` re-renders every second regardless of view.

### Visual separation: the Timer view is a role mode, not a calendar view

Home / Week / Month are calendar-viewing modes; Timer is an appliance/role mode.
The chrome now says so, using patterns already established for "this control is a
different kind of thing" (the contextual Today action: distinct shape + colour,
placed visually outside the mode group):

- **In the dock**, the Timer button sits after a gap + a hairline divider from the
  Home/Week/Month group, and wears the timer's **coral identity** — a coral fill
  when it is the active view (the calendar modes use the neutral ink fill), and a
  quiet coral outline + countdown when a timer runs in the background. Coral is
  the system's existing "now / live / alarm" accent (today highlight, brand icon,
  `voice-listening`, the alarm surface), so this reads as continuous with it.
- **In the view frame**, the Timer view is a warm, self-contained panel
  (`--warm` ground, hairline border, soft radius) instead of sitting straight on
  the cool `--canvas` like the borderless calendar grids — stepping into it reads
  as a change of room. Warm tones are already the "active / attention" register
  in this palette (today cell, Today pill, alarm).

### Physical display stays awake (future integration seam)

The requirement "the screen should remain on while a timer is active, and the
signals that would turn the screen off should instead revert to timer display"
depends on display-power control that **does not exist yet** — it is designed in
`docs/camera-support-plan.md` (Phase 1, "Display Power Control") and unbuilt.

This plan defines the seam so the later implementer can honour it:

1. **Now, best-effort:** while a timer is `running` or `fired`, the kiosk acquires
   a `navigator.wakeLock('screen')` and releases it when no timer is active. This
   keeps many setups awake without any OS integration. Re-acquire on
   `visibilitychange` (wake locks drop when the tab is hidden); tolerate the
   promise rejecting (unsupported browser, denied) — it is a stopgap, not a
   guarantee.
2. **When display-power control lands:** the presence/inactivity policy in the
   camera plan must treat "a timer is `running` or `fired`" as a **keep-awake
   vote**, equal in weight to touch and active voice. And when that policy would
   otherwise sleep the display, if a timer is active it must instead **switch the
   view to the Timer tab and keep the panel powered** rather than issue the
   sleep/standby command. On `fired`, it must wake the display if asleep.
3. The seam: `useTimers()` exposes `hasActiveTimer` and `alarm`; the future
   display-power controller consumes those semantic booleans, not timer internals.
   Add a one-line note to `docs/camera-support-plan.md`'s presence-policy section
   during implementation so the two plans stay consistent.

### Expiry audio cue

- **Asset:** bundle one short (~1–2s) chime under `frontend/public/` (e.g.
  `timer-chime.ogg` + an `.m4a`/`.mp3` sibling for Safari). Pick something gentle
  and recognisable — a soft two-note marimba/bell, not a klaxon. Source it from a
  CC0 library (freesound.org CC0, Material sounds, or a self-made tone) and record
  the source + licence in a new `docs/credits.md`. Add a durable one-liner to
  `AGENTS.md` that bundled media should have its provenance noted in
  `docs/credits.md` — lightweight, not a review process.
- **Fallback:** if nothing suitable is found, synthesise it with WebAudio — two
  sine/triangle partials with a short percussive envelope, played every ~2s,
  optionally tightening the interval slightly after the first minute so an ignored
  timer becomes more insistent without changing timbre.
- **Loop + backstop:** loop from `state === 'fired'` until `dismiss()`, or until
  `timer_alarm_max_ring_seconds` (default 5 min) elapses — then stop the sound but
  keep the visual "Timer finished" state until a person dismisses it.
- **Autoplay:** browsers block audio with no prior user gesture. The kiosk almost
  always has had one, but handle the cold case: reuse the voice `AudioSink`
  pattern (`frontend/src/voice/audio.ts`) — create/resume an `AudioContext` on the
  first touch anywhere in the app and keep it warm. If the context still can't
  play when a timer fires, fall back to a visual-only alarm and log it.
- **Multi-screen:** with backend-owned timers every connected screen receives the
  `fired` push and every screen rings. Acceptable for now (there is one screen);
  note it.

## Voice work

Timers are the **first voice tools that change state**. `AGENTS.md` and
`docs/voice-support-plan.md` currently say voice is strictly read-only. The
implementation task must:

- Add a short paragraph to both documents: voice may create/cancel/extend
  **timers** — ephemeral, local, single-household appliance state with no external
  side effect and no calendar/provider write. Calendar writes remain out of scope.
- Add tool declarations to `backend/app/voice/tools.py` (the source of truth locked
  into every ephemeral token) and mirror them in `frontend/src/voice/tools.ts`:

| Tool | Args | Dispatch | Result to agent |
| --- | --- | --- | --- |
| `start_timer` | `duration_minutes: number` (or `duration_seconds`), `label?: string` | `POST /api/timers` | `{ ok, fires_at, label, replaced_label? }` — the agent mentions `replaced_label` when set ("replacing your pasta timer") — or `{ error }` if > 6h / invalid |
| `cancel_timer` | — (the single timer) | `DELETE /api/timers/{id}` | `{ ok }` / `{ error: "no timer running" }` |
| `extend_timer` | `add_minutes: number` | `PATCH /api/timers/{id}` | `{ ok, fires_at }` or `{ error }` if the new total > 6h |
| `pause_timer` | — | `POST /api/timers/{id}/pause` | `{ ok }` / `{ error }` |
| `resume_timer` | — | `POST /api/timers/{id}/resume` | `{ ok }` / `{ error }` |
| `restart_timer` | — | `POST /api/timers/{id}/restart` | `{ ok, fires_at }` / `{ error }` |
| `get_timer` | — | `GET /api/timers` | `{ running: bool, paused: bool, remaining_minutes, label }` |

- **6h rejection in the agent's voice:** the tool schema description states the
  cap; the dispatcher returns `{ error: "Timers can be at most six hours." }` when
  the backend 422s, and the system prompt instructs the agent to say so briefly
  rather than silently failing.
- **System prompt** (`backend/app/voice/prompt.py`): add a line that the agent can
  set, cancel, and extend a single kitchen timer up to six hours, and that setting
  a new one replaces the current one. Keep "you cannot add/change/delete calendar
  events".
- **Dismissing the alarm by voice:** "stop" / "dismiss the timer" while a timer is
  `fired` maps to `cancel_timer`. Note that the one-session-per-turn model means a
  fired timer does **not** open a voice session on its own — the chime is plain
  audio; a person taps Ask (or the wake word, later) and says "stop", or taps
  Dismiss.
- **No spoken announcement on fire** in this task (would require the assistant to
  open an output-only Live session with no user turn — a real design change).
  The chime + forced Timer view is the notification; revisit with the wake-word
  work.
- **Token constraint test:** `backend/tests/test_voice.py::
  test_token_minted_with_locked_constraints` asserts the exact tool-name set — it
  must be updated to include the timer tools.
- `show_view` gains `"timer"` in its enum on both sides.

## The six-hour cap — enforcement summary

| Layer | Mechanism | On violation |
| --- | --- | --- |
| `Timer` / `TimerCreateRequest` / `TimerExtendRequest` model | Pydantic validator, `1 <= seconds <= timer_max_seconds` | `ValidationError` → HTTP 422 |
| Voice tool dispatch | schema description + backend 422 surfaced as `{ error }` | agent says "at most six hours" |
| Touch dial | control cannot be dragged / stepped past 6h; presets stop at 2h | no invalid state reachable |
| `extend_timer` / PATCH | validates `fires_at - now`, not just the increment | 422 / spoken error |

## Testing

Backend (`pytest`):

- `Timer` model: `fires_at > created_at`; duration `0` and `21601` rejected;
  `21600` accepted; `extend` past the cap rejected.
- Timer store: create replaces the previous timer and cancels its fire; cancel on
  empty is a no-op/404; extend re-arms; the fire callback marks `fired` and
  broadcasts (inject a fake clock / fake broadcast — no real `asyncio.sleep`).
- Endpoints via `TestClient`: `POST` happy path + 422 bounds; `PATCH` 404 + cap;
  `DELETE` 404; `_require_local` 403 from a non-LAN client (matches the voice-token
  test).
- WebSocket: on connect the client receives the current timer list; a create
  broadcasts a timer `ApplicationMessage` to a connected test client.
- `test_voice.py`: update the locked-tool-set assertion; add a case that a
  `start_timer` declaration carries the 6h limit in its description.

Frontend (`vitest`):

- `useTimers`: applies create/extend/cancel/fire WS messages; `remainingMs`
  counts down from `fires_at`; enters `alarm` when the clock passes `fires_at`
  even with no WS message (safety-net path); reconciles to `GET /api/timers` on
  reopen.
- Tool dispatch: `start_timer` / `cancel_timer` / `extend_timer` call the right
  endpoint with the right body; a backend 422 becomes an `{ error }` result.
- `TimerView`: dial cannot exceed 6h; Start disabled at 0; alarm state renders
  Dismiss and tapping the surface dismisses.
- Nav: the Timer tab switches `mode`; starting a timer routes to it; the Home
  control returns to Timer while active and to Home otherwise.

Playwright (`npm run test:e2e`):

- The Timer tab (setup, running, and fired states) fits 3840×2160 and 1920×1080
  with no document-level scroll.
- Starting a timer from the tab shows a running countdown; a short timer reaches
  the alarm state and Dismiss clears it. (Fake the chime / assert the element, not
  the audio.)

## Rollout / phases

1. **Backend core** — `Timer` models, `app/timers.py` store + scheduler,
   `/api/timers` CRUD, `_require_local` gate, unit tests. No UI.
2. **Push** — WS connection registry + `broadcast`, `ApplicationMessage` timer
   events, list-on-connect, tests.
3. **Timer tab** — `ViewMode='timer'`, dock button, `TimerView` (all three
   states), `useTimers()` hook, local-clock safety-net firing, default-view
   routing.
4. **Alarm** — chime asset + provenance note, WebAudio fallback, loop + backstop,
   AudioContext unlock, forced view switch, `navigator.wakeLock`.
5. **Voice** — timer tool declarations both sides, prompt update, dispatcher →
   REST, `show_view` enum, doc updates for the read-only exception, token test.
6. **Docs + DoD** — `AGENTS.md` (timer section + media-provenance line + voice
   exception), `.env.example` (`TIMER_MAX_SECONDS`,
   `TIMER_ALARM_MAX_RING_SECONDS`), `docs/credits.md`, a note in
   `docs/camera-support-plan.md` about the keep-awake vote. Full `pytest` /
   `ruff` / `vitest` / `tsc` / `eslint` / `vite build` / Playwright.

## Resolved since first draft

- **Default view** — the Timer view is the *ambient* default: start switches to
  the tab, fire force-switches, cold boot / a future idle-revert land there while a
  timer runs. It is **not** a lock — explicit navigation (mode tab, brand / Home,
  voice `show_view`) always wins (amended 2026-09-06; the earlier `defaultView()`
  indirection on the Home control is gone). When another view is on screen the
  Timer dock button carries the soonest timer's remaining time, and the Timer view
  is now visually separated from the calendar modes (coral dock identity + a warm
  panel). See **Default view while a timer is active**, **Cross-view timer
  tracking**, **Visual separation**.
- **Second timer** — silently replaces; all output (spoken + visual) names the
  replaced timer via `replaced` / `replaced_label`.
- **`navigator.wakeLock`** — yes, best-effort while a timer is active.
- **Alarm** — 5-minute audio backstop, visual finished-state persists until
  dismissed; dismiss from the tab, the alarm surface, or voice.
- **Spoken announcement on fire** — not in this task.
- **Labels** — preset chips on touch, free text via voice; no on-screen keyboard.
- **Minimum / granularity** — 5-second minimum, 1-second storage, 1-minute dial
  steps, no sub-minute touch path.

## Still open (fine to settle during build)

**O6 — `ApplicationMessage` shape.** Extend the existing envelope with optional
`timer` / `replaced` fields, or add a dedicated `TimerMessage` type? Either works;
flagged so the contract change is deliberate and mirrored in `App.tsx`'s
hand-written types.

**O9 — Backend restart reconciliation.** A restart clears timers (locked
decision). When the kiosk's WS reconnects to an empty `GET /api/timers` it should
**clear its local countdown** — backend is authoritative. Noting it so the
reconnect path isn't written to "keep firing locally" by reflex. A restart during
a `fired` alarm likewise clears it.

## Explicitly out of scope

Multiple concurrent timers (design accommodates, does not build); persistence of
timers across a backend restart; stopwatch / count-up mode; recurring or scheduled
timers; per-timer custom sounds; timers as calendar events; a spoken announcement
when a timer fires; voice-driven calendar writes (still out); display-power
control itself (owned by `docs/camera-support-plan.md`); wake-word activation of
"stop" (owned by `docs/wake-word-plan.md`); multi-screen timer routing via
`surface`.
