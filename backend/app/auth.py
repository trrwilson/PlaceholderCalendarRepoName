"""Headless sign-in for the personal Outlook calendar provider.

The kiosk can do this from its UI (device-code + QR); this CLI is the equivalent
for a server with no display. Run from the ``backend/`` directory:

    python -m app.auth login     # device-code sign-in
    python -m app.auth status    # show the signed-in account
    python -m app.auth logout    # forget the account and delete the token cache

Requires ``MISSION_CONTROL_GRAPH_CLIENT_ID`` (a personal-accounts app registration
with "Allow public client flows" enabled). The token cache path is
``MISSION_CONTROL_GRAPH_TOKEN_CACHE`` (default ``.msal_token_cache.json``).
"""

from __future__ import annotations

import sys

from app.calendar import personal_auth
from app.calendar.outlook_personal import cache_path, shared_msal_app
from app.config import get_settings


def login() -> int:
    settings = get_settings()
    result = personal_auth.run_device_flow_blocking(
        settings, lambda message: print(message, flush=True)
    )
    if result.state == "connected":
        print(f"Signed in as {result.account}. Token cache: {cache_path(settings)}")
        return 0
    print(f"Sign-in failed: {result.error}")
    return 1


def status() -> int:
    settings = get_settings()
    app, _cache, path = shared_msal_app(settings)
    accounts = app.get_accounts()
    if not accounts:
        suffix = "" if path.exists() else " (missing)"
        print(f"Not signed in. Token cache: {path}{suffix}")
        return 1
    print(f"Signed in as {accounts[0]['username']}. Token cache: {path}")
    return 0


def logout() -> int:
    settings = get_settings()
    personal_auth.sign_out(settings)
    print("Signed out; token cache removed.")
    return 0


_COMMANDS = {"login": login, "status": status, "logout": logout}


def main(argv: list[str] | None = None) -> int:
    args = sys.argv[1:] if argv is None else argv
    command = args[0] if args else "status"
    handler = _COMMANDS.get(command)
    if handler is None:
        print(f"Unknown command {command!r}. Use one of: {', '.join(_COMMANDS)}")
        return 2
    try:
        return handler()
    except RuntimeError as error:
        print(error)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
