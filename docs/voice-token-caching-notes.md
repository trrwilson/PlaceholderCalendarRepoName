---
status: historical
summary: Voice token and snapshot caching plus freshness rules.
---

# Voice token caching — implementation notes

Implemented 2026-09-06. Motivation: prior voice diagnostics
(`docs/voice-support-plan.md`, "Diagnostics" section) showed the `connecting`
phase of every push-to-talk turn paying for two backend hops that don't change
turn-to-turn — a blocking calendar-provider snapshot and Google's
`auth_tokens.create`. This work caches both.

## What shipped

### 1. Calendar snapshot cache (the "graph call" fix)

`POST /api/voice/token` used to call `calendar_provider.snapshot()` synchronously
on every request, only to read the household calendar display names for the
system prompt. For the Outlook providers that is a WAN Graph request (0.3–0.8 s
typical, worse on a cold MSAL refresh) sitting on the critical path.

`app/voice/cache.py` now fetches one `[today, tomorrow]` snapshot, reuses it for
`voice_prompt_cache_ttl_seconds` (default 120 s), and runs it in a threadpool
(`run_in_threadpool`) instead of blocking the event loop. The same snapshot also
supplies the event-boundary times the token cache needs (below), so it is fetched
at most once per mint regardless.

### 2. Ephemeral token cache

A minted token freezes a `system_instruction` stamped with the wall-clock time
("It is now Saturday, September 6, 2026 at 11:30 PM"). The agent reasons about
"today", "tonight", and "what's next" from that stamp. So the cached token is
re-served only until the **freshness horizon** — the earliest of:

| Bound | Why |
| --- | --- |
| next calendar **event boundary** (any `starts_at` / `ends_at` after the mint) | so "what's next" can't name an event that already ended, nor miss one that already began |
| next local **midnight** | "today" / "tonight" must not roll over |
| `voice_token_max_stale_seconds` (default 1800) | backstop for a long quiet stretch with nothing on the calendar |

Past the horizon the next request mints fresh. The cache is also invalidated by a
**timezone change** in the request and a **backwards clock jump** (DST fall-back,
a corrected kiosk clock — `minted_at_local <= now_local` guard).

The scenario this defeats (from the original ask): token minted at 11:00 with a
naive 60-minute expiry; a 30-minute event runs 11:05–11:35; at 11:40 someone asks
"what's next" and the agent, believing it is still 11:00, answers with the event
that has entirely finished. Here the horizon is clamped to 11:05, so the 11:40
turn is on a token stamped no earlier than 11:35.

There is **deliberately no minimum horizon**. Right next to a boundary every turn
re-mints — which is correct, and cheap, because the snapshot in front of the mint
is cached.

### 3. Longer Google-side token lifetime

To make caching possible the minted token changed:

- `expire_time` and `new_session_expire_time` both set to
  `voice_token_ttl_seconds` out (default **4 h**, was 600 s / 60 s). The Gemini
  API hard-caps this under 20 h. `new_session_expire_time` must match so a token
  the backend cached 25 min ago can still *open* a session.
- `uses` set to `voice_token_uses` (default **0 = unlimited** within the window,
  was 1) so one token backs many turns.

Security note (also in `AGENTS.md`): a longer-lived, multi-use token is a more
valuable thing to leak. Mitigations unchanged and still sufficient for a LAN
kiosk — the endpoint is `_require_local`-gated, and the token still carries the
full locked constraints (model, prompt, tools, voice, transcription, manual
activity detection), so a leaked token can only open more of the *same*
constrained session. `voice_token_uses` can be set to a small positive number to
tighten it.

## Config added (`app/config.py`, `backend/.env.example`)

| Setting | Default | Meaning |
| --- | --- | --- |
| `voice_token_ttl_seconds` | 14400 | Google-side `expire_time` / `new_session_expire_time` (repurposed; was 600) |
| `voice_token_max_stale_seconds` | 1800 | hard cap on re-serving a cached token |
| `voice_prompt_cache_ttl_seconds` | 120 | calendar snapshot reuse window |
| `voice_token_uses` | 0 | uses per token; 0 = unlimited within the ttl |

## Expected latency effect

Estimates (no checked-in kiosk traces; confirm from the `[voice]` timeline and the
backend `timed()` logs):

- Snapshot cache: removes ~0.3–0.8 s (up to ~1.5 s on a cold MSAL refresh) from
  every mint.
- Token cache hit: removes `auth_tokens.create` (~0.1–0.4 s) *and* the snapshot,
  leaving `POST /api/voice/token` as a ~5 ms LAN call.
- Warm connecting phase drops to roughly the unavoidable `ai.live.connect` /
  `setupComplete` WebSocket handshake (~0.2–0.6 s).

Cache-hit rate in normal use is high: consecutive turns in one conversation, and
follow-ups within the day away from event boundaries, all hit.

## Tests (`backend/tests/test_voice.py`)

`test_cached_token_is_reused_within_the_freshness_window`,
`_reminted_after_the_next_event_boundary`, `_reminted_across_local_midnight`,
`_not_shared_across_timezones`, `test_cache_hit_echoes_the_requesting_surface`,
`test_prompt_snapshot_is_shared_across_mints_within_its_ttl`. The fake
`auth_tokens.create` now returns incrementing names so identity/mint-count is
assertable. `conftest.py` resets the cache between tests via
`reset_voice_token_cache()`.

## Known assumptions / limitations

- **Kiosk and backend share a timezone.** Event boundary times come from the
  provider in the *backend host's* local zone; `now_local` comes from the kiosk's
  `client_time`. Same-LAN kitchen kiosk — already assumed project-wide (the prompt
  stamping and the dashboard both trust `client_time`).
- **Inconsistent `client_time` across requests would thrash the cache.** Every
  caller must send it (the kiosk always does, `frontend/src/voice/session.ts`).
- **A newly signed-in calendar takes up to `max_stale` to appear** in the voice
  prompt (the cached token keeps its old name list until the horizon).
- The cache is process-local and not shared across workers. The backend runs a
  single process today; a multi-worker deployment would mint once per worker.

## Follow-ups (not done)

1. **Keep the Live session open across turns.** The largest remaining
   `connecting` cost is the WebSocket handshake + `setupComplete`, paid every
   turn because `useVoiceSession` tears the session down on `turn-complete`
   ("one session per turn", `AGENTS.md`). Lingering the session for a short
   follow-up window (~45–60 s idle) and starting the next turn with
   `activityStart` removes that entirely and is the real win for rapid
   back-and-forth. Deferred because it rewrites the hard-won-stable state machine
   (teardown, watchdog, barge-in, sink lifecycle — see the six live-debug runs in
   `voice-support-plan.md`) and needs on-kiosk audio testing. Design sketch:
   - new status `follow_up` between `speaking`→`idle`; mic stopped, socket open;
   - a timer in `follow_up` calls `teardown()` on expiry;
   - `startTurn()` detects a live `sessionRef.current` and skips
     `connect()` / `startActivity()` reuse instead of tearing down;
   - `sessionResumption` to survive the Live API's ~10-min reconnect requirement
     if the window is ever raised that high.
2. **Client-side token prefetch.** Marginal now that a cache hit is a ~5 ms LAN
   call, but `prewarmVoice()` could also fetch a token on Ask-button hover / a
   wake-word partial so even that hop is off the tap. Only worth it if metrics
   show the LAN round-trip mattering.
3. **Proactive re-mint.** The backend could refresh the cached token just before
   the horizon (a background task) so even the mint-path turns never wait. Adds a
   scheduler; not justified yet.
4. **Share the cache across workers** (Redis / a small shared store) if the
   backend ever runs multi-process.
