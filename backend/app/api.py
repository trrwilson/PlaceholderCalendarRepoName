from datetime import date, timedelta

from fastapi import APIRouter, Depends, WebSocket, WebSocketDisconnect

from app.calendar.provider import MockCalendarProvider
from app.models import CalendarRange, CalendarSnapshot

router = APIRouter(prefix="/api")
provider = MockCalendarProvider()


def get_provider() -> MockCalendarProvider:
    return provider


@router.get("/health")
async def health() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/calendar", response_model=CalendarSnapshot)
async def get_calendar(
    starts_on: date | None = None,
    ends_on: date | None = None,
    calendar_provider: MockCalendarProvider = Depends(get_provider),
) -> CalendarSnapshot:
    start = starts_on or date.today().replace(day=1)
    end = ends_on or (start + timedelta(days=41))
    return calendar_provider.snapshot(CalendarRange(starts_on=start, ends_on=end))


@router.websocket("/ws")
async def websocket_endpoint(websocket: WebSocket) -> None:
    await websocket.accept()
    try:
        await websocket.send_json({"type": "connected", "message": "Dashboard live connection ready"})
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        return
