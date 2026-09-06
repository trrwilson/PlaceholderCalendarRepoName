"""Device-code sign-in for the personal Outlook provider, usable from HTTP or CLI.

The kiosk cannot show a keyboard-driven login form, so sign-in uses the OAuth
device-code flow: the backend gets a short code, the kiosk shows it (plus a QR to
the verification URL), and a household member completes sign-in on their phone.
``begin_sign_in`` starts a background thread that blocks on MSAL until the person
finishes; ``get_status`` is what the kiosk polls.
"""

from __future__ import annotations

import threading
import time

import segno

import app.calendar.outlook_personal as outlook_personal
from app.calendar.outlook_personal import GRAPH_SCOPES, save_cache, shared_msal_app
from app.config import Settings
from app.models import CalendarAuthStatus

_lock = threading.Lock()
_pending: dict | None = None
_thread: threading.Thread | None = None
_flow_error: str | None = None


def _qr_data_uri(text: str) -> str:
    return segno.make(text, error="m").svg_data_uri(scale=8, border=2)


def _status(settings: Settings) -> CalendarAuthStatus:
    provider = settings.calendar_provider
    try:
        app, _cache, _path = shared_msal_app(settings)
    except RuntimeError as error:
        return CalendarAuthStatus(provider=provider, state="disconnected", error=str(error))

    accounts = app.get_accounts()
    account = accounts[0]["username"] if accounts else None

    with _lock:
        pending = dict(_pending) if _pending else None
        flow_error = _flow_error

    if pending and pending["expires_at"] > time.time():
        target = pending.get("verification_uri_complete") or pending["verification_uri"]
        return CalendarAuthStatus(
            provider=provider,
            state="connecting",
            account=account,
            user_code=pending["user_code"],
            verification_uri=pending["verification_uri"],
            verification_uri_complete=pending.get("verification_uri_complete"),
            verification_qr=_qr_data_uri(target),
            expires_in=int(pending["expires_at"] - time.time()),
        )

    if accounts and outlook_personal.auth_error is None:
        return CalendarAuthStatus(provider=provider, state="connected", account=account)
    if accounts:
        return CalendarAuthStatus(
            provider=provider,
            state="disconnected",
            account=account,
            error=outlook_personal.auth_error,
        )
    return CalendarAuthStatus(provider=provider, state="disconnected", error=flow_error)


def get_status(settings: Settings) -> CalendarAuthStatus:
    return _status(settings)


def begin_sign_in(settings: Settings) -> CalendarAuthStatus:
    global _thread, _pending, _flow_error
    with _lock:
        already_pending = _pending is not None and _pending["expires_at"] > time.time()
    if not already_pending:
        app, cache, path = shared_msal_app(settings)
        if not app.get_accounts():
            flow = app.initiate_device_flow(scopes=GRAPH_SCOPES)
            usable = all(k in flow for k in ("user_code", "verification_uri", "expires_in"))
            with _lock:
                if not usable:
                    _flow_error = flow.get("error_description") or "could not start sign-in"
                    _pending = None
                else:
                    _flow_error = None
                    _pending = {
                        "user_code": flow["user_code"],
                        "verification_uri": flow["verification_uri"],
                        "verification_uri_complete": flow.get("verification_uri_complete"),
                        "expires_at": time.time() + int(flow["expires_in"]),
                    }
                    _thread = threading.Thread(
                        target=_complete,
                        args=(cache, path, app, flow),
                        daemon=True,
                    )
                    _thread.start()
    return _status(settings)


def _complete(cache, path, app, flow: dict) -> None:
    global _pending, _flow_error
    try:
        result = app.acquire_token_by_device_flow(flow)
        if "access_token" in result:
            save_cache(cache, path)
            outlook_personal.auth_error = None
            _flow_error = None
        else:
            _flow_error = result.get("error_description") or "sign-in did not complete"
    except Exception as exc:  # noqa: BLE001 - report any failure back through status
        _flow_error = str(exc)
    finally:
        with _lock:
            _pending = None


def cancel_sign_in(settings: Settings) -> CalendarAuthStatus:
    global _pending
    with _lock:
        _pending = None
    return _status(settings)


def sign_out(settings: Settings) -> CalendarAuthStatus:
    global _pending, _flow_error
    app, _cache, path = shared_msal_app(settings)
    for account in app.get_accounts():
        app.remove_account(account)
    path.unlink(missing_ok=True)
    outlook_personal.auth_error = "signed out"
    with _lock:
        _pending = None
        _flow_error = None
    return _status(settings)


def run_device_flow_blocking(settings: Settings, on_prompt) -> CalendarAuthStatus:
    """Blocking device-code sign-in for the CLI (`python -m app.auth login`)."""
    app, cache, path = shared_msal_app(settings)
    if app.get_accounts():
        return CalendarAuthStatus(
            provider=settings.calendar_provider,
            state="connected",
            account=app.get_accounts()[0]["username"],
        )

    flow = app.initiate_device_flow(scopes=GRAPH_SCOPES)
    if not all(k in flow for k in ("user_code", "verification_uri", "message")):
        return CalendarAuthStatus(
            provider=settings.calendar_provider,
            state="disconnected",
            error=flow.get("error_description") or str(flow),
        )

    on_prompt(flow["message"])
    result = app.acquire_token_by_device_flow(flow)
    if "access_token" not in result:
        return CalendarAuthStatus(
            provider=settings.calendar_provider,
            state="disconnected",
            error=result.get("error_description") or "sign-in did not complete",
        )

    save_cache(cache, path)
    outlook_personal.auth_error = None
    return CalendarAuthStatus(
        provider=settings.calendar_provider,
        state="connected",
        account=app.get_accounts()[0]["username"],
    )


def _reset_for_tests() -> None:
    global _pending, _thread, _flow_error
    with _lock:
        _pending = None
        _thread = None
        _flow_error = None
    outlook_personal.auth_error = None
    outlook_personal._shared.clear()
    outlook_personal._written.clear()
