from datetime import date, datetime, timedelta
from enum import StrEnum
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field, model_validator

# The product ceiling for a timer / alarm lookahead. Enforced by the model
# validator here (source of truth), by the voice tool-argument check, and by the
# touch dial. Overridable via ``MISSION_CONTROL_TIMER_MAX_SECONDS`` but documented
# as the ceiling.
TIMER_MAX_SECONDS = 21_600  # six hours
# Guard against a 0 / near-0 timer; storage resolution is one second.
TIMER_MIN_SECONDS = 5


class CalendarColor(StrEnum):
    coral = "coral"
    ocean = "ocean"
    gold = "gold"
    fern = "fern"
    violet = "violet"


class CalendarSource(StrEnum):
    """Which kind of account a household calendar comes from.

    Drives the small provider badge the kiosk shows next to a person's name
    (e.g. an Outlook mark after "Travis"). ``mock`` renders no badge.
    """

    mock = "mock"
    outlook = "outlook"
    google = "google"


class HouseholdCalendar(BaseModel):
    id: str = Field(min_length=1)
    # The raw account name — an email local-part, a UPN prefix, or a mock label.
    # Kept as a stable identifier and the last-resort display fallback.
    name: str = Field(min_length=1)
    # A natural personal name for the account holder, resolved by the provider
    # (given/first name > full name > ``name``). This is what people-facing
    # surfaces show and what the voice assistant speaks. Defaults to ``name``
    # when the provider cannot resolve anything better.
    display_name: str = ""
    color: CalendarColor
    source: CalendarSource = CalendarSource.mock
    enabled: bool = True

    @model_validator(mode="after")
    def _fill_display_name(self) -> "HouseholdCalendar":
        if not self.display_name:
            self.display_name = self.name
        return self


class EventCategory(BaseModel):
    id: str = Field(min_length=1)
    name: str = Field(min_length=1)
    # The category's display colour, resolved from the provider (e.g. an Outlook
    # master-category swatch) to a concrete ``#rrggbb`` the frontend renders
    # directly. Names stay authoritative; unknown colours degrade to a neutral hex.
    color: str = Field(pattern=r"^#[0-9a-fA-F]{6}$")


class CalendarEvent(BaseModel):
    model_config = ConfigDict(frozen=True)

    id: str = Field(min_length=1)
    calendar_id: str = Field(min_length=1)
    title: str = Field(min_length=1)
    starts_at: datetime
    ends_at: datetime
    location: str | None = None
    all_day: bool = False
    categories: list[EventCategory] = Field(default_factory=list)

    @model_validator(mode="after")
    def end_follows_start(self) -> "CalendarEvent":
        if self.ends_at <= self.starts_at:
            raise ValueError("ends_at must be after starts_at")
        if self.all_day and (
            self.starts_at.time() != datetime.min.time()
            or self.ends_at.time() != datetime.min.time()
        ):
            raise ValueError("all-day events must use midnight boundaries")
        return self


class CalendarRange(BaseModel):
    starts_on: date
    ends_on: date

    @model_validator(mode="after")
    def end_follows_start(self) -> "CalendarRange":
        if self.ends_on < self.starts_on:
            raise ValueError("ends_on must not precede starts_on")
        return self


class CalendarSnapshot(BaseModel):
    calendars: list[HouseholdCalendar]
    events: list[CalendarEvent]
    range: CalendarRange


class TimerState(StrEnum):
    running = "running"
    paused = "paused"
    fired = "fired"
    dismissed = "dismissed"


class Timer(BaseModel):
    """A single countdown timer.

    A timer is a *duration* counting down to an absolute ``fires_at`` (naive local
    time, per ``AGENTS.md``). ``duration_seconds`` is redundant with
    ``fires_at - created_at`` but is stored so the UI can render "45:00 timer"
    without recomputing.

    The store — not the model — enforces the single-active-timer rule.
    """

    id: str = Field(min_length=1)
    label: str | None = None
    created_at: datetime
    fires_at: datetime
    duration_seconds: int = Field(ge=TIMER_MIN_SECONDS, le=TIMER_MAX_SECONDS)
    state: TimerState = TimerState.running
    # Frozen countdown carried only while ``state`` is ``paused``: the seconds
    # that were left when the timer was paused. ``fires_at`` is stale in that
    # state (it is not counting down) — surfaces read this instead. ``None`` for
    # every other state.
    remaining_seconds: int | None = Field(default=None, ge=0, le=TIMER_MAX_SECONDS)

    @model_validator(mode="after")
    def _consistent(self) -> "Timer":
        if self.fires_at <= self.created_at:
            raise ValueError("fires_at must be after created_at")
        expected = self.created_at + timedelta(seconds=self.duration_seconds)
        # Tolerate sub-second drift from serialisation rounding.
        if abs((self.fires_at - expected).total_seconds()) > 1:
            raise ValueError("fires_at must equal created_at + duration_seconds")
        if self.state is TimerState.paused and self.remaining_seconds is None:
            raise ValueError("a paused timer must carry remaining_seconds")
        return self


class TimerCreateRequest(BaseModel):
    duration_seconds: int = Field(ge=TIMER_MIN_SECONDS, le=TIMER_MAX_SECONDS)
    label: str | None = None


class TimerExtendRequest(BaseModel):
    add_seconds: int = Field(gt=0, le=TIMER_MAX_SECONDS)


class TimerMutationResult(BaseModel):
    """Returned by ``POST /api/timers`` and carried on the broadcast so every
    surface can say what (if anything) the new timer replaced."""

    timer: Timer
    replaced: Timer | None = None


class ApplicationMessage(BaseModel):
    type: str
    message: str
    snapshot: CalendarSnapshot | None = None
    # Timer pushes reuse this envelope (see docs/timer-plan.md, open question O6):
    # ``timers`` is the full current list for reconciliation, ``timer`` is the one
    # that just changed, ``replaced`` names a silently-replaced timer.
    timers: list[Timer] | None = None
    timer: Timer | None = None
    replaced: Timer | None = None


class VoiceTokenRequest(BaseModel):
    """Optional hints from the kiosk when it asks for a voice token.

    ``surface`` identifies the requesting screen. It is unused today (one kiosk),
    but is accepted now so a future multi-screen setup can route a spoken command
    to a specific display without an API change.

    The backend may run in UTC, so the assistant's "today" is stamped from the
    kiosk's own clock: ``client_time`` is the local wall-clock time as an ISO
    string without offset (e.g. ``2026-09-05T23:30:00``) and ``timezone`` is the
    IANA name (e.g. ``America/Los_Angeles``) used only as a label.
    """

    surface: str | None = None
    timezone: str | None = None
    client_time: str | None = None


# Who detects end-of-speech for a turn, and therefore how the shared kiosk turn
# state machine behaves. Negotiated per provider on the grant; see
# ``docs/voice-provider-bakeoff-plan.md`` -> "End-of-speech ownership".
#
# * ``client``   — the provider has no usable end-of-speech detection (or the
#   operator switched it off). The kiosk's own mic-RMS silence detector, the
#   ``MAX_LISTEN_MS`` cap, and the explicit Stop tap are the whole endpointer,
#   and the kiosk brackets the turn with explicit activity markers. The default,
#   applied whenever a provider declares nothing suitable.
# * ``hybrid``   — the provider runs a VAD (for streaming ASR, or because its
#   echo canceller requires one) and emits ``speech-started`` / ``speech-stopped``
#   but does not create the response. The kiosk takes ``speech-stopped`` as the
#   primary end-of-speech signal, keeps the mic-RMS detector as a longer-hold
#   backstop, and still sends a finalise marker so the reply is requested
#   deterministically.
# * ``provider`` — the provider fully owns end-of-speech *and* response
#   triggering (its VAD with ``create_response`` on). The kiosk runs no mic-RMS
#   endpointing (only the safety cap + Stop tap) and sends no finalise marker.
#   A declared seam; no current contestant uses it.
Endpointing = Literal["client", "hybrid", "provider"]


VoiceProviderId = Literal[
    "gemini",
    "azure_voice_live",
    "azure_openai_realtime",
    "azure_openai_realtime_mini",
    # The local-first / hybrid pipeline: on-device STT + intent/entity
    # interpretation, cloud only for genuine reasoning. See
    # app/voice/local/ and docs/local-voice-plan.md.
    "local",
]


class VoiceToken(BaseModel):
    """A short-lived, constrained session grant for the kiosk browser.

    For ``gemini`` (today the only implemented provider) this carries a Gemini
    Live ephemeral token; the browser opens the Live session directly with it and
    the Gemini API key stays on the backend. ``expires_at`` is when a session
    must have *started* by. As the bake-off adds providers whose grants look
    different (an Azure ephemeral key + endpoint, or a relay ticket), this model
    grows provider-specific blocks; ``provider`` says which one applies.
    """

    provider: VoiceProviderId = "gemini"
    token: str
    expires_at: datetime
    model: str
    # The API version the token was minted with. The browser must open its Live
    # connection on the same version, so it is told rather than left to guess —
    # a silent mismatch here is what produced `code 1008 "... not found for API
    # version ..."` during the 2026-09 debugging.
    api_version: str = "v1beta"
    # Who detects end-of-speech for a turn (see ``Endpointing``). ``client`` (the
    # default) means the kiosk disables the provider VAD and brackets the turn
    # itself; ``hybrid`` means the provider VAD runs and the kiosk endpoints on
    # its ``speech-stopped`` with a mic-RMS backstop; ``provider`` means the
    # provider owns the whole boundary. Replaces the old ``manual_activity`` bool.
    endpointing: Endpointing = "client"
    surface: str | None = None


class VoiceProviderInfo(BaseModel):
    """One conversational voice provider, for the Settings picker."""

    id: VoiceProviderId
    label: str
    implemented: bool
    configured: bool


class VoiceConfig(BaseModel):
    """Which conversational voice provider the kiosk is using, and which others it
    could switch to. Served by ``GET /api/voice/config``; ``PUT`` swaps the
    effective provider for the bake-off (process-memory, reverts on restart).
    """

    enabled: bool
    provider: VoiceProviderId
    providers: list[VoiceProviderInfo]
    # Amplitude gain (dB) the kiosk applies to captured microphone audio before
    # wake-word detection and before streaming to the provider; 0 disables it.
    # A property of the shared browser capture pipeline, not of any one provider,
    # delivered here because this endpoint is always safe to call. See
    # ``Settings.mic_input_gain_db``.
    mic_input_gain_db: float


class VoiceConfigUpdate(BaseModel):
    """``PUT /api/voice/config`` body."""

    provider: VoiceProviderId


class WakeWordConfig(BaseModel):
    """Runtime configuration for the kiosk's local wake-word detector.

    Served by ``GET /api/voice/wake-config`` (LAN-gated). All detection runs in
    the browser against a local model; this only carries thresholds and where
    the model assets are served from. ``enabled`` is true only when both
    ``MISSION_CONTROL_WAKE_WORD_ENABLED`` and ``MISSION_CONTROL_VOICE_ENABLED``
    are set — wake word with no voice turn to open would do nothing.
    """

    enabled: bool
    phrase: str
    threshold: float
    cooldown_ms: int
    model_path: str
    models_base_url: str


class VoiceDebugCapture(BaseModel):
    """One retained voice activation, uploaded by the kiosk for on-disk debugging
    (``POST /api/voice/debug/capture``, LAN-gated).

    ``wav_base64`` is a complete headered RIFF/PCM16 mono WAV — the exact audio
    the kiosk streamed to the speech provider for the turn (the pre-roll for a
    wake activation, then the live mic; from the first mic chunk for
    push-to-talk). The backend writes it verbatim with a ``.json`` sidecar of the
    remaining fields; it never reaches a provider.
    """

    wav_base64: str
    sample_rate: int
    started_at: datetime | None = None
    provider: str | None = None
    model: str | None = None
    via_wake: bool = False
    preroll_chunks: int = 0
    mic_chunks: int = 0
    seconds: float = 0.0
    outcome: str | None = None
    failure_kind: str | None = None
    transcript: dict[str, str] | None = None


class VoiceDebugCaptureStored(BaseModel):
    """Where ``POST /api/voice/debug/capture`` wrote the WAV."""

    path: str


class CalendarAuthStatus(BaseModel):
    """State of the calendar provider's sign-in, for the kiosk connect UI."""

    provider: str
    state: Literal["connected", "connecting", "disconnected", "not_applicable"]
    account: str | None = None
    # All household accounts currently available to the personal provider.  ``account``
    # remains the first entry for clients that predate multi-account support.
    accounts: list[str] = Field(default_factory=list)
    # Present while state == "connecting": show these so a phone can finish sign-in.
    user_code: str | None = None
    verification_uri: str | None = None
    verification_uri_complete: str | None = None
    verification_qr: str | None = None  # data: URI for an SVG QR code
    expires_in: int | None = None
    error: str | None = None
