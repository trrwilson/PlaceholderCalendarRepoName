"""``python -m app.eufy`` — one-time headless sign-in / status / logout.

Models ``app/auth.py``'s CLI shape. ``login`` starts a throwaway bridge
instance, and if a captcha/2FA challenge appears, prompts for the answer on
stdin; the bridge persists the resulting session
(``MISSION_CONTROL_EUFY_SESSION_FILE``) so the real backend's normal startup
never needs to log in again (docs/eufy-sdk-integration.md §5.5, §6.5). A
already-valid persisted session makes ``login`` a no-op that just confirms
connectivity.
"""

from __future__ import annotations

import argparse
import asyncio
import sys
from pathlib import Path

from app.config import get_settings
from app.eufy.bridge_process import EufyBridgeProcess
from app.eufy.client import EufyBridgeClient


def _bridge_url() -> str:
    settings = get_settings()
    return f"ws://{settings.eufy_bridge_host}:{settings.eufy_bridge_port}"


async def _connect_with_retries(client: EufyBridgeClient, attempts: int = 20) -> None:
    for _ in range(attempts):
        try:
            await client.connect()
            return
        except (OSError, TimeoutError):
            await asyncio.sleep(0.5)
    raise RuntimeError("could not reach the eufy bridge after starting it")


def _check_credentials() -> bool:
    settings = get_settings()
    if not settings.eufy_email or not settings.eufy_password:
        print(
            "MISSION_CONTROL_EUFY_EMAIL and MISSION_CONTROL_EUFY_PASSWORD must be set.",
            file=sys.stderr,
        )
        return False
    return True


async def _run_login() -> int:
    if not _check_credentials():
        return 1
    bridge = EufyBridgeProcess(get_settings())
    await bridge.start()
    client = EufyBridgeClient(_bridge_url())
    try:
        await _connect_with_retries(client)
        async for message in client.messages():
            kind = message.get("type")
            if kind == "auth":
                need = message.get("need")
                if need == "captcha":
                    print("A captcha challenge is required.")
                    print(f"Image data: {message.get('image')}")
                    code = input("Enter the captcha text: ").strip()
                    await client.send(
                        {
                            "type": "answer_captcha",
                            "code": code,
                            "captcha_id": message.get("captcha_id"),
                        }
                    )
                elif need == "tfa":
                    code = input("Enter the 2FA code sent to your account: ").strip()
                    await client.send({"type": "answer_tfa", "code": code})
            elif kind == "status":
                state = message.get("state")
                print(f"status: {state}")
                if state == "connected":
                    print("Signed in — the backend will not need to log in again.")
                    return 0
                if state == "error":
                    print(f"error: {message.get('detail')}", file=sys.stderr)
                    return 1
    finally:
        await client.close()
        await bridge.stop()
    return 1


async def _run_status() -> int:
    if not _check_credentials():
        return 1
    bridge = EufyBridgeProcess(get_settings())
    await bridge.start()
    client = EufyBridgeClient(_bridge_url())
    try:
        await _connect_with_retries(client)
        async for message in client.messages():
            kind = message.get("type")
            if kind == "ready":
                devices = message.get("devices", [])
                print(f"connected — {len(devices)} camera(s):")
                for device in devices:
                    print(f"  {device.get('camera_name')} ({device.get('camera_id')})")
                return 0
            if kind == "status" and message.get("state") == "error":
                print(f"error: {message.get('detail')}", file=sys.stderr)
                return 1
    finally:
        await client.close()
        await bridge.stop()
    return 1


def _run_logout() -> int:
    path = Path(get_settings().eufy_session_file)
    if path.exists():
        path.unlink()
        print(f"removed {path} — the next login will need the account password again.")
    else:
        print("no session file to remove.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(prog="python -m app.eufy")
    parser.add_argument("command", choices=["login", "status", "logout"])
    args = parser.parse_args()
    if args.command == "login":
        return asyncio.run(_run_login())
    if args.command == "status":
        return asyncio.run(_run_status())
    return _run_logout()


if __name__ == "__main__":
    raise SystemExit(main())
