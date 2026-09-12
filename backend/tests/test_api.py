from datetime import date

import pytest
from fastapi.testclient import TestClient

from app.api import _build_provider
from app.main import app


@pytest.fixture(autouse=True)
def _fresh_provider():
    _build_provider.cache_clear()
    yield
    _build_provider.cache_clear()


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


def test_health(client: TestClient) -> None:
    assert client.get("/api/health").json() == {"status": "ok"}


def test_calendar_defaults_to_current_month(client: TestClient) -> None:
    body = client.get("/api/calendar").json()
    today = date.today()
    assert body["range"]["starts_on"] == today.replace(day=1).isoformat()
    assert {c["id"] for c in body["calendars"]} == {
        "family",
        "alex",
        "jordan",
        "home",
        "family::holidays",
    }


def test_calendar_honours_explicit_range(client: TestClient) -> None:
    body = client.get(
        "/api/calendar", params={"starts_on": "2026-09-05", "ends_on": "2026-09-05"}
    ).json()
    assert body["range"] == {"starts_on": "2026-09-05", "ends_on": "2026-09-05"}


def test_calendar_rejects_reversed_range(client: TestClient) -> None:
    r = client.get("/api/calendar", params={"starts_on": "2026-09-10", "ends_on": "2026-09-01"})
    assert r.status_code == 422


def test_calendar_visibility_toggles_a_non_primary_calendar_on(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import Settings

    monkeypatch.setattr(
        "app.api.get_settings", lambda: Settings(_env_file=None, allow_remote_auth=True)
    )
    before = client.get("/api/calendar").json()
    assert next(c for c in before["calendars"] if c["id"] == "family::holidays")["enabled"] is False

    r = client.put("/api/calendar/calendars", json={"calendar_id": "family::holidays", "enabled": True})
    assert r.status_code == 204

    after = client.get("/api/calendar").json()
    assert next(c for c in after["calendars"] if c["id"] == "family::holidays")["enabled"] is True


def test_calendar_visibility_rejects_a_primary_calendar_id(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import Settings

    monkeypatch.setattr(
        "app.api.get_settings", lambda: Settings(_env_file=None, allow_remote_auth=True)
    )
    r = client.put("/api/calendar/calendars", json={"calendar_id": "family", "enabled": False})
    assert r.status_code == 400
