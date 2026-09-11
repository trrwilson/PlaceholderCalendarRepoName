"""Thin async client for the eufy-bridge control channel.

One instance = one connection to the Node sidecar (`eufy-bridge/`), a
localhost-only WebSocket carrying one JSON object per message in both
directions. No reconnect logic here — that is `EufyEventService.run()`'s job
(exponential backoff, matching every other reconnect loop in this backend, e.g.
`app/voice/relay.py`). This module only knows how to open one connection, send
one JSON message, and yield parsed JSON messages until it drops.
"""

from __future__ import annotations

import json
import logging
from collections.abc import AsyncIterator
from typing import Any

logger = logging.getLogger(__name__)


class EufyBridgeClient:
    """A single connection to the bridge at ``ws://host:port``."""

    def __init__(self, url: str) -> None:
        self._url = url
        self._connection: Any | None = None

    async def connect(self) -> None:
        import websockets

        self._connection = await websockets.connect(self._url, max_size=None, open_timeout=10)

    async def close(self) -> None:
        if self._connection is not None:
            try:
                await self._connection.close()
            except Exception:  # noqa: BLE001 - closing a dead socket must not raise
                pass
            self._connection = None

    async def send(self, message: dict[str, Any]) -> None:
        if self._connection is None:
            raise RuntimeError("EufyBridgeClient.send() called before connect()")
        await self._connection.send(json.dumps(message))

    async def messages(self) -> AsyncIterator[dict[str, Any]]:
        """Yield parsed JSON messages until the connection drops or closes."""
        if self._connection is None:
            raise RuntimeError("EufyBridgeClient.messages() called before connect()")
        async for raw in self._connection:
            try:
                parsed = json.loads(raw)
            except (json.JSONDecodeError, TypeError):
                logger.warning("eufy-bridge sent a non-JSON message; dropping it")
                continue
            if isinstance(parsed, dict):
                yield parsed
