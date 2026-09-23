from datetime import datetime, timedelta

import pytest
from fastapi.testclient import TestClient
from pydantic import ValidationError
from starlette.websockets import WebSocketDisconnect

from app.main import app
from app.models import Note, NoteCreateRequest, NoteUpdateRequest
from app.notes import NoteError, NoteStore

BASE = datetime(2026, 9, 7, 9, 0, 0)


@pytest.fixture
def client(monkeypatch: pytest.MonkeyPatch) -> TestClient:
    monkeypatch.setenv("MISSION_CONTROL_ALLOW_REMOTE_AUTH", "true")
    monkeypatch.setenv("MISSION_CONTROL_PRIVACY_MODE_PIN", "8426")
    from app.config import get_settings

    get_settings.cache_clear()
    return TestClient(app)


class FakeClock:
    def __init__(self, now: datetime) -> None:
        self.now = now

    def __call__(self) -> datetime:
        return self.now

    def advance(self, seconds: float) -> None:
        self.now += timedelta(seconds=seconds)


# -- model --------------------------------------------------------------------


def test_note_rejects_blank_text() -> None:
    with pytest.raises(ValidationError):
        Note(id="x", text="", x=0.5, y=0.5, created_at=BASE, updated_at=BASE)


def test_note_rejects_out_of_range_position() -> None:
    with pytest.raises(ValidationError):
        Note(id="x", text="milk run", x=1.5, y=0.5, created_at=BASE, updated_at=BASE)


# -- store ----------------------------------------------------------------


def test_seeds_empty() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    assert store.list_all() == []


def test_create_assigns_increasing_z() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    first = store.create(NoteCreateRequest(text="pick up dry cleaning"))
    second = store.create(NoteCreateRequest(text="water the plants"))
    assert second.z > first.z
    assert [n.id for n in store.list_all()] == [first.id, second.id]


def test_create_enforces_a_cap() -> None:
    store = NoteStore(clock=FakeClock(BASE), notes_max=1)
    store.create(NoteCreateRequest(text="one"))
    with pytest.raises(NoteError):
        store.create(NoteCreateRequest(text="two"))


def test_update_text_moves_note_to_top_of_stack() -> None:
    clock = FakeClock(BASE)
    store = NoteStore(clock=clock)
    first = store.create(NoteCreateRequest(text="one"))
    second = store.create(NoteCreateRequest(text="two"))
    clock.advance(5)
    updated = store.update(first.id, NoteUpdateRequest(text="one, edited"))
    assert updated.text == "one, edited"
    assert updated.z > second.z
    assert updated.updated_at == clock.now


def test_update_position_only_leaves_text() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    note = store.create(NoteCreateRequest(text="milk"))
    moved = store.update(note.id, NoteUpdateRequest(x=0.1, y=0.9))
    assert moved.text == "milk"
    assert (moved.x, moved.y) == (0.1, 0.9)


def test_update_unknown_note_raises() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    with pytest.raises(KeyError):
        store.update("missing", NoteUpdateRequest(text="x"))


def test_delete_removes_and_returns_it() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    note = store.create(NoteCreateRequest(text="milk"))
    removed = store.delete(note.id)
    assert removed.id == note.id
    assert store.list_all() == []


def test_delete_unknown_note_raises() -> None:
    store = NoteStore(clock=FakeClock(BASE))
    with pytest.raises(KeyError):
        store.delete("missing")


def test_persists_across_instances(tmp_path) -> None:
    path = tmp_path / "notes.json"
    store = NoteStore(clock=FakeClock(BASE), path=path)
    note = store.create(NoteCreateRequest(text="milk", x=0.2, y=0.3))

    reloaded = NoteStore(clock=FakeClock(BASE), path=path)
    assert [n.text for n in reloaded.list_all()] == [note.text]
    assert reloaded.list_all()[0].x == 0.2


def test_corrupt_file_reseeds_empty(tmp_path) -> None:
    path = tmp_path / "notes.json"
    path.write_text("not json", encoding="utf-8")
    store = NoteStore(clock=FakeClock(BASE), path=path)
    assert store.list_all() == []


# -- API ------------------------------------------------------------------


def test_api_create_list_update_delete(client: TestClient) -> None:
    created = client.post("/api/notes", json={"text": "walk the dog", "x": 0.3, "y": 0.4})
    assert created.status_code == 200
    note_id = created.json()["id"]

    listed = client.get("/api/notes")
    assert listed.status_code == 200
    assert [n["id"] for n in listed.json()] == [note_id]

    updated = client.patch(f"/api/notes/{note_id}", json={"x": 0.8})
    assert updated.status_code == 200
    assert updated.json()["x"] == 0.8
    assert updated.json()["text"] == "walk the dog"

    deleted = client.delete(f"/api/notes/{note_id}")
    assert deleted.status_code == 200
    assert client.get("/api/notes").json() == []


def test_api_update_unknown_note_is_404(client: TestClient) -> None:
    response = client.patch("/api/notes/missing", json={"text": "x"})
    assert response.status_code == 404


def test_api_create_refused_while_privacy_locked(client: TestClient) -> None:
    client.post("/api/privacy/lock")
    response = client.post("/api/notes", json={"text": "walk the dog"})
    assert response.status_code == 423


def test_api_read_allowed_while_privacy_locked(client: TestClient) -> None:
    client.post("/api/notes", json={"text": "walk the dog"})
    client.post("/api/privacy/lock")
    response = client.get("/api/notes")
    assert response.status_code == 200
    assert len(response.json()) == 1


def test_api_transcribe_refused_when_disabled(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_NOTES_STT_PROVIDER", "disabled")
    from app.config import get_settings

    get_settings.cache_clear()
    response = client.post("/api/notes/transcribe", content=b"\x00\x00" * 100)
    assert response.status_code == 409


def test_api_transcribe_rejects_empty_body(client: TestClient) -> None:
    response = client.post("/api/notes/transcribe", content=b"")
    assert response.status_code == 422


def test_api_transcribe_refused_for_azure_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # "azure" is streaming-only (WS /api/notes/dictate/azure) — the one-shot
    # POST path must refuse it rather than silently falling back.
    monkeypatch.setenv("MISSION_CONTROL_NOTES_STT_PROVIDER", "azure")
    from app.config import get_settings

    get_settings.cache_clear()
    response = client.post("/api/notes/transcribe", content=b"\x00\x00" * 100)
    assert response.status_code == 409


def test_notes_stt_config_reports_azure_configured_state(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    from app.config import get_settings

    get_settings.cache_clear()
    unconfigured = client.get("/api/notes/stt-config").json()
    azure = next(p for p in unconfigured["providers"] if p["id"] == "azure")
    assert azure["configured"] is False

    monkeypatch.setenv("MISSION_CONTROL_AZURE_SPEECH_API_KEY", "test-key")
    get_settings.cache_clear()
    configured = client.get("/api/notes/stt-config").json()
    azure = next(p for p in configured["providers"] if p["id"] == "azure")
    assert azure["configured"] is True


def test_notes_dictate_azure_ws_refused_when_not_the_selected_provider(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    # The azure streaming socket must not be handed out for a different
    # active provider.
    monkeypatch.setenv("MISSION_CONTROL_NOTES_STT_PROVIDER", "gemini")
    from app.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/notes/dictate/azure"):
            pass


def test_notes_dictate_azure_ws_refused_when_not_configured(
    client: TestClient, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MISSION_CONTROL_NOTES_STT_PROVIDER", "azure")
    from app.config import get_settings

    get_settings.cache_clear()
    with pytest.raises(WebSocketDisconnect):
        with client.websocket_connect("/api/notes/dictate/azure"):
            pass
