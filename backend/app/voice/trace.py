"""Minimal timing instrumentation for the voice token path.

The kiosk's push-to-talk latency is spread across our token endpoint, Google's
auth-token API, and (today) a synchronous calendar-provider snapshot. This logs
how long each step takes so a slow ``connecting`` phase can be attributed. The
repo has no logging setup otherwise, so this configures one stream handler for
the ``app.voice`` logger on first use.
"""

from __future__ import annotations

import logging
import time
from contextlib import contextmanager

_logger = logging.getLogger("app.voice")


def _ensure_handler() -> None:
    if _logger.handlers:
        return
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter("%(asctime)s [voice] %(message)s", datefmt="%H:%M:%S"))
    _logger.addHandler(handler)
    _logger.setLevel(logging.INFO)
    _logger.propagate = False


@contextmanager
def timed(label: str):
    """Log ``label`` with the wall-clock milliseconds it took."""
    _ensure_handler()
    start = time.perf_counter()
    try:
        yield
    finally:
        _logger.info("%s took %d ms", label, (time.perf_counter() - start) * 1000)


def note(message: str) -> None:
    _ensure_handler()
    _logger.info(message)
