"""Server-side caching for the ``POST /api/voice/token`` path.

The kiosk's push-to-talk cold start pays for two things on every mint: a blocking
calendar-provider snapshot (a Graph request for the Outlook providers) and
Google's ``auth_tokens.create``. Two caches sit in front of the endpoint:

1. **Prompt snapshot cache.** The system prompt needs the household calendar
   names *and* a compact digest of the next ``voice_context_days`` of events
   (title / time / location — so a loose reference resolves without a tool
   call), and the freshness logic below needs event boundary *times*. All come
   from one ``[today, today + voice_context_days]`` snapshot, reused for
   ``voice_prompt_cache_ttl_seconds`` so a burst of mints shares one fetch.

2. **Ephemeral token cache.** A minted token freezes a system instruction that is
   stamped with the wall-clock time ("It is now Saturday … 11:30 PM"). Handing an
   old token out again means the agent reasons from that stale stamp. So a cached
   token is re-served only until the next moment the stamp could mislead it:

   * the **next calendar event boundary** (start or end) after the mint — so a
     "what's next" query can never name an event that has already ended, nor miss
     one that has already begun;
   * the **next local midnight** — "today" / "tonight" must not roll over;
   * a hard **staleness cap** (``voice_token_max_stale_seconds``) as a backstop
     for a long quiet stretch with nothing on the calendar.

   Whichever comes first is the token's ``good_until``. Past it, the next request
   mints fresh. Minting is cheap (that is the whole point of caching the snapshot
   in front of it), so there is deliberately **no minimum** horizon — right next
   to a boundary every turn re-mints, which is correct.

See ``docs/voice-token-caching-notes.md`` for the design record and follow-ups.
"""

from __future__ import annotations

import asyncio
import time
from dataclasses import dataclass
from datetime import date, datetime, timedelta

from fastapi.concurrency import run_in_threadpool

from app.calendar.provider import CalendarProvider
from app.config import Settings
from app.models import CalendarRange, CalendarSnapshot, VoiceToken, VoiceTokenRequest
from app.voice.base import VoiceUnavailable, local_now
from app.voice.prompt import build_schedule_digest
from app.voice.providers import get_adapter
from app.voice.trace import note, timed

# Kept below the Google-side ttl so a cached token always has room to still
# *open* a session when it is handed out.
_EXPIRY_MARGIN_SECONDS = 120


def _next_midnight(now_local: datetime) -> datetime:
    return datetime.combine(now_local.date() + timedelta(days=1), datetime.min.time())


def _event_boundaries(snapshot: CalendarSnapshot, after: datetime) -> list[datetime]:
    """Every event start/end strictly after ``after`` (all naive local)."""
    out: list[datetime] = []
    for event in snapshot.events:
        for boundary in (event.starts_at, event.ends_at):
            if boundary > after:
                out.append(boundary)
    return out


def freshness_horizon(
    now_local: datetime, boundaries: list[datetime], max_stale_seconds: int
) -> datetime:
    """The earliest of: the staleness cap, the next local midnight, and the next
    event boundary. Always strictly after ``now_local``."""
    horizon = min(
        now_local + timedelta(seconds=max_stale_seconds),
        _next_midnight(now_local),
    )
    future = [b for b in boundaries if b > now_local]
    if future:
        horizon = min(horizon, min(future))
    return horizon


@dataclass(frozen=True)
class _CachedToken:
    token: VoiceToken
    timezone: str | None
    minted_at_local: datetime
    good_until_local: datetime
    hard_expiry_local: datetime

    def is_fresh(self, now_local: datetime, timezone: str | None, provider: str) -> bool:
        return (
            self.token.provider == provider
            and self.timezone == timezone
            # A backwards clock jump (DST fall-back, a corrected kiosk clock)
            # invalidates the stamp comparison — mint fresh.
            and self.minted_at_local <= now_local < self.good_until_local
            and now_local < self.hard_expiry_local
        )


@dataclass
class _SnapshotEntry:
    snapshot: CalendarSnapshot
    day: date
    context_days: int
    at_monotonic: float


class VoiceTokenCache:
    """Process-wide, like ``app.realtime.connections`` and the MSAL client."""

    def __init__(self) -> None:
        self._token: _CachedToken | None = None
        self._snapshot: _SnapshotEntry | None = None
        self._lock = asyncio.Lock()

    def reset(self) -> None:
        self._token = None
        self._snapshot = None

    async def _prompt_snapshot(
        self, provider: CalendarProvider, day: date, ttl_seconds: int, context_days: int
    ) -> CalendarSnapshot:
        entry = self._snapshot
        now = time.monotonic()
        if (
            entry
            and entry.day == day
            and entry.context_days == context_days
            and now - entry.at_monotonic < ttl_seconds
        ):
            note("voice prompt snapshot: cache hit")
            return entry.snapshot
        with timed("calendar snapshot (voice prompt names + schedule digest + boundaries)"):
            # Sync provider call (blocking Graph request for Outlook) — keep it
            # off the event loop.
            snapshot = await run_in_threadpool(
                provider.snapshot,
                CalendarRange(starts_on=day, ends_on=day + timedelta(days=max(context_days, 1))),
            )
        self._snapshot = _SnapshotEntry(
            snapshot=snapshot, day=day, context_days=context_days, at_monotonic=now
        )
        return snapshot

    async def get(
        self, settings: Settings, provider: CalendarProvider, body: VoiceTokenRequest | None
    ) -> VoiceToken:
        if not settings.voice_enabled:
            raise VoiceUnavailable(
                "voice support is disabled (set MISSION_CONTROL_VOICE_ENABLED=true)"
            )
        adapter = get_adapter(settings)
        if reason := adapter.missing_config(settings):
            raise VoiceUnavailable(reason)

        timezone = body.timezone if body else None
        client_time = body.client_time if body else None
        surface = body.surface if body else None
        now_local = local_now(client_time)

        # Relay providers (Azure) hand out a single-use ticket — a cached grant
        # would be spent by its first turn and 4401 the next. Only Gemini's
        # multi-use token is safe to re-serve; every provider still shares the
        # prompt-snapshot cache below (that is the expensive Graph call).
        reusable = adapter.reusable_grant

        cached = self._token
        if reusable and cached and cached.is_fresh(now_local, timezone, adapter.id):
            note(f"voice token: cache hit (fresh until {_hhmm(cached.good_until_local)} local)")
            # `surface` is per-request routing metadata, not part of the locked
            # grant — echo back what this caller asked for.
            return cached.token.model_copy(update={"surface": surface})

        async with self._lock:
            # Another request may have minted while we waited for the lock.
            cached = self._token
            if reusable and cached and cached.is_fresh(now_local, timezone, adapter.id):
                return cached.token.model_copy(update={"surface": surface})

            snapshot = await self._prompt_snapshot(
                provider,
                now_local.date(),
                settings.voice_prompt_cache_ttl_seconds,
                settings.voice_context_days,
            )
            calendar_names = [calendar.display_name for calendar in snapshot.calendars]
            boundaries = _event_boundaries(snapshot, now_local)
            schedule = build_schedule_digest(snapshot, now_local)

            with timed(f"create voice grant ({adapter.id})"):
                token = await adapter.create_grant(
                    settings,
                    calendar_names=calendar_names,
                    surface=surface,
                    now_local=now_local,
                    timezone=timezone,
                    schedule=schedule,
                )

            max_stale = min(
                settings.voice_token_max_stale_seconds,
                settings.voice_token_ttl_seconds - _EXPIRY_MARGIN_SECONDS,
            )
            if reusable:
                good_until = freshness_horizon(now_local, boundaries, max(max_stale, 1))
                self._token = _CachedToken(
                    token=token,
                    timezone=timezone,
                    minted_at_local=now_local,
                    good_until_local=good_until,
                    hard_expiry_local=now_local
                    + timedelta(seconds=settings.voice_token_ttl_seconds - _EXPIRY_MARGIN_SECONDS),
                )
                note(
                    f"voice token: minted, fresh until {_hhmm(good_until)} local "
                    f"({int((good_until - now_local).total_seconds())}s)"
                )
            else:
                note(f"voice grant: minted fresh ({adapter.id}, single-use — not cached)")
            return token


def _hhmm(value: datetime) -> str:
    return value.isoformat(timespec="minutes")


cache = VoiceTokenCache()


async def get_voice_token(
    settings: Settings, provider: CalendarProvider, body: VoiceTokenRequest | None
) -> VoiceToken:
    return await cache.get(settings, provider, body)


def reset_voice_token_cache() -> None:
    cache.reset()
