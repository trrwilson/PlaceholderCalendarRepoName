"""One-time sign-in for the personal Outlook calendar provider.

Run from the ``backend/`` directory:

    python -m app.auth login     # device-code sign-in (opens a code to enter in a browser)
    python -m app.auth status    # show the signed-in account
    python -m app.auth logout    # forget the account and delete the token cache

Requires ``MISSION_CONTROL_GRAPH_CLIENT_ID`` (a personal-accounts app registration
with "Allow public client flows" enabled). The token cache path is
``MISSION_CONTROL_GRAPH_TOKEN_CACHE`` (default ``.msal_token_cache.json``).
"""

from __future__ import annotations

import sys

from app.calendar.outlook_personal import GRAPH_SCOPES, load_msal_app, save_cache
from app.config import get_settings


def login() -> int:
    settings = get_settings()
    app, cache, path = load_msal_app(settings)

    if app.get_accounts():
        print(f"Already signed in as {app.get_accounts()[0]['username']}.")
        print("Run `python -m app.auth logout` first to switch accounts.")
        return 0

    flow = app.initiate_device_flow(scopes=GRAPH_SCOPES)
    if "user_code" not in flow:
        print(f"Could not start device-code sign-in: {flow.get('error_description', flow)}")
        return 1

    print(flow["message"], flush=True)  # "open https://microsoft.com/devicelogin and enter CODE"
    result = app.acquire_token_by_device_flow(flow)  # blocks until the browser step completes

    if "access_token" not in result:
        print(f"Sign-in failed: {result.get('error_description', result)}")
        return 1

    save_cache(cache, path)
    print(f"Signed in as {app.get_accounts()[0]['username']}. Token cache: {path}")
    return 0


def status() -> int:
    settings = get_settings()
    app, _cache, path = load_msal_app(settings)
    accounts = app.get_accounts()
    if not accounts:
        suffix = "" if path.exists() else " (missing)"
        print(f"Not signed in. Token cache: {path}{suffix}")
        return 1
    print(f"Signed in as {accounts[0]['username']}. Token cache: {path}")
    return 0


def logout() -> int:
    settings = get_settings()
    app, cache, path = load_msal_app(settings)
    for account in app.get_accounts():
        app.remove_account(account)
    save_cache(cache, path)
    path.unlink(missing_ok=True)
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
