import math
from functools import lru_cache
from typing import Annotated, Literal

from pydantic import AliasChoices, Field, field_validator, model_validator
from pydantic_settings import BaseSettings, NoDecode, SettingsConfigDict

from app.models import CalendarColor, Endpointing, VoiceProviderId, WakeProviderId


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

    # -- Host colocation & the physical display -------------------------------
    # Formal assertion that this backend process runs on the same physical host
    # as the kiosk browser and owns the attached wall panel. It is the single
    # structural gate for every capability that only exists under that topology
    # (see app/host.py and docs/display-dimming-plan.md -> "Colocation is
    # explicit"); the future presence / display-sleep path gates on it too.
    # Every OS / device-API call below is inert unless this is true.
    host_local_display: bool = False

    # Which mechanism drives panel brightness. ``auto`` probes ``wmi`` → ``ddcci``
    # when ``host_local_display`` is set and adopts the first that verifiably
    # moves the panel, otherwise ``none`` (a no-op controller — dev, CI, and any
    # host that is not colocated). ``wmi`` is the OS brightness slider (integrated
    # panels); ``ddcci`` is DDC/CI over the monitor cable (external panels).
    # ``gamma`` / ``overlay`` from the plan doc are later phases.
    display_control_mechanism: Literal["auto", "wmi", "ddcci", "none"] = "auto"
    # Assumed full brightness (0-100) when the mechanism cannot read the panel's
    # real level at startup. The reference the panel is restored to.
    display_default_brightness: int = 100
    # Night mode drops the panel to this percentage of the reference brightness
    # captured when it was switched on. 10 => a 100-bright panel goes to 10.
    display_night_mode_level_pct: int = 10

    # -- Idle display dimming, presence-driven (docs/display-dimming-plan.md —
    # a basic first slice) -----------------------------------------------
    # That doc designs a fuller inactivity policy (activity pulses from touch/
    # voice/timers, an `asleep` level, restoring to "whatever it was"). This is
    # a smaller, more direct version: dim/restore driven purely by kiosk-scope
    # presence signals (today, only this MVP's local-camera `motion` events),
    # restoring to a *fixed* configured level rather than the prior one — see
    # `app/presence/display_policy.py`. Reuses the exact brightness primitive
    # ("night mode") already built here; see `DisplayStore.set_ambient_brightness`.
    #
    # On by default (that doc's own default is off) — presence itself is on by
    # default in this build, and the point of that is to see it drive
    # something observable without extra configuration.
    display_dim_enabled: bool = True
    # Idle time with no kiosk-scope presence signal before the panel dims. A
    # much shorter fuse than `presence_inactivity_timeout_seconds` above (which
    # is the standing "is someone home" claim, not ambient screen dimming).
    display_dim_after_seconds: float = 20.0
    # Target brightness (0-100) while dimmed.
    display_dim_level: int = 0
    # Target brightness (0-100) a presence signal restores to, *unless* night
    # mode is on — night mode's own (dynamically computed) level takes over as
    # the restore target in that case, so a household that dimmed the panel for
    # the evening does not get jolted back to full brightness by someone
    # walking past (see `PresenceDisplayPolicy`).
    display_dim_restore_level: int = 80

    @field_validator("display_dim_after_seconds")
    @classmethod
    def _check_display_dim_after_seconds(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("display_dim_after_seconds must be positive")
        return value

    @field_validator("display_dim_level", "display_dim_restore_level")
    @classmethod
    def _check_display_dim_pct(cls, value: int) -> int:
        if not 0 <= value <= 100:
            raise ValueError("must be between 0 and 100")
        return value

    @field_validator("display_default_brightness")
    @classmethod
    def _check_default_brightness(cls, value: int) -> int:
        if not 0 <= value <= 100:
            raise ValueError("display_default_brightness must be between 0 and 100")
        return value

    @field_validator("display_night_mode_level_pct")
    @classmethod
    def _check_night_mode_level(cls, value: int) -> int:
        if not 1 <= value <= 100:
            raise ValueError("display_night_mode_level_pct must be between 1 and 100")
        return value

    # -- Presence: local webcam motion (Phase 1 MVP) --------------------------
    # See docs/presence-module-plan.md (the general PresenceSignal/aggregator
    # contract) and docs/camera-support-plan.md (this kiosk-scope implementation).
    # This MVP does coarse *motion* detection only (frame-to-frame change, not
    # person detection) — see app/presence/sources/local_camera.py.
    #
    # Master flag for the presence *feature* (the aggregator + `/api/presence*`
    # routes). On by default, unlike most feature flags here, because the
    # aggregator itself does no I/O — it is a pure state machine, safe under
    # pytest and on any host. The camera thread is a separate concern, gated
    # by `host_local_camera` below.
    presence_enabled: bool = True
    # A single missed/absent observation must not sleep the display; the kiosk
    # scope's `present` claim only flips to false after continuous absence for
    # this long. Not consulted by this MVP's `motion` signals (which never set
    # `present` — see PresenceAggregator.observe); ready for a future real
    # presence/person detector (camera-support-plan.md step 4).
    presence_inactivity_timeout_seconds: int = 900
    # Detector confidence floor. Reserved for a future real presence/person
    # detector (camera-support-plan.md step 4); this MVP's motion detector
    # gates on `presence_motion_min_area_ratio` instead and leaves this unused.
    presence_confidence_threshold: float = 0.6
    # Motion-detector cadence. One frame is captured and scored per interval —
    # deliberately far below the webcam's native frame rate (camera-support-plan.md
    # -> "modest ... inference cadence"), but this is also the biggest lever on
    # how long someone waits after stepping into frame before the panel
    # brightens (the aggregator/display-policy hop is in-process and near-
    # instant by comparison). 150 ms keeps that wait short while staying cheap:
    # MOG2 over a 320x240 downscaled frame is well under a millisecond of CPU.
    presence_inference_interval_ms: int = 150
    # Device name/path/index override; blank = auto-select (index 0).
    presence_camera_device: str | None = None
    # The motion gate: the smallest contiguous foreground blob, as a fraction of
    # the (downscaled) analysis frame, that counts as motion. This is what keeps
    # sensor noise / small reflections from tripping the detector while still
    # catching a person crossing the background — tuned low because recall
    # matters far more than a rare false positive here.
    presence_motion_min_area_ratio: float = 0.015
    # The motion ceiling: a blob *larger* than this fraction of the frame is
    # treated as a global scene change (a light switching, exposure/white-balance
    # jump, a hand over the lens) rather than a person, and is not reported as
    # motion. The background subtractor already absorbs a *slow* brightness
    # drift into its model, but an abrupt, large brightness change can briefly
    # register as one frame-filling "foreground" blob before it catches up —
    # this ceiling is what rejects that case specifically (a person practically
    # never fills more than this much of a webcam's frame).
    presence_motion_max_area_ratio: float = 0.6
    # Formal assertion (mirrors `host_local_display`) that this process owns a
    # physical webcam on this host. **On by default** — an opt-out, not an
    # opt-in: a plain `uvicorn app.main:app` run is expected to just work
    # against whatever webcam the host has. Set this to `false` on a host with
    # no webcam, or one that should never touch one (a non-colocated dev
    # machine, a shared server). Tests never see this default regardless — the
    # autouse `isolate_settings` fixture (`tests/conftest.py`) forces it off so
    # pytest/CI never opens real hardware no matter what the app default is.
    host_local_camera: bool = True

    @field_validator("presence_inactivity_timeout_seconds", "presence_inference_interval_ms")
    @classmethod
    def _check_presence_positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive number of seconds/milliseconds")
        return value

    @field_validator(
        "presence_confidence_threshold",
        "presence_motion_min_area_ratio",
        "presence_motion_max_area_ratio",
    )
    @classmethod
    def _check_presence_unit_fraction(cls, value: float) -> float:
        if not 0.0 < value <= 1.0:
            raise ValueError("must be between 0 (exclusive) and 1")
        return value

    @model_validator(mode="after")
    def _check_presence_motion_band(self) -> "Settings":
        if self.presence_motion_min_area_ratio >= self.presence_motion_max_area_ratio:
            raise ValueError(
                "presence_motion_min_area_ratio must be less than presence_motion_max_area_ratio"
            )
        return self

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
    # one for good later. `azure_voice_live` is the current default — a
    # speech-first product (input noise reduction, server-side echo cancellation,
    # Azure semantic VAD, HD voices), reached through the `WS /api/voice/live`
    # relay. Wake-word selection is deliberately orthogonal to this (see
    # AGENTS.md -> "Voice assistant -> Provider architecture"). The experimental
    # "local" value selects the on-device STT + intent pipeline in
    # app/voice/local/ (its own knobs are further below). Each provider has its
    # own credential block below and its own `missing_config` check;
    # `voice_enabled` is the master switch.
    voice_provider: VoiceProviderId = "azure_voice_live"

    # -- Voice assistant: microphone capture ---------------------------------
    # Capture settings are pipeline-wide, not per provider: one microphone, one
    # gain stage, one set of rates. See docs/audio-pipeline.md.
    #
    # THE microphone level knob. A plain amplitude gain the kiosk browser applies
    # to captured PCM once, before wake-word detection and before the audio is
    # streamed to the conversational provider. Expressed in decibels and
    # converted to a linear multiplier as ``10 ** (db / 20)``; 0 dB is unity and
    # disables the stage. Defaults to 0: the kiosk now captures through a
    # hardware microphone path with adequate level, so no software boost is
    # applied unless an install needs one. Tune it empirically against the
    # throttled ``[voice] mic input level`` console line (peak / RMS / clip%).
    #
    # Deliberately the *only* level control: browser auto-gain-control is off so
    # it cannot fight this, and the kiosk's end-of-speech thresholds are
    # normalised to a fixed reference gain so changing this does not move them.
    # Independent of the microphone hardware and of the ``getUserMedia``
    # constraints — it only touches samples. Mirrored as the fallback default in
    # ``frontend/src/voice/gain.ts`` (``DEFAULT_INPUT_GAIN_DB``); keep in step.
    mic_input_gain_db: float = 0.0

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
    # How many days of the household schedule (title / time / location, one line
    # per day) are baked into the voice system instruction, so a loose reference
    # like "that doctor appointment in Bellevue later this month" resolves
    # without a tool call. Also the window the Local / Hybrid pipeline resolves
    # entities against per turn. Widening it grows the prompt (~a line per busy
    # day) and the snapshot fetch; the token cache still amortises both.
    voice_context_days: int = 30
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

    # Which wake-word detector spots the phrase. Orthogonal to
    # ``voice_provider`` — a bake-off in its own right (AGENTS.md -> "Wake
    # word"). ``openwakeword`` (default) runs entirely in the kiosk browser;
    # ``azure`` streams mic audio to the backend, which spots the phrase offline
    # with the native Speech SDK. Switchable at runtime from Settings
    # (``PUT /api/voice/wake-config``, process-memory, reverts on restart).
    wake_word_provider: WakeProviderId = "openwakeword"
    # Backend filesystem path to the Azure custom-keyword ``.table`` (Speech
    # Studio export). Resolved relative to the backend working directory; the
    # default points at the single copy under the frontend's public assets.
    # Only read by the ``azure`` provider, and only when the ``azure-wake``
    # optional dependency (``pip install -e '.[azure-wake]'``) is installed —
    # keyword spotting itself is on-device and needs no Azure credentials.
    wake_word_azure_model_path: str = (
        "../frontend/public/models/wake/azure_mission_control_basic_med.table"
    )

    # -- Wake word: the on-device Invoke gate (additive) ------------------
    # The ``invoke-gate`` daemon on the Harman Kardon Invoke (``wakeword/`` in
    # the ReInvoke2026 repo) runs a loose first-stage KWS + an audio egress
    # gate. It is NOT a wake provider — it sits *in front of* whichever provider
    # (``openwakeword`` / ``azure``) is selected. The gated audio reaches the
    # kiosk over VB-CABLE exactly as today; the backend only bridges the
    # daemon's control channel (``WS /api/voice/wake/invoke`` -> the daemon's
    # TCP ``control_port``), mirroring the ``azure`` wake relay.
    #
    # Empty host ⇒ the feature is unavailable (Settings hides the toggle).
    wake_word_invoke_gate_host: str = ""  # e.g. "192.168.50.67"
    wake_word_invoke_gate_audio_port: int = 5004
    wake_word_invoke_gate_control_port: int = 5005
    # Turn the additive gate on. **Off by default.** On ⇒ the kiosk opens the
    # bridge, tells the daemon to gate its egress (``gate_enabled:true``), and
    # AND-gates activation on the gate window *and* the selected detector's
    # confirmation. Toggle at runtime from Settings
    # (``PUT /api/voice/wake-config {"invoke_gate_enabled": true}``, process-memory).
    wake_word_invoke_gate_enabled: bool = False

    # -- Voice output: the Wi-Fi speaker path to the Invoke (additive) ----
    # ON HOLD (2026-09): the Wi-Fi speaker reliability work is tabled and the
    # kiosk uses Bluetooth for output. Empty ``invoke_speaker_host`` (the
    # default) is the intended state; the on-device daemon is never auto-started
    # — only an explicit ``invokectl speaker-daemon up`` brings it up.
    # The ``invoke_speaker_daemon.sh`` receiver on the Harman Kardon Invoke
    # (ReInvoke2026 ``output/``) plays raw PCM it receives on a LAN TCP port out
    # the speakers, via the stock ``music`` ALSA route so the SHARC DSP's
    # hardware AEC still uses it as the echo reference. When the kiosk's
    # Settings -> Speaker output picker is set to "Invoke", the browser streams
    # its whole output bus (assistant replies, the listening cue, the timer
    # chime) to ``WS /api/voice/speaker`` and :mod:`app.voice.speaker` forwards
    # it to the daemon over TCP -- no OS-wide virtual audio device, no separate
    # feeder process. Empty host ⇒ the picker offers only "This screen"; it then
    # falls back to ``wake_word_invoke_gate_host`` so one ``…INVOKE…HOST`` value
    # commonly configures both directions.
    invoke_speaker_host: str = ""  # e.g. "192.168.50.67"
    invoke_speaker_audio_port: int = 5006
    # Wire format on the :5006 stream (ReInvoke2026 Phase 1b). There is no control
    # channel here, so this MUST equal every other end: the device daemon's
    # ``SPK_CODEC`` (``output/invoke_speaker_daemon.sh``), ``invokectl`` key
    # ``speaker_codec``, and ``invoke_speaker_feeder.py --codec``. A mismatch
    # plays back garbled and badly slowed. See ReInvoke2026
    # ``transport/AUDIO_COMPRESSION_FEASIBILITY.md`` §8.
    #   ``s16``   S16LE 48k/2ch — half the bytes, eases the 2.4 GHz airtime
    #             contention with the mic uplink; provably inaudible. The default
    #             on the daemon too.
    #   ``g711u`` µ-law 48k/2ch — a quarter of the bytes, opt-in "bad link".
    #   ``raw``   S32LE 48k/2ch — the bit-exact escape hatch.
    invoke_speaker_codec: str = "s16"
    # Open-loop clock-drift correction, parts per million, applied to the stream
    # as a periodic single-sample slip (positive ⇒ the Invoke DAC runs fast, so
    # a sample is dropped every ``1e6 / ppm``; negative ⇒ a sample is repeated).
    # 0 = no correction; the device-side buffer absorbs the residual as an
    # occasional inaudible slip. Feed-forward the ppm the ReInvoke2026 mic feeder
    # prints.
    invoke_speaker_drift_ppm: float = 0.0

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

    # -- Lists (grocery, for now) ----------------------------------------
    # Unlike timers, a household list is durable — it is persisted to this one
    # JSON file (relative -> the backend working dir, alongside the MSAL cache;
    # an absolute path works too) and reloaded at startup. Same "one file, no
    # datastore" class as the token cache. Blank disables persistence (the list
    # is then in-memory only, like a timer). See docs/lists-plan.md.
    lists_file: str = "lists.json"
    # How many distinct past item names the touch quick-add grid remembers.
    lists_recent_items_max: int = 20

    # -- Privacy mode ---------------------------------------------------------
    # A houseguest-facing "redact the specifics + read-only" state. Entered from
    # the kiosk (long-press the logo, Settings, or ask the assistant) with no
    # secret; left only by entering this PIN on the on-screen 0-9 keypad. This is
    # backend config only — there is deliberately no in-app way to set it
    # (docs/privacy-mode-plan.md). The feature is inert until a PIN is set: with
    # none, the entry affordances are hidden and POST /api/privacy/lock 409s, so
    # nobody can be locked out.
    #
    # MVP is a four-digit PIN on a fixed keypad (7-8-9 / 4-5-6 / 1-2-3 / 0). The
    # default 8426 traces up-left-down-right on that layout (8 top, 4 left, 2
    # bottom, 6 right). Blank disables the whole feature.
    privacy_mode_pin: str = "8426"
    # Persisted so a power-cycle does not defeat the lock — relative -> backend
    # working dir, alongside lists.json / the MSAL cache. Blank -> in-memory only.
    privacy_state_file: str = "privacy.json"
    # Wrong-PIN attempts before the keypad is disabled for a cooldown, and the
    # base cooldown (it doubles on each further lockout, capped at an hour). The
    # counters are process memory only — a restart clears them.
    privacy_unlock_max_attempts: int = 5
    privacy_unlock_cooldown_seconds: int = 60
    # A just-entered privacy mode can be turned off with no PIN for this long —
    # covers an accidental or prank entry without weakening the real barrier.
    privacy_undo_grace_seconds: int = 8

    @field_validator("privacy_mode_pin")
    @classmethod
    def _check_privacy_mode_pin(cls, value: str) -> str:
        pin = value.strip()
        if pin and (not pin.isdigit() or len(pin) != 4):
            raise ValueError("privacy_mode_pin must be exactly four digits (or blank to disable)")
        return pin

    # -- Eufy camera clip gallery ------------------------------------------
    # On-demand thumbnail/video review of recent eufy camera clips, replacing
    # the home-view "garage door" placeholder. Verified against real HomeBase 3
    # hardware (docs/eufy-sdk-integration.md); a small Node sidecar
    # (`eufy-bridge/`, `eufy-security-client`) does the P2P/cloud work and talks
    # to this backend over a localhost WebSocket the backend supervises as a
    # child process. Off by default — false ⇒ no bridge spawned, no eufy code
    # imported, `/api/household` and the clip endpoints 409.
    eufy_enabled: bool = False
    eufy_email: str | None = None
    eufy_password: str | None = None
    # Must match the eufy app's account region exactly (verified "US" 2026-09-10).
    eufy_region: str = "US"
    # Bridge session file — cloud tokens + push credentials + openudid. Always
    # tried before a fresh login (docs/eufy-sdk-integration.md §5.5): the whole
    # point is minimizing cloud-facing auth traffic. Relative -> backend working
    # dir, alongside .msal_token_cache.json; git-ignored.
    eufy_session_file: str = ".eufy_persistent.json"
    # The device fingerprint (`openudid`) is generated and persisted by
    # eufy-security-client itself, inside the session file (§5.5) — it is not
    # a settable field on `EufySecurityConfig` (verified against the real
    # 4.1.1-1 type definitions, 2026-09-11). Nothing to configure here;
    # changing accounts/devices is what would force a fresh one.
    #
    # This household's HomeBase LAN IP + station serial — local P2P discovery
    # was unreliable without an explicit `stationIPAddresses` hint in the
    # verification spike, and that config option is keyed by serial, so both
    # must be set together for the hint to take effect. Blank = rely on
    # discovery (verified 2026-09-10: unreliable without this).
    eufy_station_lan_ip: str | None = None
    eufy_station_serial: str | None = None  # this household: "T8030P13232003FB"
    # Optional {serial: "Front door"} friendly-name overrides; falls back to the
    # device's own name from the SDK. Same "key=value,key2=value2" parsing as
    # local_person_aliases.
    eufy_camera_names: Annotated[dict[str, str], NoDecode] = {}

    @field_validator("eufy_camera_names", mode="before")
    @classmethod
    def _parse_eufy_camera_names(cls, value: object) -> object:
        if isinstance(value, str):
            out: dict[str, str] = {}
            for pair in value.split(","):
                if "=" in pair:
                    key, val = pair.split("=", 1)
                    if key.strip() and val.strip():
                        out[key.strip()] = val.strip()
            return out
        return value

    # The bridge's own cloud-session housekeeping refresh. A too-large value
    # here previously overflowed Node's 32-bit setTimeout and fired the cloud
    # refresh call roughly every millisecond instead — ~356 extra authenticated
    # calls in under two minutes (docs/eufy-sdk-integration.md §5.6.1). Validated
    # below to a sane range; never pass anything meant as "infinite"/"disabled".
    eufy_polling_interval_minutes: int = 1440  # once/day

    @field_validator("eufy_polling_interval_minutes")
    @classmethod
    def _check_eufy_polling_interval(cls, value: int) -> int:
        # Comfortably under Node setTimeout's ~35,791-minute (2^31 ms) overflow
        # ceiling, with headroom — see the §5.6.1 incident this guards against.
        if not 1 <= value <= 44_640:  # 31 days
            raise ValueError("eufy_polling_interval_minutes must be between 1 and 44640")
        return value

    # How often the bridge re-lists each camera's local event database
    # (`databaseQueryByDate`) to discover new clips. This is a **LAN-local P2P
    # call to the HomeBase, not a call to eufy's cloud** — safe to run often
    # (see AGENTS.md -> "minimize cloud-facing activity"). Real-time device
    # events (motion/person/doorbell/etc.) additionally trigger an immediate
    # targeted re-list for that one camera, so this interval is a fallback, not
    # the primary freshness path.
    eufy_reconcile_interval_seconds: int = 120
    # How far back each reconciliation query looks, to tolerate a missed push
    # or a bridge restart without re-scanning the station's whole (thousands of
    # events) local index.
    eufy_reconcile_lookback_minutes: int = 10

    @field_validator("eufy_reconcile_interval_seconds", "eufy_reconcile_lookback_minutes")
    @classmethod
    def _check_eufy_positive_int(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive number of seconds/minutes")
        return value

    # Off by default. `eufy_reconcile_interval_seconds`'s `databaseQueryByDate`
    # call has a documented, reproducible freshness bug on this household's
    # real hardware (docs/eufy-sdk-integration.md §16.2/§19.2): a date-range
    # query returns a stale cluster at the OLDEST edge of the requested
    # window, not the most recent events. This flag turns on a second,
    # independent SDK/session (`@mega-yfue/eufy-sdk`, isolated inside
    # `eufy-bridge/`) that instead issues a `history_record_info` FULL_TABLE
    # query (no date bounds at all) on the same cadence, feeding the exact
    # same clip-discovery pipeline — confirmed live against the real T8030 to
    # not exhibit that bug (§19.1). Requires `eufy_station_serial` to be set;
    # the bridge logs a warning and stays off without it. See §20 for how to
    # test this against real hardware.
    eufy_mega_enumeration_enabled: bool = False
    # Separate persisted session file — a different SDK, a different
    # persistence format, never shared with `eufy_session_file`.
    eufy_mega_session_file: str = ".eufy_mega_persistent.json"

    # Bounded ring buffer of the most recent discovered clips (across all
    # cameras) kept in memory for the gallery; oldest drop off as new arrive.
    eufy_clip_ring_buffer_size: int = 20
    # Bounded LRU of decoded thumbnail JPEGs kept in memory, so re-rendering the
    # gallery never re-decodes a thumbnail already shown.
    eufy_thumbnail_cache_size: int = 20
    # A stored record carries a frame count but not a frame rate (the true rate
    # is only known once a download actually starts); this is the assumed rate
    # used to turn frame_num into an approximate duration label for the gallery
    # (the verified spike's clip was ~15fps). Purely cosmetic — never used for
    # playback.
    eufy_assumed_fps: float = 15.0
    # Where the bridge writes a retrieved-and-muxed clip before the backend
    # streams it to the kiosk. Short-lived, git-ignored, relative -> backend
    # working dir. This is the one place this feature writes decrypted media to
    # disk, however briefly (AGENTS.md -> "Eufy camera integration").
    eufy_clip_cache_dir: str = ".eufy_clip_cache"
    # How long a retrieved clip file is kept before it is eligible for cleanup.
    # Not a hard delete guarantee — a still-open kiosk playback is never
    # interrupted; this only bounds how long a *finished* clip lingers on disk.
    eufy_clip_cache_ttl_seconds: int = 600

    @field_validator(
        "eufy_clip_ring_buffer_size", "eufy_thumbnail_cache_size", "eufy_clip_cache_ttl_seconds"
    )
    @classmethod
    def _check_eufy_positive_ints(cls, value: int) -> int:
        if value <= 0:
            raise ValueError("must be a positive number")
        return value

    @field_validator("eufy_assumed_fps")
    @classmethod
    def _check_eufy_assumed_fps(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("eufy_assumed_fps must be positive")
        return value

    # -- Eufy bridge process (the Node sidecar this backend supervises) -----
    # `eufy_enabled` alone does not start anything with hardware/network
    # side effects until lifespan startup spawns this child process — mirrors
    # `host_local_camera` gating the webcam thread. Localhost only; never
    # exposed off-box.
    eufy_bridge_host: str = "127.0.0.1"
    eufy_bridge_port: int = 3011
    # The Node executable to spawn the bridge with. Override with an absolute
    # path if the host's system `node` is older than the bridge's Node >= 24.0.0
    # requirement (docs/eufy-sdk-integration.md open question #2 — the
    # verification spike used a portable Node 24 extraction, not a system install).
    eufy_bridge_node_path: str = "node"
    # Entry script, relative -> backend working dir (matches every other
    # relative path in this config).
    eufy_bridge_script: str = "../eufy-bridge/index.js"
    # Initial reconnect/respawn backoff if the bridge process exits or the
    # control socket drops; doubles on each consecutive failure, capped here —
    # same "exponential backoff, cap ~60s" rule as every other reconnect loop
    # in this backend.
    eufy_bridge_restart_backoff_seconds: float = 5.0
    eufy_bridge_restart_backoff_max_seconds: float = 60.0

    @field_validator("eufy_bridge_port")
    @classmethod
    def _check_eufy_bridge_port(cls, value: int) -> int:
        if not 1 <= value <= 65_535:
            raise ValueError("eufy_bridge_port must be a valid TCP port")
        return value

    @field_validator(
        "eufy_bridge_restart_backoff_seconds", "eufy_bridge_restart_backoff_max_seconds"
    )
    @classmethod
    def _check_eufy_backoff(cls, value: float) -> float:
        if value <= 0:
            raise ValueError("must be a positive number of seconds")
        return value

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
