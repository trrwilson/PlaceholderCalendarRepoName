import math
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import AliasChoices, Field, field_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app.models import CalendarColor, Endpointing, VoiceProviderId


def _split_csv(value: object) -> object:
    """Allow comma-separated strings for list-valued settings."""
    if isinstance(value, str):
        return [item.strip() for item in value.split(",") if item.strip()]
    return value


class Settings(BaseSettings):
    """Runtime configuration, read from the environment and an optional .env file.

    All variables use the ``MISSION_CONTROL_`` prefix, e.g.
    ``MISSION_CONTROL_CALENDAR_PROVIDER=graph``.
    """

    model_config = SettingsConfigDict(
        env_prefix="MISSION_CONTROL_",
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
        populate_by_name=True,
    )

    calendar_provider: Literal["mock", "graph", "outlook_personal"] = "mock"

    graph_tenant_id: str | None = None
    graph_client_id: str | None = None
    graph_client_secret: str | None = None

    # Personal-account (outlook.com / hotmail.com) delegated sign-in.
    graph_authority: str = "https://login.microsoftonline.com/consumers"
    graph_token_cache: str = ".msal_token_cache.json"
    # The calendar sign-in endpoints reveal the account and can sign out; by
    # default they only answer requests from the local network / loopback.
    allow_remote_auth: bool = False

    # Mailboxes to surface; each UPN / email becomes one HouseholdCalendar.
    graph_calendar_users: Annotated[list[str], NoDecode] = []
    # Optional parallel list of CalendarColor names, one per configured user.
    graph_calendar_colors: Annotated[list[str], NoDecode] = []

    @field_validator("graph_calendar_users", "graph_calendar_colors", mode="before")
    @classmethod
    def _parse_list(cls, value: object) -> object:
        return _split_csv(value)

    # -- Voice assistant --------------------------------------------------------
    # Which conversational voice provider handles a turn after activation. This
    # is a bake-off (see docs/voice-provider-bakeoff-plan.md); the kiosk chooses
    # one for good later. Wake-word selection is deliberately orthogonal to this
    # (see AGENTS.md -> "Voice assistant -> Provider architecture"). The
    # experimental "local" value selects the on-device STT + intent pipeline in
    # app/voice/local/ (its own knobs are further below). Each provider has its
    # own credential block below and its own `missing_config` check;
    # `voice_enabled` is the master switch.
    voice_provider: VoiceProviderId = "gemini"

    # -- Voice assistant: microphone capture ---------------------------------
    # Capture settings are pipeline-wide, not per provider: one microphone, one
    # gain stage, one set of rates. See docs/audio-pipeline.md.
    #
    # THE microphone level knob. A plain amplitude gain the kiosk browser applies
    # to captured PCM once, before wake-word detection and before the audio is
    # streamed to the conversational provider. Expressed in decibels and
    # converted to a linear multiplier as ``10 ** (db / 20)``; 0 dB is unity and
    # disables the stage. Kiosk microphones are typically far-field and quiet, so
    # the default lifts the level. Tune it empirically against the throttled
    # ``[voice] mic input level`` console line (peak / RMS / clip%).
    #
    # Deliberately the *only* level control: browser auto-gain-control is off so
    # it cannot fight this, and the kiosk's end-of-speech thresholds are
    # normalised to a fixed reference gain so changing this does not move them.
    # Independent of the microphone hardware and of the ``getUserMedia``
    # constraints — it only touches samples. Mirrored as the fallback default in
    # ``frontend/src/voice/gain.ts`` (``DEFAULT_INPUT_GAIN_DB``); keep in step.
    mic_input_gain_db: float = 20.0

    @field_validator("mic_input_gain_db")
    @classmethod
    def _check_mic_input_gain_db(cls, value: float) -> float:
        if not math.isfinite(value):
            raise ValueError("mic_input_gain_db must be a finite number of decibels")
        if not -30.0 <= value <= 40.0:
            raise ValueError("mic_input_gain_db must be between -30 and 40 dB")
        return value

    # -- Voice assistant: Gemini Live (native-audio) --------------------------
    # The kiosk browser talks to the Gemini Live API directly using a
    # short-lived ephemeral token minted by POST /api/voice/token; this key
    # never leaves the backend. It is provisioned as GEMINI_API_KEY_MISSION_CONTROL
    # (outside the MISSION_CONTROL_ prefix), but MISSION_CONTROL_GEMINI_API_KEY
    # also works.
    gemini_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "GEMINI_API_KEY_MISSION_CONTROL",
            "MISSION_CONTROL_GEMINI_API_KEY",
            "gemini_api_key",
        ),
    )
    voice_enabled: bool = False
    # The recommended Live model. `gemini-2.5-flash-native-audio-preview-12-2025`
    # (the previous default) is now deprecated and slated for shutdown; on it a
    # single kiosk turn spent ~5.7 s between end-of-speech and the first
    # transcript and generated reply audio at ~0.46x real time. Google's
    # ephemeral-token docs now specify `v1beta` (they said `v1alpha` when this
    # was first written, which is why the old model was pinned), and the JS
    # example on that page uses this model with no apiVersion override.
    gemini_live_model: str = "gemini-3.1-flash-live-preview"
    # API version for BOTH the minting client and the browser's Live connection —
    # they must match, and the browser now reads it off the token response rather
    # than hard-coding it. Set to "v1alpha" together with a `...-native-audio-...`
    # model to fall back to the old path.
    gemini_live_api_version: str = "v1beta"
    # Any prebuilt Gemini voice name (e.g. Zephyr, Puck, Charon, Kore, Aoede).
    gemini_voice: str = "Zephyr"
    # Optional BCP-47 code. Left blank for native-audio (it auto-detects and the
    # system prompt pins the response language); set for half-cascade models.
    gemini_language_code: str = ""
    # Google-side ephemeral-token envelope: both `expire_time` and
    # `new_session_expire_time` are set this far out. It is only an outer bound —
    # the backend stops handing a cached token out well before this (see
    # `voice_token_max_stale_seconds` and the event-boundary invalidation in
    # `app/voice/cache.py`). The Gemini API hard-caps this under 20 hours.
    voice_token_ttl_seconds: int = 14_400  # 4 hours
    # The longest a *cached* token is re-served regardless of the calendar. Real
    # invalidation is usually sooner — the next event start/end or local midnight,
    # whichever comes first — so a stale "It is now …" stamp can never make
    # "what's next" name an event that has already ended. Keep below the ttl.
    voice_token_max_stale_seconds: int = 1_800  # 30 minutes
    # How long the calendar snapshot behind the voice prompt (household names +
    # event boundary times) is reused before another provider fetch. Bounds the
    # blocking Graph request that otherwise lands on every token mint.
    voice_prompt_cache_ttl_seconds: int = 120
    # Uses allowed per minted token. 0 = unlimited within the ttl window, which is
    # what lets one cached token back many kiosk turns. The token still carries
    # the full locked constraints (model, prompt, tools, voice) and the endpoint
    # stays LAN-gated, so a leaked token can only open more of the same
    # constrained session. Set to a small positive number to tighten that.
    voice_token_uses: int = 0
    # End-of-speech ownership for Gemini (see `app.models.Endpointing` and
    # docs/voice-provider-bakeoff-plan.md -> "End-of-speech ownership").
    # `False` (default) selects `endpointing = "hybrid"`: the service runs its own
    # streaming voice-activity detection — which is what keeps incremental ASR
    # running *while* the person is still talking — and the kiosk's RMS silence
    # detector additionally sends `audioStreamEnd` to finalise the turn the
    # instant it hears the pause, instead of waiting out the server's timeout.
    # `True` selects `endpointing = "client"`: fully manual activityStart/
    # activityEnd with the service VAD switched off. Manual was the escape hatch
    # adopted in 2026-09 when the old native-audio model produced silent turns
    # under automatic VAD; the cost is that the server then buffers the whole
    # utterance and only transcribes it after `activityEnd`, which is where the
    # multi-second post-utterance stall and the total absence of
    # `interimInputTranscription` came from.
    voice_manual_activity: bool = False
    # Service-VAD endpointing, used only when `voice_manual_activity` is False.
    # Google's own low-latency example uses 20 ms / 100 ms; these are a little
    # looser so a mid-sentence breath does not cut someone off, and the kiosk's
    # own detector is normally what ends the turn anyway.
    voice_prefix_padding_ms: int = 100
    voice_silence_duration_ms: int = 250

    # -- Voice assistant: Azure contestants (bake-off) -----------------------
    # Neither Azure provider connects browser-direct (the browser WebSocket API
    # cannot set the auth header), so the kiosk connects to our own
    # `WS /api/voice/live` relay and the backend holds the upstream socket and
    # credentials, translating events to the shared `VoiceEvent` protocol.
    # UNVERIFIED against live Azure resources (see docs/voice-provider-bakeoff-plan.md).

    # Azure OpenAI Realtime — the **GA `/openai/v1` surface**: OpenAI-parity, no
    # `api-version`, `model=<deployment>` in the URL, the GA event model
    # (`session.type: "realtime"`, nested `audio.input`/`audio.output`,
    # `response.output_audio.delta`). `gpt-realtime-2.1` and `...-mini` are two
    # contestants off one resource, distinguished by deployment name.
    azure_openai_endpoint: str | None = None  # https://<resource>.openai.azure.com
    # Provisioned in the environment as FOUNDRY_API_KEY_MC_EASTUS2 (the Foundry
    # resource key, shared by the realtime and Voice Live surfaces), but an
    # explicit MISSION_CONTROL_AZURE_OPENAI_API_KEY wins if set.
    azure_openai_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "MISSION_CONTROL_AZURE_OPENAI_API_KEY",
            "FOUNDRY_API_KEY_MC_EASTUS2",
            "azure_openai_api_key",
        ),
    )
    azure_openai_realtime_deployment: str = "gpt-realtime-2.1"
    azure_openai_realtime_mini_deployment: str = "gpt-realtime-2.1-mini"
    azure_openai_realtime_voice: str = "marin"
    # End-of-speech ownership for the realtime path (see `app.models.Endpointing`).
    # `hybrid` (default): `semantic_vad` runs with `create_response: false` — it
    # keeps a streaming recogniser under the audio and emits `speech_stopped`,
    # which the kiosk endpoints on, but the kiosk still owns the reply. `client`:
    # `turn_detection: null`, the kiosk's mic-RMS detector is the whole endpointer.
    # `provider`: `semantic_vad` with `create_response: true` — the model answers
    # on its own VAD endpoint and the kiosk sends no finalise. `semantic_vad`
    # deliberately waits through an incomplete phrase ("set a timer for…"), which
    # a raw-energy detector cannot, so `hybrid` is the better default.
    azure_openai_realtime_endpointing: Endpointing = "hybrid"
    # Deployment name of a transcribe model for the user's speech. Default
    # `gpt-4o-transcribe` (verified deployed on mc-foundry-eastus2). Blank turns
    # the user transcript off; a name with no matching deployment degrades to a
    # logged `input_audio_transcription.failed` without breaking the turn. Note:
    # with manual turn control transcription runs *after* the commit, not word by
    # word as you speak — that needs a server-VAD turn detection.
    azure_openai_transcribe_deployment: str = "gpt-4o-transcribe"

    # Azure Voice Live — a separate speech-first product (input noise reduction,
    # server-side echo cancellation, Azure semantic VAD, HD voices). Still uses
    # `api-version` and the flat/beta session shape (`modalities`, `voice` object).
    azure_voice_live_endpoint: str | None = None  # <resource>.services.ai.azure.com
    # Falls back to the shared Foundry key (FOUNDRY_API_KEY_MC_EASTUS2) when no
    # Voice-Live-specific key is set.
    azure_voice_live_api_key: str | None = Field(
        default=None,
        validation_alias=AliasChoices(
            "MISSION_CONTROL_AZURE_VOICE_LIVE_API_KEY",
            "FOUNDRY_API_KEY_MC_EASTUS2",
            "azure_voice_live_api_key",
        ),
    )
    azure_voice_live_api_version: str = "2026-07-15"
    azure_voice_live_model: str = "gpt-realtime"
    # An Azure *standard* neural voice (not an HD/Dragon voice). `en-GB-SoniaNeural`
    # is Azure's flagship British English female voice (the default en-GB voice,
    # style-capable). Swap for an en-AU / en-US name to change the accent.
    azure_voice_live_voice: str = "en-GB-SoniaNeural"
    azure_voice_live_voice_type: str = "azure-standard"
    azure_voice_live_transcribe_model: str = "whisper-1"
    # End-of-speech ownership for Voice Live. `azure_semantic_vad` is *always* in
    # the session — the live resource rejects server-side echo cancellation when
    # turn detection is off and then kills the session — so `client` is not
    # available here. `hybrid` (default) keeps `create_response: false` (kiosk
    # owns the reply, endpoints on the forwarded `speech_stopped`); `provider`
    # flips `create_response: true` so Voice Live answers on its own endpoint.
    azure_voice_live_endpointing: Literal["hybrid", "provider"] = "hybrid"

    # How long a relay ticket (handed to the kiosk in the grant, spent to open the
    # `WS /api/voice/live` socket) stays valid. Short — it is used once, seconds
    # after minting.
    voice_relay_ticket_ttl_seconds: int = 120

    # -- Wake word (browser-resident local activation) ---------------------
    # Local keyword spotting in the kiosk browser: when it hears the wake
    # phrase it opens a normal voice turn (the same path as tapping Ask). Off
    # by default — it needs a trained model asset provisioned (see
    # ``docs/wake-word-model-training.md``). Idle wake-word audio never leaves
    # the browser; only the post-wake turn reaches Gemini. Requires
    # ``voice_enabled`` — the endpoint reports ``enabled`` only when both are set.
    wake_word_enabled: bool = False
    # The phrase the model is trained for. Informational (changing it retrains
    # nothing) but shown in Settings and diagnostics.
    wake_word_phrase: str = "Mission Control"
    # openWakeWord score (0..1) above which a frame counts as the wake phrase.
    # Higher = fewer false activations but more missed ones.
    wake_word_threshold: float = 0.3
    # Ignore further detections for this long after one fires, so a single
    # utterance cannot open two turns.
    wake_word_cooldown_ms: int = 2_000
    # Frontend-served path to the trained wake model. The shared openWakeWord
    # feature models load from ``{wake_word_models_base_url}/melspectrogram.onnx``
    # and ``.../embedding_model.onnx``.
    wake_word_model_path: str = "/models/wake/mission_control.onnx"
    wake_word_models_base_url: str = "/models/wake"

    # -- Voice debug audio capture ----------------------------------------
    # The kiosk keeps the last N activations' provider-input audio in the
    # browser; when this is on it also POSTs each finished capture to
    # ``POST /api/voice/debug/capture``, which writes a headered WAV plus a
    # ``.json`` sidecar here so a wake-word / endpointing / misheard-command
    # problem can be played back. Local-only, like every voice route. Relative
    # paths are under the backend working directory (alongside the MSAL cache);
    # an absolute path works too.
    voice_debug_capture_enabled: bool = True
    voice_debug_capture_dir: str = "voice-captures"
    # Headered WAV + sidecar pairs kept on disk; the oldest are pruned as new
    # ones arrive. 0 keeps everything.
    voice_debug_capture_keep: int = 10

    # -- Voice assistant: Local / Hybrid pipeline (experimental) -----------
    # A fifth "provider" (`MISSION_CONTROL_VOICE_PROVIDER=local`) that runs
    # speech recognition and intent/entity interpretation on this host instead
    # of a cloud speech-to-speech service, and only escalates to a cloud model
    # for requests that genuinely need general language reasoning. See
    # docs/local-voice-plan.md and AGENTS.md -> "Voice assistant -> Local /
    # Hybrid pipeline". Nothing here affects the cloud contestants.
    #
    # STT engine: "auto" picks the first installed of faster_whisper /
    # sherpa_onnx, else a dependency-free scripted recogniser (text-bypass only).
    local_stt_engine: Literal["auto", "faster_whisper", "sherpa_onnx", "null"] = "auto"
    # faster-whisper: a model id ("tiny.en", "base.en", "small.en", "distil-small.en").
    # sherpa-onnx: a streaming-zipformer model directory (abs path or under
    # local_stt_models_dir). Command recognition wants a *small* model. On this
    # dev box's CPU (int8), measured end-of-speech -> final transcript:
    # tiny.en ~160 ms, base.en ~280 ms, small.en ~870 ms, at near-identical WER
    # on short commands (docs/local-stt-evaluation.md) — so base.en is the
    # default; drop to tiny.en for the snappiest response, raise to small.en only
    # if a slower kiosk CPU shows accuracy problems.
    local_stt_model: str = "base.en"
    local_stt_device: Literal["auto", "cpu", "cuda"] = "auto"
    # faster-whisper compute type; "auto" -> int8 on CPU, float16 on CUDA.
    local_stt_compute_type: str = "auto"
    local_stt_beam_size: int = 1
    # Where engines cache downloaded model files. Blank -> the engine default
    # (the Hugging Face cache for faster-whisper). Model binaries are never
    # committed (AGENTS.md -> "ML / audio / vision model artifacts").
    local_stt_models_dir: str = ""
    # Interpretation thresholds. Below `intent` -> escalate/clarify; a *mutating*
    # request below `mutation` is never executed on a guess (it asks instead).
    local_intent_confidence_threshold: float = 0.55
    local_mutation_confidence_threshold: float = 0.8
    local_entity_confidence_threshold: float = 0.55
    # When false, requests the local layer can't handle are a plain "can't do
    # that" instead of being handed to a cloud model.
    local_cloud_escalation_enabled: bool = True
    # Casual -> real name hints for entity resolution ("mom=Sarah,dad=Travis").
    # Only a hint; an alias still has to fuzzy-match a real household calendar.
    local_person_aliases: Annotated[dict[str, str], NoDecode] = {}
    # Emit the full interpretation trace (transcript, intent scores, entity
    # candidates, timings) on the diagnostic channel / `POST .../local/interpret`.
    local_voice_diagnostics: bool = True

    @field_validator("local_person_aliases", mode="before")
    @classmethod
    def _parse_aliases(cls, value: object) -> object:
        if isinstance(value, str):
            out: dict[str, str] = {}
            for pair in value.split(","):
                if "=" in pair:
                    key, val = pair.split("=", 1)
                    if key.strip() and val.strip():
                        out[key.strip()] = val.strip()
            return out
        return value

    # -- Timers -------------------------------------------------------------
    # The product ceiling for a timer / alarm lookahead. Overridable, but this is
    # the documented ceiling and is enforced in three places (Pydantic model,
    # voice tool-argument check, touch dial).
    timer_max_seconds: int = 21_600  # six hours
    # How long the expiry chime loops before it stops on its own. The visual
    # "Timer finished" state persists until a person dismisses it regardless.
    timer_alarm_max_ring_seconds: int = 300

    def calendar_color_for(self, index: int) -> CalendarColor:
        """Assign a stable CalendarColor to the configured user at ``index``.

        Uses ``graph_calendar_colors`` when provided, otherwise round-robins
        through the ``CalendarColor`` enum.
        """
        if self.graph_calendar_colors:
            name = self.graph_calendar_colors[index % len(self.graph_calendar_colors)]
            return CalendarColor(name)
        palette = list(CalendarColor)
        return palette[index % len(palette)]


@lru_cache
def get_settings() -> Settings:
    return Settings()
