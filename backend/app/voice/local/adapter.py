"""``VoiceProviderAdapter`` for the Local / Hybrid pipeline.

Like the Azure relay adapters, ``create_grant`` mints a **single-use ticket**
(``reusable_grant = False``) that the kiosk spends to open ``WS /api/voice/local``.
The ticket carries the interpreter thresholds and diagnostics flag; the calendar
snapshot is fetched fresh *per turn* inside the pipeline, not frozen into the
grant (a local turn is cheap and the freshness must be exact).

``missing_config`` is lenient: the pipeline always has the dependency-free
scripted recogniser for the text-bypass path, so "local" is never a hard 409 —
it only reports when the operator pinned an STT engine whose package is absent.
"""

from __future__ import annotations

from datetime import UTC, datetime, timedelta

from app.config import Settings
from app.models import VoiceProviderId, VoiceToken
from app.voice.local.engines import available_engines
from app.voice.local.interpreter import InterpreterConfig
from app.voice.local.session import LocalPipelineConfig, issue_local_ticket


class LocalHybridAdapter:
    id: VoiceProviderId = "local"
    reusable_grant = False
    # The kiosk brackets the turn (`activity-end`) and its mic-RMS detector is the
    # endpointer. A streaming STT engine may still self-endpoint earlier by
    # emitting its final transcript mid-turn (see session.py) — an optimization
    # within `client`, not a separate mode.
    default_endpointing = "client"

    def missing_config(self, settings: Settings) -> str | None:
        choice = settings.local_stt_engine
        if choice in ("faster_whisper", "sherpa_onnx") and choice not in available_engines():
            return (
                f"MISSION_CONTROL_LOCAL_STT_ENGINE={choice} but its package is not "
                f"installed (available: {', '.join(available_engines())})"
            )
        return None

    def _interpreter_config(self, settings: Settings) -> InterpreterConfig:
        return InterpreterConfig(
            intent_threshold=settings.local_intent_confidence_threshold,
            mutation_threshold=settings.local_mutation_confidence_threshold,
            entity_threshold=settings.local_entity_confidence_threshold,
            cloud_escalation_enabled=settings.local_cloud_escalation_enabled,
            person_aliases=dict(settings.local_person_aliases or {}),
        )

    def engine_label(self, settings: Settings) -> str:
        choice = settings.local_stt_engine
        if choice == "auto":
            installed = available_engines()
            choice = next((e for e in ("faster_whisper", "sherpa_onnx") if e in installed), "null")
        if choice == "null":
            return "scripted (text-only)"
        return f"{choice}/{settings.local_stt_model}"

    async def create_grant(
        self,
        settings: Settings,
        *,
        calendar_names: list[str],
        surface: str | None,
        now_local: datetime,
        timezone: str | None,
    ) -> VoiceToken:
        ttl = settings.voice_relay_ticket_ttl_seconds
        config = LocalPipelineConfig(
            interpreter=self._interpreter_config(settings),
            engine_label=self.engine_label(settings),
            diagnostics=settings.local_voice_diagnostics,
        )
        ticket = issue_local_ticket(config, ttl)
        return VoiceToken(
            provider="local",
            token=ticket,
            model=self.engine_label(settings),
            expires_at=datetime.now(UTC) + timedelta(seconds=ttl),
            endpointing="client",
            surface=surface,
        )
