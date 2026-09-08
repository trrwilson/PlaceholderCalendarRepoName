# Mission Control: Privacy mode — design plan

Status: **implemented (2026-09-07).** Backend store + endpoints + the read-only
gate, the kiosk redaction + lock UI, and the two voice tools are built and
covered by tests (`backend/tests/test_privacy.py`,
`frontend/src/privacy/*.test.*`, `frontend/src/voice/tools.test.ts`,
`frontend/src/App.test.tsx`, `frontend/e2e/privacy.spec.ts`). This document is
kept as the design record; **§0 records the ratified resolutions and what
actually shipped** and takes precedence where it is more specific than the
sections below.

This is a "privacy mode" that lets the kiosk obscure sensitive schedule and list
specifics for a houseguest while keeping the ambient shape of the day, and puts
the appliance into a verified read-only state until a household member unlocks it
with a PIN. It follows the shape of `docs/timer-plan.md` and `docs/lists-plan.md`.

---

## 0. Ratified resolutions and what shipped (2026-09-07)

The scope owner settled §2's flagged points as follows; the build matches.

| # | Resolution | Where it lives |
| --- | --- | --- |
| 1 | **One gate.** `_require_unlocked()` in `backend/app/api.py` — a single line on every mutating endpoint, **423 Locked** while privacy mode is on. New mutating endpoints add the line (Definition of Done). | `api.py`; `test_privacy.py::test_mutations_are_423_while_locked_reads_still_work` |
| 2 | **A firing alarm can still be silenced** with no PIN — `DELETE /api/timers/{id}` is allowed while locked *iff* that timer's `state` is `fired`. Everything else timer-side is 423. | `api.py::delete_timer` |
| 3 | Ratified — understated entry (press-and-hold the logo / Settings / voice), findable exit (a header padlock → PIN pad). Voice can **enter** privacy mode but never **exit** it. | `BrandLockup` in `App.tsx`; `enter_privacy_mode` tool |
| 4 | **MVP is a fixed four-digit PIN on a 0-9 keypad** (calculator layout `7-8-9 / 4-5-6 / 1-2-3 / 0`), backend-configured, **default `8426`** (traces up-left-down-right — 8 top, 4 left, 2 bottom, 6 right). The config validator requires exactly four digits. | `config.py::_check_privacy_mode_pin`; `frontend/src/privacy/PrivacyPad.tsx` |
| 5 | **Voice is NOT disabled** while locked. The session stays reachable; `dispatchToolCall` refuses every tool — including reads, so no titles are spoken — **except `request_privacy_unlock`** (which brings up the keypad) and `enter_privacy_mode`. Everything else gets a polite spoken refusal. | `frontend/src/voice/tools.ts`; `test_privacy.py::test_voice_sessions_are_not_gated_by_privacy_mode` |
| 6–7 | Acknowledged — the **cadence / "whose" leak is accepted**. This is a social/glance barrier, not privacy rigour. Category treatment still drops entirely (identity colour only). | `redactEvent` in `App.tsx` |
| 8 | **Entry is disabled unless a PIN is configured.** Blank `MISSION_CONTROL_PRIVACY_MODE_PIN` ⇒ `PrivacyState.available == false`, the kiosk hides the long-press / voice entry, and `POST /api/privacy/lock` 409s. | `privacy.py::PrivacyStore.available`; `test_privacy.py::test_lock_409s_without_a_configured_pin` |
| 9 | **Persisted across a restart** — one git-ignored JSON file (`MISSION_CONTROL_PRIVACY_STATE_FILE`, default `privacy.json`), same class as `lists.json`. A missing / corrupt file loads unlocked. Wrong-PIN lockout counters are process memory only. | `privacy.py::PrivacyStore._persist` / `_load` |
| 10 | Acknowledged in the doc and `AGENTS.md`: **not a security control.** Someone with sustained physical access to the host gets past it. | this doc; `AGENTS.md` |

### Redaction mechanism as built

The plan (§6) weighed a `RedactionContext` vs. prop-drilling (O3). The build took
a **third, lighter path**: `App.tsx` redacts at the point events are handed to
the views — `redactEvent(e)` returns `{...e, title: '•••', location: null,
categories: []}` — and forces `colorMode` to `people-first` (identity colour, no
category) and `onSelect` to a no-op while locked. No context, no new prop on the
six event components, no per-component edits. `ListsView` took one `redacted`
prop. The redacted title is the literal string `•••` in the normal `<strong>` —
nothing about the real title (length, shape) is in the DOM.

### Endpoints as built

`GET /api/privacy` · `POST /api/privacy/lock` (409 if no PIN) · `POST
/api/privacy/unlock {pin}` (401 wrong / 429 + `Retry-After` cooling / 409
disabled) · `POST /api/privacy/unlock/grace` (200 within the 8 s window, else
410). `PrivacyState` on the `/api/ws` hello and pushed on every lock / unlock via
`ApplicationMessage.privacy`. All `_require_local`-gated.

### Not built (deliberately deferred)

- **Local / Hybrid voice-pipeline intent** for privacy mode — the cloud path has
  `enter_privacy_mode` / `request_privacy_unlock`; the on-device interpreter
  (`app/voice/local/`) does not route to them yet, so `local` currently escalates
  or declines a spoken "privacy mode". Add a `privacy.on` intent when convenient.
- **Timer-view controls while locked** — `TimerView` still shows Start / Cancel /
  Pause; those hit the 423 and surface as a `timerNotice`. Defensive but not
  pretty; disable them behind a `locked` prop later.
- **Hold-to-reveal one event** (O6), **server-side title redaction** (O7),
  **stricter tiers** (O5), **presence auto-trigger** (O10) — all still future.

---

Scope owner note. The request: privacy mode should (a) obscure sensitive details
like event titles and (planned) list contents while preserving general shape — a
"nosy visitor" may see *when*, *how many*, and *who* an event belongs to, but not
*what* it is; (b) institute a **read-only** state covering current and future
functionality so a visitor cannot edit, add, or remove anything; (c) be **easy to
enter** but **very understated** in the overall UX; (d) require a **clear
verification from a legitimate user to leave** — MVP may use a pre-established PIN
or passphrase as an a priori secret. Explicitly **not** in MVP scope: any UI for
configuring the unlock credential.

---

## 1. Pattern inspirations

Surveyed per `docs/comparative-product-research.md`: family-calendar appliances
(**Skylight**, **Hearth Display**, **Cozi**, the 21.5" "HomeCal" class), smart
displays (**Google Nest Hub**, **Amazon Echo Show**), DIY dashboards
(**DAKboard**), kiosk-lockdown tooling (**iPad Guided Access / Single App Mode**,
**Fully Kiosk Browser**), the general calendar **visibility model** (Google
Calendar / Outlook), and adjacent **privacy-screen** patterns from banking /
password-manager apps.

### What the category does

| Capability | Who does it | Relevance to Mission Control |
| --- | --- | --- |
| **A one-tap "hide the calendar" mode on the device** | Hearth Display ("Privacy Mode" in Quick Settings → swaps calendar for a wallpaper) | Confirms the feature is real and expected on a wall appliance, and that the entry belongs in a quick, understated place. But Hearth is **all-or-nothing** — the schedule disappears entirely, taking the ambient utility with it. We diverge: redact specifics, keep the shape. |
| **Show the shape, hide the content** (free/busy; `private` event visibility → a "Busy" block that still leaks start, end, owner) | Google Calendar, Outlook, Fantastical | This is the industry-standard answer to exactly the brief. Adopt its vocabulary ("busy", "free/busy") and accept the same residual leak (timing + owner). |
| **Per-profile / per-person visibility** rather than per-event | Skylight (show/hide events by profile), Nest Hub (personal results per device / per Face Match) | A *stricter* future tier (hide one person's events entirely) but not the MVP — the brief wants "who" preserved. |
| **Understated entry, gated exit** | iPad Guided Access (triple-click in, passcode out), Fully Kiosk Browser (PIN/gesture to exit) | The exact interaction shape for (c)+(d). Guided Access also shows the two enforcement tiers: on-device and bypassable (our MVP) vs. MDM-enforced and reboot-proof (out of scope). |
| **A credential gate is expensive on an input-poor always-on device** | DAKboard (password screens unavailable without keyboard/touch; re-enter after every restart / IP change) | Direct constraint lesson. Favour a numeric PIN + on-screen pad; expect a restart to need re-entry (or persist — see §2); keep the exit affordance *findable*. |
| **Separate "who is here" from "what is shown"** | Nest Hub (Face/Voice Match feeds personal-results policy; photos always show) | The hook for a future auto-privacy trigger from presence detection (`docs/camera-support-plan.md` Phase 2) without coupling the two now. |
| **Auto-blur on context change; tap- or hold-to-reveal** | Banking / password-manager privacy screens | "Press and hold an event to reveal its real title for a few seconds" is a candidate affordance for a legitimate user mid-privacy-mode without a full unlock. Deferred (open question O6). |
| Swap calendar for a photo / screensaver; auto-dim "private from a distance" | Hearth, the HomeCal class | Rejected as the primary mechanism (loses ambient value); a photo wallpaper is a possible *additional* stricter tier later. |

### What to deliberately not copy

- **Hearth's all-or-nothing blank.** The brief explicitly wants "general shape"
  preserved. Replacing the grid with a photo is the easy build and the weak UX.
- **A configurable in-app credential.** Out of MVP scope by direction, and it is
  the part of a lock feature most likely to be built wrong the first time
  (recovery, per-person secrets, lockout). Keep the secret in backend config.
- **DAKboard's "retype the password on every restart".** Decide persistence
  deliberately (§2) rather than inheriting this by accident.
- **Skylight's real answer** ("just don't sync the sensitive events") — that is
  the absence of this feature, not a design for it.
- **A privacy mode that only changes the UI.** A visitor is at the touchscreen,
  but "read-only for current *and future* functionality" is a promise best kept
  by enforcing at the API boundary, not by hiding buttons (§4).

**Sources:**
[Hearth Display — Meet Our New Privacy Mode](https://hearthdisplay.com/blogs/hearth-at-home/meet-our-new-privacy-mode) ·
[Skylight Support — Settings](https://skylight.zendesk.com/hc/en-us/articles/45795554249371-Settings) ·
[Everblog — Digital Family Calendar Privacy](https://everblog.com/blogs/life-with-everblog/digital-family-calendar-privacy-secure-setup) ·
[Google Calendar — Change event visibility](https://support.google.com/calendar/answer/34580) ·
[Google Nest — Guest Mode](https://support.google.com/googlehome/answer/10217706) ·
[DAKboard — Screen Security with Password-Protected Screens](https://dakboard.freshdesk.com/support/solutions/articles/35000233523-screen-security-with-password-protected-screens) ·
[Apple — Guided Access / Single App Mode overviews](https://www.esper.io/blog/ipad-kiosk-mode-a-guide-to-ipados-guided-access-and-beyond) ·
[Fully Kiosk Browser](https://www.fully-kiosk.com/en/)

---

## 2. Contradictions and unclear points in the brief

Flagged per the request. Each has a recommendation; settle during design if a
household preference should override.

1. **"Read-only for current *and future* functionality" vs. the existing voice
   write exceptions.** Voice can already set/cancel/extend/pause/resume/restart a
   timer and (in progress, `docs/lists-plan.md`) mutate the grocery list — the
   two documented exceptions to voice being read-only. Does privacy mode's
   read-only lock also freeze those?
   *Recommendation:* **yes — privacy mode is a single hard read-only gate over
   every mutating endpoint**, enforced by a shared backend dependency (§4), so
   "future functionality" is covered by construction rather than by remembering
   to add a check. The voice read-only *exception* and the privacy-mode
   read-only *lock* are different axes: the exception says "voice may touch
   timers/lists"; the lock says "right now, nobody may, by any path".

2. **A firing timer during privacy mode.** If a timer fires while privacy mode is
   active, the chime rings and — under a strict read-only lock — nobody can
   dismiss it without the PIN. Bad during the dinner party the mode exists for.
   *Recommendation:* the alarm's 5-minute audio backstop
   (`timer_alarm_max_ring_seconds`) already bounds the noise; additionally,
   **allow "dismiss a *currently firing* alarm" as the one permitted mutation
   while locked** (it silences an appliance, it does not reveal or change
   household data). Starting, cancelling a *running* timer, extending, pausing,
   etc. stay blocked. Tracked as O2.

3. **"Easy to enter" vs. "leaving requires clear verification."** Deliberately
   asymmetric, and fine — entering privacy mode is the *safe* direction. Two
   consequences to design around:
   - The **entry** is understated (a long-press, a Settings row, a voice
     command). The **exit affordance** must still be *findable* by a legitimate
     user who does not already know the gesture — Fully Kiosk's "PIN hint on the
     exit gesture" is the cautionary tale. Resolution: a single small padlock
     glyph is always visible while locked; tapping it opens the PIN pad.
   - **Voice can enter privacy mode but cannot exit it.** Speaking a PIN aloud in
     front of the guest defeats the point, and voice is otherwise disabled while
     locked (item 5). The asymmetry is intentional; state it in
     `docs/voice-commands.md`.

4. **"PIN or passphrase" vs. the kiosk has no on-screen keyboard.** An
   established constraint (`docs/timer-plan.md`, `docs/lists-plan.md` O2: "no
   on-screen keyboard; free-text comes from voice"). A passphrase needs a full
   keyboard the app does not have.
   *Recommendation:* **MVP is a numeric PIN with an on-screen number pad** (cheap
   to build, reuses the timer-stepper visual grammar). A passphrase becomes
   possible only once an on-screen keyboard exists (the same follow-up
   `docs/lists-plan.md` O2 anticipates); the config setting is named generically
   so it can accept one later without a rename.

5. **Does privacy mode also silence voice?** The assistant reads event titles
   *out loud*. A nosy visitor could just tap **Ask** → "what's on today" and hear
   everything privacy mode is hiding on screen.
   *Recommendation:* **while locked, voice is fully off** — the **Ask** button is
   hidden, wake word is suspended, and `POST /api/voice/token` /
   `WS /api/voice/local` / `WS /api/voice/live` refuse to start a session (423).
   The one voice capability that remains reachable is *entering* privacy mode
   (before it is on), never anything once it is on.

6. **"Preserve who they're associated with" can itself leak.** "Travis, every
   Tuesday 5–6pm, ▓▓▓▓" plus a known cadence is legible even with the title
   redacted (a standing therapy slot, an AA meeting). The brief accepts this —
   "who" is explicitly to be preserved — but it should be **stated as a known
   residual leak** (the same one Google Calendar's `private` visibility has), and
   a **stricter tier** (redact owner too, or hide flagged calendars entirely)
   noted as a future option (O5).

7. **Category colour / the secondary-association triangle leak.** An event
   painted with the "Medical" category, or a category dot/label reading
   "Medical", reveals the kind of thing an event is even with the title gone.
   *Recommendation:* **privacy mode drops all category treatment** — the
   secondary triangle, `category-dominant` tinting, category dots/labels — and
   renders every event in **calendar-identity colour only**. Identity is the
   "who" the brief wants kept; category is "what", which it wants hidden.

8. **Global vs. per-screen.** Multi-screen is not built (one kiosk). Every other
   piece of shared state (timers, lists) is backend-owned and global.
   *Recommendation:* **backend-owned, household-global**, broadcast over
   `/api/ws`. A future `surface`-scoped "just this screen" is a refinement, not a
   redesign (`VoiceTokenRequest.surface` already reserves the concept).

9. **Persist across a backend restart?** Timers do not (accepted); lists do (a
   JSON file). If privacy state does **not** persist, a restart is a trivial
   bypass — unplug the kiosk, plug it back in, calendar is legible. If it
   **does** persist, "leaving requires verification" is honoured even across a
   power cycle, at the cost of a persistence path and a documented recovery.
   *Recommendation:* **persist it** — one JSON file, the same class as
   `lists.json` and the MSAL cache. Recovery when the PIN is forgotten: set /
   change `MISSION_CONTROL_PRIVACY_MODE_PIN` in `.env` and restart, or delete the
   state file. Documented, physical-access-only — consistent with the appliance's
   existing trust model. Tracked as O1 in case the household prefers the lighter
   "restart clears it".

10. **This is a social barrier, not a security control.** State it plainly in the
    doc and in `AGENTS.md`: privacy mode stops a *houseguest glancing at the
    wall*. It does not stop someone with sustained physical access to the kiosk PC
    (restart, dev tools, the LAN). The unlock endpoint is rate-limited to make
    casual PIN-guessing tedious, nothing more.

---

## 3. Decisions locked in

| Question | Decision |
| --- | --- |
| **What privacy mode does** | Two things at once, as one state: (a) **redaction** — event titles, locations, notes, and category become non-legible on every surface; the day's *shape* (how many, when, how long, whose) stays; (b) **read-only lock** — every mutating path is refused until unlock. Both are driven by one backend flag. |
| **What stays visible** | Event count ("3 things on the rhythm"), start/end time and duration, all-day / multi-day span shape, **calendar-identity colour and person name/initial**, the grid/agenda layout itself, date, clock, holidays, and operational status cards (offline, "garage door open") that carry no event title. |
| **What is obscured** | Event **title** → a fixed neutral placeholder (see next row). Event **location** and **notes** → omitted. **Category** → dropped entirely (colour, triangle, dots, labels). The **event-detail sheet** does not open. Voice → off. Any status/exception card whose text embeds an event title → redacted or suppressed. |
| **How a title is obscured** | A **deterministic placeholder**, not a blur. Render a short fixed glyph run (`•••`) or the word **"Busy"** — never the real string transformed. Rationale: CSS blur still leaks length, capitalisation, ascender shape, and word count, and "unblurs" under trivial image processing. A placeholder leaks nothing. (Blur rejected; recorded in O4 in case the household finds `•••` too stark and prefers "Busy".) |
| **Entering** | Three ways, all landing on `POST /api/privacy/lock` (no secret needed — the safe direction): (1) **long-press the brand lockup** in the header (~700 ms; short press still goes Home — same press-vs-gesture disambiguation the `ViewPager` swipe already uses); (2) a **"Privacy mode" row at the bottom of Settings**; (3) **voice** — "Mission Control, privacy mode" / "hide the calendar". |
| **The accidental / prank-entry guard** | For **8 seconds** after entering, a transient **"Privacy mode on — Undo"** notice (reuses the `timerNotice` pattern) exits with **no PIN**. After that window the PIN is required. Covers a mis-fire and a guest toggling it as a joke without weakening the real barrier. |
| **Leaving** | Tap the **padlock glyph** (always visible in the header while locked) → a **PIN pad sheet** → `POST /api/privacy/unlock { pin }`. Backend validates against `MISSION_CONTROL_PRIVACY_MODE_PIN` with `secrets.compare_digest`. Success broadcasts the unlock; wrong PIN shakes the pad and increments an attempt counter; after `privacy_unlock_max_attempts` (default 5) the pad is disabled for `privacy_unlock_cooldown_seconds` (default 60), doubling on each subsequent lockout up to a cap. |
| **The secret** | **Backend config only** — `MISSION_CONTROL_PRIVACY_MODE_PIN` (4–8 digits). **No in-app configuration** (out of MVP scope by direction). The PIN **never leaves the backend**: the kiosk POSTs the attempt, the backend decides. Same posture as `GEMINI_API_KEY_MISSION_CONTROL`. |
| **Feature gate** | Privacy mode is **inert unless a PIN is configured.** With no PIN set, the entry affordances are absent and `POST /api/privacy/lock` 409s — you cannot get into a state you cannot get out of. Mirrors "wake word does nothing without a model". |
| **Ownership / transport** | **Backend-owned, household-global**, persisted to one JSON file (`MISSION_CONTROL_PRIVACY_STATE_FILE`, default `privacy.json`, git-ignored), broadcast over `/api/ws` via the existing `ApplicationMessage` envelope. The store never imports the socket layer (injected broadcast callback), like `TimerStore` / the list store. |
| **Read-only enforcement** | A shared FastAPI dependency `_require_unlocked` on **every mutating endpoint**. Returns **423 Locked** while privacy mode is on. The DoD checklist gains a line: *a new mutating endpoint adds `_require_unlocked`*. The frontend *also* hides the controls, but the boundary is the guarantee. |
| **Firing-alarm exception** | `DELETE /api/timers/{id}` is permitted **only when that timer's state is `fired`** while locked (silence the chime). Every other timer/list/calendar/voice mutation is 423. Tracked O2. |
| **Persistence of privacy state** | **Persisted** (O1 — revisit if "restart clears it" is preferred). A missing / corrupt file loads as unlocked (never brick a boot over the privacy file). |
| **Not a security control** | Documented as a social/glance barrier. Bypassable with physical access to the host. |

---

## 4. Architecture

```
┌──────────────────────────── kiosk browser ────────────────────────────┐
│  usePrivacy() hook  ◀── PrivacyState from GET /api/privacy + ws push   │
│     │                                                                  │
│     │  locked === true  ⇒                                              │
│     │    • <RedactionProvider> wraps the view frame:                   │
│     │        event components render `•••` for title, drop category,   │
│     │        omit location; EventDetail is inert                       │
│     │    • header: Ask / Add / People / Settings hidden; padlock shown │
│     │    • wake word suspended; voice session refused                  │
│     │    • dock: mode nav + Today + running-timer countdown only       │
│     │                                                                  │
│     │  enter:  long-press brand │ Settings row │ voice  → POST .../lock │
│     │  exit:   padlock → PrivacyPad → POST .../unlock { pin }          │
│     ▼                                                                  │
│  every mutating fetch may now come back 423 → surfaced as a toast      │
└───────────────────────────────────────────────────────────────────────┘
     backend: owns the flag, persists it, validates the PIN, broadcasts,
              and refuses every write while it is set (_require_unlocked)
```

Why this shape:

- **One flag, two effects.** Redaction and the read-only lock are the same state.
  A surface never has to ask "am I redacting?" and "am I read-only?" separately.
- **Enforce at the boundary, decorate in the UI.** The brief's "future
  functionality" clause is a promise about endpoints that do not exist yet. A
  shared dependency keeps that promise for free; hidden buttons are the visible
  courtesy on top.
- **The secret stays server-side**, like every other secret in this repo. The
  kiosk holds no credential and cannot be made to leak one.
- **Reuse the envelope, not a new channel.** `ApplicationMessage` already carries
  timers and lists; privacy is one more optional field (`docs/lists-plan.md` O3 —
  keep the type, do not build a bus).
- **Redaction is a render concern, not a data concern.** The snapshot the backend
  sends is unchanged — full titles still cross `GET /api/calendar` (LAN-gated,
  same as today). The kiosk chooses not to *render* them. This keeps the
  provider-neutral contract intact and means unlock is instant (no refetch). The
  trade: the real titles are in the browser's memory / devtools while locked —
  acceptable under the stated threat model (item 10); noted so a future "redact
  server-side too" is a known option (O7).

---

## 5. Backend work

### Models (`app/models.py`)

```
PrivacyState
  locked: bool
  since: datetime | None          # naive local, per AGENTS.md; None when unlocked
  # advisory only — the kiosk uses it for the "Privacy mode since 7:12pm" note
```

`ApplicationMessage` gains one optional field:

```
  privacy: PrivacyState | None    # current state, for reconciliation + push
```

Message types: `privacy-locked` / `privacy-unlocked`.

No request model for lock (empty body). Unlock body: `PrivacyUnlockRequest { pin: str }`.

### Privacy store (`app/privacy.py`, new — mirrors `app/timers.py` / `app/lists.py`)

- Module-level singleton; `get_privacy_store()` / `reset_privacy_store()` (tests).
- Holds `locked: bool`, `since: datetime | None`, and unlock-attempt bookkeeping
  (`failed_attempts: int`, `locked_out_until: datetime | None`).
- On construction: load `MISSION_CONTROL_PRIVACY_STATE_FILE` if present; a
  missing / corrupt / disabled-persistence file → unlocked. Never raise on load.
- `lock(*, now)` — set `locked`, stamp `since`, persist, broadcast. Idempotent.
- `unlock(pin, *, now) -> UnlockOutcome` — `disabled` (no PIN configured) /
  `locked_out` (cooldown active) / `bad_pin` (increment, maybe start cooldown) /
  `ok` (clear state, persist, broadcast). `secrets.compare_digest` against
  `settings.privacy_mode_pin`.
- `force_unlock()` — no PIN, for the 8-second undo window and for tests /
  lifespan shutdown. The API exposes it **only** within the undo grace period
  (the store tracks `since` and checks `now - since <= grace`).
- `state() -> PrivacyState`.
- Injected `now` callable (house style — cf. `MockCalendarProvider.today`) and an
  injected broadcast callback (no socket import).
- Persistence: atomic temp-file + `os.replace`. Blank
  `MISSION_CONTROL_PRIVACY_STATE_FILE` → in-memory only (the O1 "restart clears
  it" behaviour without a code change).

### Read-only gate (`app/api.py`)

```python
def _require_unlocked(request: Request) -> None:
    store = get_privacy_store()
    if not store.locked:
        return
    # narrow exception: silence a *currently firing* alarm (see O2)
    if _is_firing_timer_dismiss(request):
        return
    raise HTTPException(status_code=423, detail="privacy mode is on")
```

Applied as a dependency to **every** mutating endpoint:

| Area | Endpoints |
| --- | --- |
| Timers | `POST /api/timers`, `PATCH /api/timers/{id}`, `DELETE /api/timers/{id}` (firing-alarm exception), `POST /api/timers/{id}/pause\|resume\|restart` |
| Lists | `POST /api/lists/{id}/items`, `PATCH …/items/{itemId}`, `DELETE …/items/{itemId}`, `POST …/clear`, `POST …/restore` |
| Calendar sign-in | `POST /api/calendar/auth/device`, `DELETE /api/calendar/auth/device`, `DELETE /api/calendar/auth` |
| Voice | `POST /api/voice/token`, `PUT /api/voice/config`, `WS /api/voice/live`, `WS /api/voice/local`, `POST /api/voice/debug/capture`, `POST /api/voice/local/interpret` |

Read endpoints (`GET /api/calendar`, `GET /api/timers`, `GET /api/lists`,
`GET /api/voice/config`, `GET /api/voice/wake-config`, `GET /api/privacy`) are
untouched — the kiosk still needs the data to render the redacted view.

### Privacy endpoints (`app/api.py`) — all `_require_local`-gated

| Method | Path | Body | Effect |
| --- | --- | --- | --- |
| `GET` | `/api/privacy` | — | Current `PrivacyState`. Always safe. |
| `POST` | `/api/privacy/lock` | — | Enter privacy mode. 409 if no PIN configured. Idempotent. |
| `POST` | `/api/privacy/unlock` | `PrivacyUnlockRequest` | 200 + new state on correct PIN; **401** bad PIN; **429** during cooldown (with `Retry-After`); **409** feature disabled. |
| `POST` | `/api/privacy/unlock/grace` | — | The 8-second no-PIN undo. 200 within the window; **410 Gone** after it. |

`WS /api/ws` on connect also sends the current `PrivacyState` (like it sends
timers and lists).

### Config (`app/config.py`, `.env.example`)

```
privacy_mode_pin: str | None = None      # 4–8 digits; None ⇒ feature inert
privacy_state_file: str = "privacy.json" # relative → backend wd; blank ⇒ in-memory
privacy_unlock_max_attempts: int = 5
privacy_unlock_cooldown_seconds: int = 60      # doubles per lockout, capped
privacy_undo_grace_seconds: int = 8
```

`privacy_mode_pin` validator: digits only, length 4–8; a non-conforming value is a
startup error (fail loud, like `mic_input_gain_db`). No feature flag beyond "is a
PIN set" — consistent with lists/timers being core rather than opt-in, but
gated on the credential the way voice providers are.

### `.gitignore`

Add `backend/privacy.json` (and `*.privacy.json`).

---

## 6. Frontend work

### `frontend/src/privacy/` (new — mirrors `frontend/src/timers/`)

- **`types.ts`** — `PrivacyState`, the message shape, mirrored constants
  (`UNDO_GRACE_MS`). `snake_case` in step with `app/models.py`.
- **`usePrivacy.ts`** — owns `PrivacyState`; subscribes to the shared app socket
  (see the note below); reconciles via `GET /api/privacy` on (re)open. Exposes:
  `locked`, `since`, `lock()`, `unlock(pin) → Promise<UnlockResult>`,
  `undo() → Promise<boolean>`, and `cooldown` (`{ active, retryAfterMs }`).
  Thin wrappers over the endpoints; the ws echo is authoritative.
- **`PrivacyPad.tsx`** — the exit sheet: a 3×4 numeric keypad (reuses
  `.timer-step` circle-button grammar), a masked entry row, a shake-on-wrong
  animation, a disabled/countdown state during cooldown. Reuses `.detail-sheet`.
  No text field, no keyboard.
- **`RedactionContext.tsx`** — a React context carrying `redacted: boolean`. This
  is the **first context in the app**; it earns it — redaction is read by ~6 leaf
  event components (`LargeEvent`, `CompactEvent`, `WeekEvent`, `EventChip`,
  `SpanBar`, `SpanBanner`) across three views and two sheets, and prop-drilling a
  `redacted` flag through every intermediate component (`HomeView`, `WeekView`,
  `MonthView`, `ViewPager`, `DayEventsSheet`, …) is exactly the "real complexity"
  `AGENTS.md` says to wait for. Alternative (explicit `redacted?: boolean` on
  `EventProps`, threaded from `App`) is recorded in O3 if the team prefers zero
  contexts.

### Event components (redaction points)

Each event component, when `redacted`:

- title → `<span className="redacted-title" aria-label="Hidden event">•••</span>`
  instead of `<strong>{event.title}</strong>`,
- no `<SecondaryTriangle>`, no `--category-color` / `category-dominant` class —
  force `semanticEventClass` to the calendar-identity branch regardless of colour
  mode,
- `location` line omitted,
- the owner name / `ProviderBadge` **stays** (that is the "who"),
- the button still renders at full size and is still laid out identically, but
  `onClick` is a no-op (no `EventDetail`).

`SpanBanner`'s "Day 2 of 5" label stays (shape, not content).

### `App.tsx`

- `usePrivacy()` alongside `useTimers()`.
- **Long-press entry** on `.brand-lockup`: `onPointerDown` starts a ~700 ms timer
  → `privacy.lock()`; `onPointerUp` / `onPointerLeave` / `onPointerMove` past a
  small slop cancels it; if it fired, suppress the trailing `click` (so `goHome`
  does not also run) — the same `onClickCapture` guard `ViewPager` uses for
  swipe.
- **While `privacy.locked`:**
  - header right cluster: hide **Ask**, **Add**, the wake-armed pill, the mic-live
    pill, and `SyncStatus`; show a single **`.privacy-lock`** padlock button
    (`aria-label="Exit privacy mode"`) that opens `<PrivacyPad>`. Keep the clock
    + date. Optionally a faint `.privacy-since` note ("Privacy since 7:12pm").
  - dock: hide the **People** filter and **Settings** toggles; keep the Home /
    Week / Month / Timer nav and the contextual **Today** (navigating and seeing
    the shape is fine). The running-timer countdown on the Timer dock button
    stays (not sensitive).
  - `selectedEvent` forced `null`; `filterOpen` / `settingsOpen` / `connectOpen`
    forced closed; `<VoiceOverlay>` / `<VoiceToast>` suppressed.
  - wrap `<section className="view-frame">` contents in
    `<RedactionContext.Provider value={{ redacted: true }}>`.
  - a subtle full-bleed marker: `.kiosk-shell.is-private` gets a faint corner
    watermark ("Privacy mode") — understated, and doubles as the "why does this
    look different / where do I exit" cue pointing at the padlock. Fades to very
    low opacity after ~5 s.
- **Voice:** pass `disabled={privacy.locked}` into `useVoiceSession` (or gate
  `startTurn`), and `enabled={!privacy.locked}` into `useWakeWord` so the detector
  suspends. A locked kiosk never opens a session.
- **423 handling:** a small helper around the mutating `fetch`es (timers/lists)
  that turns a `423` into a friendly notice ("Privacy mode is on — unlock to
  make changes") via the existing `timerNotice` / list-notice surface. Mostly
  defensive — the controls are hidden — but covers a race (privacy toggled from
  another screen mid-tap).
- **Undo:** on a successful `lock()`, show `timerNotice`-style
  **"Privacy mode on — Undo"** for `UNDO_GRACE_MS`; the Undo button calls
  `privacy.undo()`.

### Shared socket

`docs/lists-plan.md` proposes extracting `frontend/src/realtime/useAppSocket.ts`
(connect once, `subscribe(cb)`, reconcile-on-open) so `useTimers` and `useLists`
stop each owning a connection. **Privacy is a third consumer** — do the extraction
as part of whichever of lists/privacy lands second, and route `privacy-*` /
`timer-*` / `list-*` messages by `type`. If lists already did it, `usePrivacy`
just subscribes.

### `App.css`

- `.redacted-title` — a fixed inline-block, `letter-spacing` set so `•••` reads as
  a deliberate placeholder; `user-select: none`; inherits the event's text
  colour but at reduced weight.
- `.privacy-lock` — a quiet square button matching `.sync-status-flag` sizing,
  with a padlock glyph.
- `.privacy-pad` — keypad grid (reuse `.timer-step` circles), masked row,
  `@keyframes privacy-shake`, a dimmed cooldown state.
- `.kiosk-shell.is-private` + `.privacy-watermark` — low-opacity corner label,
  `pointer-events: none`.
- No new tokens — identity colours, `--warm`, `--muted` all exist.

### `frontend/src/voice/types.ts` / `tools.ts`

`ViewMode` is unchanged — privacy is an overlay state, not a view. If the voice
*enter* tool (O8 / Phase 4) is built: add `enter_privacy_mode` to the tool
contract on both sides and a dispatch case (`POST /api/privacy/lock`).

---

## 7. The redacted view — what it looks like

Home, locked (layout identical to unlocked; only the marked spans change):

```
┌ Today · 3 things on the rhythm ─────────────────────────  🔒  7:12 PM ┐
│                                                                       │
│  09:00   •••••                                    Travis ⧉        ›    │   ← time kept,
│  12:30   •••••                                    Sarah               │     title •••,
│  18:00   •••••                                    Travis ⧉            │     owner kept,
│                                                                       │     no category,
│  ── Coming up ──────────────  ── Tomorrow ──────────────────────────  │     no detail on tap
│  Wed  •••••   Sarah          Thursday, Sep 11                         │
│  Wed  •••••   Travis         •••••   Sarah                            │
│                                                                       │
│  ! Garage door open · Open for 43 minutes            [ Check garage ] │   ← operational card kept
└───────────────────────────────────── Privacy mode ───────────────────┘   ← faint watermark
```

- **Header:** brand + clock + date stay; the padlock replaces the Ask/Add/status
  cluster.
- **Month/Week:** the grid, day numbers, weekday labels, holidays, all-day lane
  shape, "+N more" counts, and span bars all render as normal; every event
  chip/bar shows `•••` for its title and its identity colour only.
- **`EventDetail` / `DayEventsSheet`:** tapping an event does nothing while
  locked. (`DayEventsSheet` opened from "+N more" — decision: **also inert while
  locked**, since it is a denser list of the same redacted rows; the "+N" count
  itself stays visible as shape. Tracked O9 — a redacted day sheet could be
  allowed since it reveals nothing new.)
- **Timer view:** fully usable to *watch* a running timer; Start / Cancel / Pause
  / Extend controls are disabled (423-backed), except Dismiss on a firing alarm.
- **Empty state:** "A clear rest of the day." is not sensitive — keep it.

### State machine

```
        long-press brand │ Settings row │ voice "privacy mode"
   unlocked ───────────────────────────────────────────────▶ locked
      ▲                                                        │
      │  POST /api/privacy/unlock {pin}  (correct)             │
      │  ◀───────────────────────────────────────────────────  │
      │                                                        │
      │  POST /api/privacy/unlock/grace  (within 8s of entry)  │
      └────────────────────────────────────────────────────────┘

   locked + wrong PIN ×5  ──▶  cooldown (60s, doubling)  ──▶  locked
   backend restart        ──▶  reloads persisted state (locked stays locked)
   PIN forgotten          ──▶  edit .env / delete privacy.json + restart
```

### Fallbacks and limitations (state in the doc and `docs/voice-commands.md`)

- **Not a security control** — see §2 item 10. A restart reloads the locked
  state, but someone with the host can edit config or the state file.
- **Residual leak:** event **timing**, **duration**, **count**, and **owner** are
  visible by design. A known cadence + a known person can still be legible.
- **Voice is off while locked** — no spoken readout, no wake word. The **Ask**
  button is gone; wake word silently suspends and resumes on unlock.
- **The real titles are in the browser** (§4) — devtools / view-source expose
  them. Out of scope to fix now; O7.
- **Another household screen** (if one ever exists) is redacted too — global by
  design.
- **A firing timer** can be silenced without the PIN (O2); nothing else.
- **PIN lockout** is per-backend-process and resets on restart — a nosy visitor
  cannot brute-force in a party's worth of time, and a legitimate user who
  fat-fingers five times waits 60 s.

---

## 8. Voice work

Privacy mode is **not** a state-mutating voice capability in the timers/lists
sense — it does not change household data, it changes what the appliance will
show and do. Entering it by voice is in the "safe direction" and touches no
provider.

### If the voice *enter* tool is built (Phase 4, optional)

| Tool | Args | Dispatch | Result |
| --- | --- | --- | --- |
| `enter_privacy_mode` | — | `POST /api/privacy/lock` | `{ ok }` — agent confirms "Privacy mode is on. Enter your PIN on the display to turn it off." |

- Added to `backend/app/voice/tools.py` (source of truth, locked into the token)
  and mirrored in `frontend/src/voice/tools.ts`.
- **No exit tool, ever** — see §2 item 3.
- System prompt (`backend/app/voice/prompt.py`): one line — the agent can turn on
  privacy mode when asked ("hide the calendar", "someone's coming over"), and
  must tell the person it takes the on-screen PIN to turn back off. It still
  cannot touch the calendar.
- `test_voice.py` locked-tool-set assertion updated to include it.
- The **Local / Hybrid** pipeline (`app/voice/local/`): add a `privacy.on` intent
  (weighted-regex, `mutating` but tier-0, always `handled_locally`) planning
  `enter_privacy_mode`; there is no `privacy.off` intent. Corpus +
  `test_voice_local_intent.py` updated.

### Regardless of the tool

- While locked, `POST /api/voice/token` and the voice WebSockets 423, so a locked
  kiosk cannot start any session by any provider.
- `docs/voice-commands.md` gains a **"Privacy mode"** section: how to turn it on
  (tap-and-hold the logo, Settings, or ask), that **voice is otherwise off while
  it is on**, and that **only the on-screen PIN turns it off** — you cannot do it
  by voice on purpose.

---

## 9. Testing

**Backend (`pytest`, `backend/tests/test_privacy.py` new):**

- Store: `lock()` is idempotent and stamps `since`; `unlock()` returns
  `disabled` with no PIN, `ok` with the right PIN, `bad_pin` otherwise;
  `privacy_unlock_max_attempts` wrong tries → `locked_out`, and the cooldown
  doubles; `force_unlock()` works only within `privacy_undo_grace_seconds`;
  the broadcast callback fires on every state change; persistence — a store over
  a temp file reloads `locked`, a corrupt file loads unlocked, blank file path ⇒
  in-memory.
- Config: a non-numeric / too-short `privacy_mode_pin` is a startup error.
- Endpoints via `TestClient`: `POST /lock` 409 with no PIN, 200 otherwise;
  `POST /unlock` 401 / 200 / 429 (with `Retry-After`) / 409; `/unlock/grace`
  200 then 410; `_require_local` 403 from a non-LAN client.
- **The read-only gate:** with privacy locked, one representative mutating
  endpoint per area (`POST /api/timers`, `POST /api/lists/{id}/items`,
  `DELETE /api/calendar/auth`, `POST /api/voice/token`) returns **423**; the
  matching **GET**s still 200; `DELETE /api/timers/{id}` on a **fired** timer
  still 204 while locked, on a **running** timer 423.
- WebSocket: on connect the client receives the current `PrivacyState`; a lock
  broadcasts a `privacy-locked` `ApplicationMessage`.
- `test_voice.py`: `POST /api/voice/token` 423 while locked; (if built) the
  locked-tool-set includes `enter_privacy_mode`.

**Frontend (`vitest`):**

- `usePrivacy`: applies `privacy-locked` / `-unlocked` ws messages; reconciles to
  `GET /api/privacy` on reopen; `unlock()` posts the PIN and resolves
  success/failure; `undo()` hits the grace endpoint; `cooldown` reflects a 429.
- Redaction rendering: in each of Home / Week / Month, a locked render shows
  `•••` for every title, no `.secondary-triangle`, no `.category-dominant`, the
  owner name still present, the time still present; `EventDetail` does not open
  on tap.
- `App`: long-press on the brand enters privacy mode and does **not** also call
  `goHome`; a short press still goes Home. While locked: Ask / Add / People /
  Settings are absent, the padlock is present, the voice overlay is suppressed,
  wake word is disabled.
- `PrivacyPad`: correct PIN calls `unlock` and closes; wrong PIN shakes and
  increments; the pad disables during cooldown and re-enables after; no text
  input anywhere.
- The "Undo" notice appears on entry and `undo()` exits without a PIN.

**Playwright (`e2e/privacy.spec.ts`):**

- Enter privacy mode (long-press the brand): every visible event title becomes
  `•••`, the People/Settings/Ask controls disappear, the layout is unchanged and
  there is **no document-level scroll** at 3840×2160 and 1920×1080.
- The padlock opens the pad; a wrong PIN is rejected; the configured test PIN
  exits and the real titles return.
- (If the voice enter tool is built and `VITE_VOICE_FAKE=1`) a scripted
  `enter_privacy_mode` tool call locks the display.

---

## 10. Rollout / phases

1. **Backend core** — `PrivacyState` model + `ApplicationMessage.privacy`,
   `app/privacy.py` store + JSON persistence + attempt/cooldown logic,
   `/api/privacy/{lock,unlock,unlock/grace}` + `GET`, config + validator,
   `.env.example`, `.gitignore`, unit tests. No UI, no gate yet.
2. **The read-only gate** — `_require_unlocked` dependency on every mutating
   endpoint (table in §5), the firing-alarm exception, `privacy` on the
   `/api/ws` hello, tests that each area 423s while locked.
3. **Kiosk redaction + lock UI** — `frontend/src/privacy/` (`usePrivacy`,
   `PrivacyPad`, `RedactionContext`), the shared `useAppSocket` extraction if not
   already done, event-component redaction points, `App.tsx` header/dock/voice
   changes, long-press entry, the Undo notice, `App.css`. Tests + Playwright.
4. **Voice** *(optional, severable)* — `enter_privacy_mode` tool both sides,
   prompt line, local-pipeline `privacy.on` intent, `docs/voice-commands.md`
   "Privacy mode" section, `test_voice.py` update.
5. **Docs + DoD** — `AGENTS.md` gains a "Privacy mode" section (what it does, the
   `_require_unlocked` rule for new endpoints, "social barrier not a security
   control"), the `docs/camera-support-plan.md` cross-note (Phase 2 recognition
   → auto-enter privacy mode is a future trigger), `.env.example`. Full
   `pytest` / `ruff` / `vitest` / `tsc` / `eslint` / `vite build` / Playwright.

---

## 11. Open questions (fine to settle during build)

- **O1 — persist the privacy flag across a restart?** Recommended: yes (one JSON
  file, matches `lists.json`; honours "leaving requires verification"). The
  lighter option is in-memory / restart-clears (blank `privacy_state_file`
  already gives this). A household that would rather a power-cycle just clear it
  should say so.
- **O2 — firing-alarm dismissal while locked.** Recommended: permit
  `DELETE /api/timers/{id}` only for a `fired` timer. Alternative: rely purely on
  the 5-minute chime backstop and block even that (simpler gate, noisier party).
- **O3 — redaction via context vs. prop.** Recommended: a single
  `RedactionContext` (first context in the app; justified by ~6 leaf consumers).
  Alternative: `redacted?: boolean` on `EventProps`, drilled from `App`.
- **O4 — placeholder glyph.** Recommended: `•••`. Alternative: the word "Busy"
  (matches calendar-industry vocabulary, reads less starkly at a distance). Not
  blur (leaks shape).
- **O5 — a stricter tier.** Redact the **owner** too, or hide specific
  calendars entirely (a "sensitive calendars" config list), or the Hearth-style
  photo wallpaper as an alternate privacy *level*. Out of MVP; the flag could
  become an enum (`off` / `redacted` / `blank`) without a redesign.
- **O6 — hold-to-reveal one event.** A legitimate user press-and-holding a single
  redacted event to see its real title for ~5 s (banking-app pattern) without a
  full unlock. Nice, but it is a reveal path that bypasses the PIN — only worth
  it if it is gated (e.g. only within the undo window, or itself PIN-gated).
- **O7 — redact server-side too.** Have `GET /api/calendar` return `title:
  "Busy"` (or omit it) while privacy mode is locked, so the real strings are not
  in the browser at all. Costs an unlock refetch and complicates the
  provider-neutral contract; the threat model does not require it. Revisit if the
  kiosk is ever less physically trusted.
- **O8 — voice enter tool.** Recommended: build it (Phase 4) — "hands full, guest
  at the door" is the exact use case. Severable if scope is tight.
- **O9 — the "+N more" day sheet while locked.** Recommended: inert (consistent
  with `EventDetail`). Could be allowed (redacted rows reveal nothing the grid
  does not).
- **O10 — auto-enter on presence (`docs/camera-support-plan.md` Phase 2).** When
  local person recognition exists, "an unrecognised person is present" could
  auto-enter privacy mode. Explicitly a **future** trigger; the seam is that
  privacy mode is a backend flag any in-process actor can set, exactly like the
  presence policy setting display state. Note in both docs during Phase 5.
- **O11 — a "privacy since" indicator on unlock.** Should the kiosk briefly note
  "Privacy mode was on for 2 hours" after unlock, so a returning household member
  knows the wall was redacted while they were out? Low stakes; easy to add.

---

## 12. Explicitly out of scope

In-app configuration of the unlock PIN/passphrase (by direction — backend config
only); per-person or per-calendar secrets; multiple privacy *levels* (the model
allows an enum later, the MVP ships one); a passphrase / any credential needing an
on-screen keyboard (blocked on the same follow-up as `docs/lists-plan.md` O2);
server-side title redaction (O7); hold-to-reveal (O6); auto-enter from presence
detection (O10, owned by `docs/camera-support-plan.md`); per-screen (non-global)
privacy; MDM / reboot-proof enforcement (the OS-kiosk layer, not this app);
treating privacy mode as a security boundary; hiding the *existence* of privacy
mode from someone inspecting the code or the running app; encrypting the calendar
snapshot in transit or at rest beyond what already exists.
