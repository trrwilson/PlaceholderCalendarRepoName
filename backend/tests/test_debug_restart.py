import pytest
from fastapi.testclient import TestClient

from app.config import Settings
from app.debug_restart import RestartUnavailable
from app.main import app
from app.privacy import get_privacy_store


@pytest.fixture
def client() -> TestClient:
    return TestClient(app)


@pytest.fixture(autouse=True)
async def _reset_privacy():
    yield
    await get_privacy_store().clear_for_tests()


def _allow_local(monkeypatch: pytest.MonkeyPatch, *, host_local_display: bool = True) -> None:
    monkeypatch.setattr(
        "app.api.get_settings",
        lambda: Settings(
            _env_file=None, allow_remote_auth=True, host_local_display=host_local_display
        ),
    )


def test_debug_restart_spawns_the_script(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _allow_local(monkeypatch)
    calls: list[bool] = []
    monkeypatch.setattr("app.api.trigger_restart", lambda: calls.append(True))

    r = client.post("/api/debug/restart")

    assert r.status_code == 202
    assert r.json() == {"status": "restarting"}
    assert calls == [True]


def test_debug_restart_requires_host_local_display(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _allow_local(monkeypatch, host_local_display=False)
    monkeypatch.setattr(
        "app.api.trigger_restart",
        lambda: pytest.fail("must not spawn when the backend isn't colocated"),
    )

    r = client.post("/api/debug/restart")

    assert r.status_code == 409


def test_debug_restart_reports_a_missing_script(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _allow_local(monkeypatch)

    def _raise() -> None:
        raise RestartUnavailable("nope")

    monkeypatch.setattr("app.api.trigger_restart", _raise)

    r = client.post("/api/debug/restart")

    assert r.status_code == 500


async def test_debug_restart_blocked_while_privacy_locked(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    _allow_local(monkeypatch)
    monkeypatch.setattr(
        "app.api.trigger_restart",
        lambda: pytest.fail("must not spawn while privacy-locked"),
    )
    await get_privacy_store().lock()

    r = client.post("/api/debug/restart")

    assert r.status_code == 423
