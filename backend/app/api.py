from datetime import date, timedelta
from functools import lru_cache

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.calendar.provider import CalendarProvider, MockCalendarProvider
from app.config import get_settings
from app.models import CalendarRange, CalendarSnapshot

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
    return calendar_provider.snapshot(CalendarRange(starts_on=start, ends_on=end))


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
