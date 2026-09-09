"""Wake-word ("Mission Control") detection back ends for the bake-off.

Deliberately a parallel of :mod:`app.voice.providers` but for *activation*
rather than the conversational turn — the two are chosen independently
(AGENTS.md -> "Wake word"). Two contestants:

* ``openwakeword`` — local ONNX keyword spotting that runs entirely in the kiosk
  browser (``frontend/src/voice/wake/openWakeWord.ts``). The default. No host
  process; idle audio never leaves the browser.
* ``azure`` — an Azure Speech Studio custom-keyword ``.table`` spotted offline by
  the native Speech SDK. The SDK has no browser build for this, so the kiosk
  streams 16 kHz mic audio to ``WS /api/voice/wake/azure`` and the backend runs
  the recogniser (:mod:`app.voice.wake_azure`). Keyword spotting is still
  on-device — no Azure credentials, no network — but the audio does reach the
  backend (localhost / LAN, the same trust boundary as the Azure voice relay).
The on-device **Invoke gate** is not a third contestant — it is an *additive*
first stage in front of whichever of the two is selected (``invoke_gate_enabled``
/ ``WS /api/voice/wake/invoke``, :mod:`app.voice.wake_invoke`).

``effective_wake_provider`` resolves a process-memory override set via
``PUT /api/voice/wake-config`` (the bake-off A/B affordance — a restart reverts
it), else ``settings.wake_word_provider``.
"""

from __future__ import annotations

from pathlib import Path

from app.config import Settings
from app.models import WakeProviderId

__all__ = [
    "WAKE_PROVIDER_LABELS",
    "azure_wake_available",
    "effective_invoke_gate_enabled",
    "effective_wake_provider",
    "implemented_wake_providers",
    "invoke_gate_configured",
    "reset_invoke_gate_enabled_override",
    "reset_wake_provider_override",
    "set_invoke_gate_enabled_override",
    "set_wake_provider_override",
    "wake_provider_configured",
]

# Friendly names for the Settings picker and diagnostics, keyed by every known
# id so the UI can label a contestant regardless of state.
WAKE_PROVIDER_LABELS: dict[WakeProviderId, str] = {
    "openwakeword": "openWakeWord (in-browser)",
    "azure": "Azure custom keyword (backend)",
}

_IMPLEMENTED: tuple[WakeProviderId, ...] = ("openwakeword", "azure")

_override: WakeProviderId | None = None
_gate_enabled_override: bool | None = None


def implemented_wake_providers() -> tuple[WakeProviderId, ...]:
    return _IMPLEMENTED


def effective_wake_provider(settings: Settings) -> WakeProviderId:
    return _override or settings.wake_word_provider


def set_wake_provider_override(provider: WakeProviderId | None) -> None:
    """Point every subsequent activation at ``provider`` (or clear the override).

    Process-memory only — not persisted, not a per-viewer preference.
    """
    global _override
    if provider is not None and provider not in _IMPLEMENTED:
        raise ValueError(
            f"wake provider {provider!r} is not implemented (available: {', '.join(_IMPLEMENTED)})"
        )
    _override = provider


def reset_wake_provider_override() -> None:
    global _override
    _override = None


def invoke_gate_configured(settings: Settings) -> bool:
    """True once an Invoke host is set — the additive gate can then be turned on.
    Reachability of the daemon's control socket is surfaced at connect time as an
    ``error`` frame, exactly like the azure relay.
    """
    return bool(settings.wake_word_invoke_gate_host)


def effective_invoke_gate_enabled(settings: Settings) -> bool:
    """Whether the additive on-device Invoke gate is on (in front of the selected
    provider), honouring the process-memory override from
    ``PUT /api/voice/wake-config`` before ``settings``. **Off by default.**
    """
    if _gate_enabled_override is not None:
        return _gate_enabled_override
    return settings.wake_word_invoke_gate_enabled


def set_invoke_gate_enabled_override(on: bool | None) -> None:
    """Process-memory override for the Invoke-gate switch (or clear it)."""
    global _gate_enabled_override
    _gate_enabled_override = on


def reset_invoke_gate_enabled_override() -> None:
    global _gate_enabled_override
    _gate_enabled_override = None


def azure_wake_available() -> bool:
    """True when the native Speech SDK for the ``azure`` provider is importable.

    The ``azure-cognitiveservices-speech`` package is an optional dependency
    (``pip install -e '.[azure-wake]'``) — the ``openwakeword`` default must not
    drag in a native SDK. Imported here only for the check; the recogniser
    itself imports it lazily in :mod:`app.voice.wake_azure`.
    """
    try:
        import azure.cognitiveservices.speech  # noqa: F401
    except Exception:
        return False
    return True


def wake_provider_configured(settings: Settings, provider: WakeProviderId) -> bool:
    """True when ``provider`` can actually run a detection right now."""
    if provider == "openwakeword":
        # Model-asset availability is a frontend concern; the browser detector
        # degrades to push-to-talk on its own if the ONNX files are missing.
        return True
    if provider == "azure":
        return azure_wake_available() and Path(settings.wake_word_azure_model_path).is_file()
    return False
