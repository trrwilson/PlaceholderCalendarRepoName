"""Debug Restart — the disconnected-flyout's last-resort recovery action.

Spawns ``scripts/restart-dev.ps1``, the same stop-then-start dance a developer
already runs by hand: it bounces this backend process, the frontend Vite dev
server, and (best-effort — see the script's own comments) cycles the Invoke's
mic feeder around the bounce. Detached so it outlives the very backend process
it is about to kill; ``api.py`` only reaches this when
``Settings.host_local_display`` asserts the backend is colocated with the
kiosk it would be restarting.
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path


class RestartUnavailable(Exception):
    """Raised when the restart script can't be found on this checkout."""


def trigger_restart() -> None:
    repo_root = Path(__file__).resolve().parents[2]
    script = repo_root / "scripts" / "restart-dev.ps1"
    if not script.exists():
        raise RestartUnavailable(f"restart script not found at {script}")
    creationflags = 0
    if sys.platform == "win32":
        creationflags = subprocess.DETACHED_PROCESS | subprocess.CREATE_NEW_PROCESS_GROUP
    subprocess.Popen(
        ["pwsh.exe", "-NoLogo", "-NoProfile", "-File", str(script)],
        cwd=str(repo_root),
        creationflags=creationflags,
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
    )
