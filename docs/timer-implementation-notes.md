# Timer implementation — build notes & decisions for review

Implemented 2026-09-06 headlessly (scheduled task `implement-timer-plan`), from
`docs/timer-plan.md`. Everything the plan specified is built; below are the choices
made where the plan left room, plus things a human should sanity-check.

## Arbitrary / judgement decisions

1. **`ApplicationMessage` shape (open question O6).** Extended the existing
   envelope rather than adding a `TimerMessage` type. New optional fields:
   `timers: list[Timer] | None` (full current list, for reconciliation — sent on
   every timer broadcast *and* on socket connect), `timer: Timer | None` (the one
   that changed), `replaced: Timer | None`. Mirrored in
   `frontend/src/timers/types.ts` and consumed in `useTimers`. `App.tsx`'s
   hand-written model types were not touched because the kiosk reads timer
   messages through `useTimers`, not through `App.tsx`'s calendar types.

2. **`extend` rebases `created_at` to now.** The plan says extend "recompute
   `fires_at`" and keep `duration_seconds` as an unambiguous base. But keeping the
   original `created_at` while extending a nearly-elapsed long timer can push
   `duration_seconds` (= `fires_at - created_at`) past the 21600 model ceiling
   even when `fires_at - now` is well under 6h. So `extend` sets
   `created_at = now` and `duration_seconds = fires_at - now` for both the running
   and the fired (snooze) cases. Net effect: after an extend, "duration" means
   "time remaining when extended". The UI renders the countdown from `fires_at`
   regardless, so this is invisible in practice.

3. **Alarm chime is synthesised, not a bundled asset.** The plan allows a bundled
   CC0 chime *or* a WebAudio fallback. Running headless with no way to audition a
   sound file, I went straight to the fallback: `frontend/src/timers/chime.ts` —
   two sine partials, ~2 s repeat, tightening to ~1.4 s after the first minute.
   Provenance noted in `docs/credits.md`. Swapping in a real file later is a small
   change (replace the `ping()` body / add an `<audio>` element).

4. **Voice `start_timer` accepts an absolute `fires_at`** (local ISO, no offset)
   as an alternative to `duration_minutes`. The plan's tool table only lists a
   duration. Adding the absolute form makes "set an alarm for 3pm" and "thirty
   minutes before the party" reliable: the agent resolves the wall-clock target
   (looking the event up with `get_agenda`/`get_events` first for the "before X"
   case) and the frontend dispatcher converts it to a duration and re-checks the
   6h cap. Prompt guidance in `backend/app/voice/prompt.py` spells this out.

5. **"Timer" dock button is always visible** with a small dot when a timer is
   active and a pulsing dot while firing (per the plan). It sits after "Month".

6. **`timer` view skips the calendar fetch.** `App.tsx`'s calendar effect early-
   returns when `mode === 'timer'` so opening the tab doesn't fire a pointless
   month-range request.

7. **No backend lifespan hook.** The plan mentions `clear()` on lifespan
   shutdown; since a restart clears in-memory state anyway and `main.py` has no
   lifespan today, I left it — `reset_timer_store()` exists for tests and cancels
   scheduled fires.

8. **Pre-existing e2e flake fixed in passing.** `frontend/e2e/dashboard.spec.ts`
   hardcoded `2026-09-05` event dates and failed once the wall clock passed that
   day (noted in the repo memory as a known flake, not a regression). Its mock
   snapshot now anchors dates to "today". Unrelated to timers but it was blocking
   a clean `npm run test:e2e`.

## Things to sanity-check on real hardware

- The chime timbre/volume on the kiosk speakers (system-wide audio output was a
  past problem for voice — see repo memory).
- `navigator.wakeLock('screen')` actually holding on the kiosk browser; it is
  best-effort and silently tolerated if unsupported/denied.
- The multi-screen note stands: with backend-owned timers every connected screen
  rings. There is one screen today.
- Live Gemini behaviour for the three spoken phrasings ("15 minutes" / "an alarm
  for 3pm" / "30 minutes before <event>") — only promptable headless, not
  verifiable without a live session.

## Test / DoD status at hand-off

- `backend/`: `pytest` 69 passed (was 47), `ruff check` + `ruff format --check` clean.
- `frontend/`: `vitest` 56 passed (was 39), `tsc -b` clean, `eslint` clean,
  `vite build` clean.
- `frontend/`: Playwright 5 passed (was 4, one previously failing on the date flake).
