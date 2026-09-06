import ipaddress
from datetime import date, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, HTTPException, Request, WebSocket, WebSocketDisconnect
from pydantic import ValidationError

import app.calendar.personal_auth as personal_auth
from app.calendar.provider import CalendarProvider, MockCalendarProvider
from app.config import get_settings
from app.models import (
    CalendarAuthStatus,
    CalendarRange,
    CalendarSnapshot,
    VoiceToken,
    VoiceTokenRequest,
)
from app.voice import VoiceUnavailable, mint_token

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


def _require_local(request: Request) -> None:
    """Gate the calendar sign-in endpoints to loopback / LAN unless opted out."""
    if get_settings().allow_remote_auth:
        return
    host = request.client.host if request.client else ""
    try:
        address = ipaddress.ip_address(host)
    except ValueError:
        address = None
    if address is None or not (address.is_loopback or address.is_private or address.is_link_local):
        raise HTTPException(
            status_code=403,
            detail="calendar sign-in is only available on the local network",
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
    """Mint a constrained ephemeral token for the kiosk's Gemini Live session."""
    from app.voice.trace import note, timed

    _require_local(request)
    note("token request received")
    today = date.today()
    # NOTE: this is a synchronous provider call on the token path; for the
    # Outlook provider it is a blocking Graph request and shows up as dead time
    # in the kiosk's `connecting` phase. It only supplies calendar names for the
    # system prompt — a future change should cache these.
    with timed("calendar snapshot (for prompt calendar names)"):
        calendar_names = [
            calendar.name
            for calendar in calendar_provider.snapshot(
                CalendarRange(starts_on=today, ends_on=today)
            ).calendars
        ]
    try:
        with timed("mint ephemeral token (Google auth_tokens.create)"):
            token = await mint_token(
                get_settings(),
                calendar_names=calendar_names,
                surface=body.surface if body else None,
                timezone=body.timezone if body else None,
                client_time=body.client_time if body else None,
            )
        note("token minted and returned")
        return token
    except VoiceUnavailable as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        await websocket.send_json(
            {"type": "connected", "message": "Dashboard live connection ready"}
        )
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
