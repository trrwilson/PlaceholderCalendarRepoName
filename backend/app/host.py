"""Backend/frontend colocation — the structural gate for host-local capabilities.

Some things Mission Control can do only exist when this FastAPI process runs on
the *same physical machine* as the kiosk browser and therefore owns the attached
hardware: setting the wall panel's brightness (``app/display.py``), and later
driving display power / a local webcam (``docs/camera-support-plan.md``).

Rather than scatter "documented prerequisite" prose and ad-hoc env reads, the
topology is one explicit assertion — ``MISSION_CONTROL_HOST_LOCAL_DISPLAY`` — and
this module is the single place that reports it. Every OS / device-API call in
the codebase is expected to check :func:`host_capabilities` (or a value derived
from it) first and be inert when the flag is false. See
``docs/display-dimming-plan.md`` -> "Colocation is explicit".
"""

from __future__ import annotations

from app.config import Settings
from app.models import HostCapabilities


def host_capabilities(settings: Settings) -> HostCapabilities:
    """The capabilities this deployment's topology unlocks. Pure; no I/O."""
    return HostCapabilities(
        host_local_display=settings.host_local_display,
        host_local_camera=settings.host_local_camera,
    )
