import time

import msal
import pytest
from fastapi.testclient import TestClient

import app.calendar.outlook_personal as outlook_personal
from app.calendar import personal_auth
from app.config import Settings
from app.main import app


def make_settings(tmp_path, **overrides):
    base = {
        "calendar_provider": "outlook_personal",
        "graph_client_id": "test-client",
        "graph_token_cache": str(tmp_path / "cache.json"),
        "allow_remote_auth": True,
    }
    base.update(overrides)
    return Settings(_env_file=None, **base)


@pytest.fixture(autouse=True)
def _clean():
    personal_auth._reset_for_tests()
    yield
    personal_auth._reset_for_tests()


@pytest.fixture
def client(monkeypatch, tmp_path):
    settings = make_settings(tmp_path)
    monkeypatch.setattr("app.api.get_settings", lambda: settings)
    return TestClient(app)


# --- endpoint guards ---------------------------------------------------------


def test_auth_endpoints_are_local_only(monkeypatch, tmp_path):
    settings = make_settings(tmp_path, allow_remote_auth=False)
    monkeypatch.setattr("app.api.get_settings", lambda: settings)
    resp = TestClient(app).get("/api/calendar/auth")
    assert resp.status_code == 403


def test_status_not_applicable_for_mock(monkeypatch, tmp_path):
    settings = make_settings(tmp_path, calendar_provider="mock")
    monkeypatch.setattr("app.api.get_settings", lambda: settings)
    body = TestClient(app).get("/api/calendar/auth").json()
    assert body["state"] == "not_applicable"


def test_device_endpoint_requires_personal_provider(monkeypatch, tmp_path):
    settings = make_settings(tmp_path, calendar_provider="graph")
    monkeypatch.setattr("app.api.get_settings", lambda: settings)
    assert TestClient(app).post("/api/calendar/auth/device").status_code == 409


# --- status ----------------------------------------------------------------


def test_status_disconnected_without_account(client):
    body = client.get("/api/calendar/auth").json()
    assert body["state"] == "disconnected"
    assert body["account"] is None


def test_status_connected_when_account_cached(client, monkeypatch):
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "get_accounts",
        lambda self, **kw: [{"username": "mia@outlook.com", "home_account_id": "h"}],
    )
    body = client.get("/api/calendar/auth").json()
    assert body["state"] == "connected"
    assert body["account"] == "mia@outlook.com"
    assert body["accounts"] == ["mia@outlook.com"]


def test_status_lists_each_cached_household_account(client, monkeypatch):
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "get_accounts",
        lambda self, **kw: [
            {"username": "mia@outlook.com", "home_account_id": "mia"},
            {"username": "sam@outlook.com", "home_account_id": "sam"},
        ],
    )
    body = client.get("/api/calendar/auth").json()
    assert body["state"] == "connected"
    assert body["accounts"] == ["mia@outlook.com", "sam@outlook.com"]


def test_status_reports_provider_auth_failure(client, monkeypatch):
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "get_accounts",
        lambda self, **kw: [{"username": "mia@outlook.com", "home_account_id": "h"}],
    )
    outlook_personal.auth_error = "sign-in expired or was revoked"
    body = client.get("/api/calendar/auth").json()
    assert body["state"] == "disconnected"
    assert "expired" in body["error"]


# --- device flow ----------------------------------------------------------


def test_begin_sign_in_returns_code_and_qr(client, monkeypatch):
    fake_flow = {
        "user_code": "ABCD-EFGH",
        "verification_uri": "https://microsoft.com/devicelogin",
        "verification_uri_complete": "https://microsoft.com/devicelogin?otc=ABCDEFGH",
        "expires_in": 900,
        "message": "Go to the link and enter the code",
        "device_code": "dev",
        "interval": 5,
    }
    monkeypatch.setattr(
        msal.PublicClientApplication, "initiate_device_flow", lambda self, **kw: fake_flow
    )
    monkeypatch.setattr(personal_auth, "_complete", lambda *a, **k: None)

    body = client.post("/api/calendar/auth/device").json()
    assert body["state"] == "connecting"
    assert body["user_code"] == "ABCD-EFGH"
    assert body["verification_uri"] == "https://microsoft.com/devicelogin"
    assert body["verification_qr"].startswith("data:image/svg+xml")
    assert 0 < body["expires_in"] <= 900

    # polling again keeps the same pending flow, not a second one
    again = client.get("/api/calendar/auth").json()
    assert again["user_code"] == "ABCD-EFGH"


def test_begin_sign_in_surfaces_initiate_failure(client, monkeypatch):
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "initiate_device_flow",
        lambda self, **kw: {"error": "unauthorized_client", "error_description": "app not found"},
    )
    body = client.post("/api/calendar/auth/device").json()
    assert body["state"] == "disconnected"
    assert body["error"] == "app not found"


def test_begin_sign_in_surfaces_failure_even_when_a_household_is_connected(client, monkeypatch):
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "get_accounts",
        lambda self, **kw: [{"username": "mia@outlook.com", "home_account_id": "h"}],
    )
    monkeypatch.setattr(
        msal.PublicClientApplication,
        "initiate_device_flow",
        lambda self, **kw: {"error_description": "temporarily throttled"},
    )
    body = client.post("/api/calendar/auth/device").json()
    # Still connected (the existing calendar is fine) but the add attempt failed
    # loudly instead of looking like a no-op.
    assert body["state"] == "connected"
    assert body["error"] == "temporarily throttled"


def test_complete_persists_token_and_clears_error(tmp_path):
    personal_auth._pending = {
        "user_code": "X",
        "verification_uri": "u",
        "expires_at": time.time() + 900,
    }
    outlook_personal.auth_error = "not signed in"
    cache = msal.SerializableTokenCache()

    class FakeApp:
        def acquire_token_by_device_flow(self, flow):
            return {"access_token": "tok"}

    personal_auth._complete(cache, tmp_path / "c.json", FakeApp(), {})

    assert personal_auth._pending is None
    assert outlook_personal.auth_error is None


def test_cancel_and_sign_out(client, monkeypatch):
    fake_flow = {
        "user_code": "C-ODE",
        "verification_uri": "https://microsoft.com/devicelogin",
        "expires_in": 900,
        "message": "go",
    }
    monkeypatch.setattr(
        msal.PublicClientApplication, "initiate_device_flow", lambda self, **kw: fake_flow
    )
    monkeypatch.setattr(personal_auth, "_complete", lambda *a, **k: None)

    assert client.post("/api/calendar/auth/device").json()["state"] == "connecting"
    assert client.request("DELETE", "/api/calendar/auth/device").json()["state"] == "disconnected"
    assert client.request("DELETE", "/api/calendar/auth").json()["state"] == "disconnected"
