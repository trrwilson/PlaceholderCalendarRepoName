import ipaddress
from datetime import date, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

import app.calendar.personal_auth as personal_auth
from app.calendar.provider import CalendarProvider, MockCalendarProvider
from app.config import get_settings
from app.models import (
    ApplicationMessage,
    CalendarAuthStatus,
    CalendarRange,
    CalendarSnapshot,
    Timer,
    TimerCreateRequest,
    TimerExtendRequest,
    TimerMutationResult,
    VoiceConfig,
    VoiceConfigUpdate,
    VoiceProviderInfo,
    VoiceToken,
    VoiceTokenRequest,
    WakeWordConfig,
)
from app.realtime import connections
from app.timers import TimerError, get_timer_store
from app.voice import VoiceUnavailable, get_voice_token, reset_voice_token_cache
from app.voice.base import PROVIDER_LABELS
from app.voice.providers import (
    effective_provider,
    implemented_providers,
    provider_configured,
    set_provider_override,
)
from app.voice.relay import redeem_ticket, run_relay

router = APIRouter(prefix="/api")


@lru_cache
def _build_provider() -> CalendarProvider:
    settings = get_settings()
    if settings.calendar_provider == "graph":
        from app.calendar.graph import MicrosoftGraphCalendarProvider

        return MicrosoftGraphCalendarProvider(settings)
    if settings.calendar_provider == "outlook_personal":
        from app.calendar.outlook_personal import PersonalOutlookCalendarProvider

        return PersonalOutlookCalendarProvider(settings)
    return MockCalendarProvider()


def get_provider() -> CalendarProvider:
    return _build_provider()


def _is_local_client(host: str) -> bool:
    if get_settings().allow_remote_auth:
        return True
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        return False
    return address.is_loopback or address.is_private or address.is_link_local


def _require_local(request: Request) -> None:
    """Gate the calendar sign-in endpoints to loopback / LAN unless opted out."""
    host = request.client.host if request.client else ""
    if not _is_local_client(host):
        raise HTTPException(
            status_code=403,
            detail="this endpoint is only available on the local network",
        )


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/calendar", response_model=CalendarSnapshot)
async def get_calendar(
    starts_on: date | None = None,
    ends_on: date | None = None,
    calendar_provider: CalendarProvider = Depends(get_provider),
) -> CalendarSnapshot:
    start = starts_on or date.today().replace(day=1)
    end = ends_on or (start + timedelta(days=41))
    try:
        calendar_range = CalendarRange(starts_on=start, ends_on=end)
    except ValidationError as exc:
        message = "; ".join(error["msg"] for error in exc.errors())
        raise HTTPException(status_code=422, detail=message) from exc
    return calendar_provider.snapshot(calendar_range)


# -- calendar sign-in (outlook_personal provider) -----------------------------
# Sync `def` handlers: FastAPI runs them in a threadpool, and both MSAL and the
# QR generator do blocking work.


@router.get("/calendar/auth", response_model=CalendarAuthStatus)
def calendar_auth_status(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        return CalendarAuthStatus(provider=settings.calendar_provider, state="not_applicable")
    return personal_auth.get_status(settings)


@router.post("/calendar/auth/device", response_model=CalendarAuthStatus)
def calendar_auth_begin(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        raise HTTPException(status_code=409, detail="calendar provider is not 'outlook_personal'")
    return personal_auth.begin_sign_in(settings)


@router.delete("/calendar/auth/device", response_model=CalendarAuthStatus)
def calendar_auth_cancel(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    return personal_auth.cancel_sign_in(get_settings())


@router.delete("/calendar/auth", response_model=CalendarAuthStatus)
def calendar_auth_signout(request: Request) -> CalendarAuthStatus:
    _require_local(request)
    settings = get_settings()
    if settings.calendar_provider != "outlook_personal":
        raise HTTPException(status_code=409, detail="calendar provider is not 'outlook_personal'")
    return personal_auth.sign_out(settings)


@router.post("/voice/token", response_model=VoiceToken)
async def voice_token(
    request: Request,
    body: VoiceTokenRequest | None = None,
    calendar_provider: CalendarProvider = Depends(get_provider),
) -> VoiceToken:
    """Hand the kiosk a constrained ephemeral token for its Gemini Live session.

    Backed by two caches (``app/voice/cache.py``): the calendar snapshot the
    system prompt is built from, and the minted token itself. A cached token is
    re-served only until the next event boundary / local midnight / staleness cap,
    so the agent never reasons from a "what's next" that has gone out of date.
    """
    from app.voice.trace import note

    _require_local(request)
    note("token request received")
    try:
        return await get_voice_token(get_settings(), calendar_provider, body)
    except VoiceUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


def _voice_config() -> VoiceConfig:
    settings = get_settings()
    implemented = set(implemented_providers())
    return VoiceConfig(
        enabled=settings.voice_enabled,
        provider=effective_provider(settings),
        mic_input_gain_db=settings.mic_input_gain_db,
        providers=[
            VoiceProviderInfo(
                id=pid,
                label=label,
                implemented=pid in implemented,
                configured=provider_configured(settings, pid),
            )
            for pid, label in PROVIDER_LABELS.items()
        ],
    )


@router.get("/voice/config", response_model=VoiceConfig)
def voice_config(request: Request) -> VoiceConfig:
    """Which conversational voice provider is active, and which the kiosk could
    switch to. Always safe to call; ``enabled`` is false until
    ``MISSION_CONTROL_VOICE_ENABLED``."""
    _require_local(request)
    return _voice_config()


@router.put("/voice/config", response_model=VoiceConfig)
def set_voice_config(request: Request, body: VoiceConfigUpdate) -> VoiceConfig:
    """Point every subsequent turn at ``body.provider`` (bake-off A/B control).

    Process-memory only — a restart reverts to ``MISSION_CONTROL_VOICE_PROVIDER``.
    The token cache is cleared so a grant for the previous provider is not
    re-served.
    """
    _require_local(request)
    try:
        set_provider_override(body.provider)
    except VoiceUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    reset_voice_token_cache()
    return _voice_config()


@router.websocket("/voice/live")
async def voice_live_relay(websocket: WebSocket) -> None:
    """Relay for the Azure voice contestants: the kiosk connects here with the
    single-use ticket from its grant, and the backend bridges to the provider,
    translating both directions to the shared ``VoiceEvent`` protocol
    (``app/voice/relay.py``). Loopback / LAN only, like every other voice route.
    """
    host = websocket.client.host if websocket.client else ""
    if not _is_local_client(host):
        await websocket.close(code=4403)
        return
    config = redeem_ticket(websocket.query_params.get("ticket"))
    if config is None:
        await websocket.close(code=4401)
        return
    await websocket.accept()
    try:
        await run_relay(websocket, config)
    except WebSocketDisconnect:
        return


@router.get("/voice/wake-config", response_model=WakeWordConfig)
def voice_wake_config(request: Request) -> WakeWordConfig:
    """Local wake-word settings for the kiosk.

    Detection is entirely browser-side (see ``docs/wake-word-plan.md``); this
    endpoint only hands over thresholds and asset locations. It is always safe
    to call — ``enabled`` is false until both voice and wake word are switched
    on and a model is provisioned.
    """
    _require_local(request)
    settings = get_settings()
    return WakeWordConfig(
        enabled=settings.wake_word_enabled and settings.voice_enabled,
        phrase=settings.wake_word_phrase,
        threshold=settings.wake_word_threshold,
        cooldown_ms=settings.wake_word_cooldown_ms,
        model_path=settings.wake_word_model_path,
        models_base_url=settings.wake_word_models_base_url,
    )


# -- timers ------------------------------------------------------------------
# Backend-owned, in-memory, one active timer for now (see docs/timer-plan.md).
# Gated to loopback / LAN like the other control surfaces. Every mutation returns
# the resulting Timer *and* broadcasts, so the initiating kiosk and any other
# screen converge through the same path.


@router.get("/timers", response_model=list[Timer])
async def list_timers(request: Request) -> list[Timer]:
    _require_local(request)
    return get_timer_store().list_timers()


@router.post("/timers", response_model=TimerMutationResult)
async def create_timer(request: Request, body: TimerCreateRequest) -> TimerMutationResult:
    _require_local(request)
    try:
        return await get_timer_store().create(body)
    except TimerError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.patch("/timers/{timer_id}", response_model=Timer)
async def extend_timer(request: Request, timer_id: str, body: TimerExtendRequest) -> Timer:
    _require_local(request)
    try:
        return await get_timer_store().extend(timer_id, body)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc
    except TimerError as exc:
        raise HTTPException(status_code=422, detail=str(exc)) from exc


@router.delete("/timers/{timer_id}", status_code=204)
async def delete_timer(request: Request, timer_id: str) -> None:
    """Cancel a running timer or dismiss a fired one — same call for both."""
    _require_local(request)
    try:
        await get_timer_store().cancel(timer_id)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="no such timer") from exc


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    connections.add(websocket)
    try:
        await websocket.send_json(
            {"type": "connected", "message": "Dashboard live connection ready"}
        )
        # Send the current timer list so a just-loaded / just-reconnected kiosk is
        # immediately correct (a restart cleared them → the kiosk clears too).
        await websocket.send_json(
            ApplicationMessage(
                type="timers",
                message="current timers",
                timers=get_timer_store().list_timers(),
            ).model_dump(mode="json", exclude_none=True)
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
    finally:
        connections.discard(websocket)
