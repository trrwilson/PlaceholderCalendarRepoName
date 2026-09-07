"""The kiosk live connection registry and the server→client broadcast helper.

``/api/ws`` is a deliberately small typed endpoint (see ``AGENTS.md``); this is
not a general event bus. Today one kiosk connects, but a ``set`` of sockets costs
nothing and covers a second screen. The timer store pushes ``ApplicationMessage``
envelopes through :func:`ConnectionRegistry.broadcast`; it never imports the
WebSocket layer itself, which keeps it unit-testable without a socket.
"""

from __future__ import annotations

from typing import TYPE_CHECKING

from app.models import ApplicationMessage

if TYPE_CHECKING:
    from fastapi import WebSocket


class ConnectionRegistry:
    def __init__(self) -> None:
        self._sockets: set[WebSocket] = set()

    def add(self, socket: WebSocket) -> None:
        self._sockets.add(socket)

    def discard(self, socket: WebSocket) -> None:
        self._sockets.discard(socket)

    @property
    def count(self) -> int:
        return len(self._sockets)

    async def broadcast(self, message: ApplicationMessage) -> None:
        payload = message.model_dump(mode="json", exclude_none=True)
        for socket in list(self._sockets):
            try:
                await socket.send_json(payload)
            except Exception:  # noqa: BLE001 - a dead socket must not stop the rest
                self._sockets.discard(socket)


# Process-wide singleton, like the MSAL client pattern.
connections = ConnectionRegistry()
