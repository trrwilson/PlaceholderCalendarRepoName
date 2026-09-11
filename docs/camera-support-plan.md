---
status: future
summary: Local webcam presence detection - designed, not started. Its activity seam and detector output now target the general contract in presence-module-plan.md.
---

# Mission Control: Presence Detection and Future Person Recognition

Design, implement, and integrate local webcam-based presence detection for Mission Control.

**See [presence-module-plan.md](presence-module-plan.md) first.** It defines the
general `PresenceSignal` envelope and `PresenceAggregator` this plan's activity
seam and local-camera detector are the `kiosk`-scope implementation of. Nothing
below is superseded by it — the "Phase 1 build spec" section added below is the
concrete, actionable version of that contract for this plan's first
no-hardware build step.

This is a two-phase capability:

1. Phase 1, implement now: reliable local person/presence detection used for display wake/sleep behavior.
2. Phase 2, design for but do not implement now: optional local recognition of enrolled household members.

Do not make Phase 2 a dependency of Phase 1.

Before implementation, inspect the repository, existing architecture, configuration conventions, deployment documentation, and current likely host environment. The most likely host is Windows, but Linux remains possible. Do not assume a particular camera, detection framework, ML runtime, or display-power mechanism without verifying suitability.

---

## Status

**Planning. Architecture decisions locked in 2026-09-05; not yet implemented.** The
directive above and the requirement sections below ("Product requirements" onward) are the
original brief and remain the design target. The three sections immediately following this
one record the decisions taken and the feasibility review done on 2026-09-05, and take
precedence where they are more specific than the original brief.

## Decisions locked in (2026-09-05)

| Question | Decision |
| --- | --- |
| Production topology | A single Windows kiosk PC physically attached to the 27" Pisichen display, running both the browser frontend and the FastAPI backend locally. Network services may exist elsewhere later, but presence detection and display-power control must operate on this host. |
| Camera ownership | **Backend-owned.** Webcam acquisition and person detection run in the FastAPI process (hardware-dependent capability; only a local process can drive display power). React consumes semantic presence/diagnostic state and reports user activity — it never opens the camera. |
| Detector / model / cadence / capture backend | Not pre-decided. Research and verify against current dependencies; tune and measure on representative hardware. Software-code license *and* model-weight license both reviewed and documented before adoption; no silent auto-download of unreviewed weights. |
| Display power control | Actual physical monitor standby while the Windows host and local services keep running. **Do not assume DDC/CI.** Probe the real monitor + Windows environment, select the most reliable mechanism by evidence, keep it behind the `DisplayController` seam. A no-op controller is the dev/CI fallback. Never suspend/hibernate the host. |
| OS power-policy coordination | A documented kiosk deployment prerequisite (disable the Windows "turn off display" / sleep timers so the policy owns display power). Not solvable in code alone. |
| Settings persistence | Out of scope for Phase 1. Presence configuration stays environment / config-file based (`MISSION_CONTROL_PRESENCE_*`). The UI primarily exposes diagnostics. Shape the config accessor and the diagnostic/settings models so a runtime-writable store can shadow env later without a refactor. |
| User-activity seam | A small provider-neutral seam so touch, active voice interaction, future wake-word activation, and camera presence all feed the inactivity policy without those subsystems depending on one another. |
| Single-process hardware ownership | The camera is opened once, in backend lifespan startup, only when presence is enabled. Guard with a named mutex / lockfile so `--reload` or an accidental second worker logs and backs off instead of competing for the device. Presence loop defaults off in dev; production runs a single worker. |
| Durable docs | Architectural + ML/model-licensing guidance goes in `AGENTS.md` (`.github/copilot-instructions.md` stays a thin pointer). Licenses / provenance for ML code and model weights documented independently in a new project-level dependency/licensing document. |

## Feasibility assessment (2026-09-05)

Phase 1 is feasible and can largely be built and CI-tested without hardware; the remaining
unknowns are empirical and belong on the real kiosk.

- **Backend capture + detection.** A lifespan-started worker *thread* (OpenCV
  `VideoCapture.read()` blocks; native calls release the GIL, so ~1–2 fps alongside
  request handling is negligible). Settle during a spike: MSMF vs DSHOW capture backend;
  device selection by name/path rather than index; reopen-with-backoff on disconnect
  (`read()` returns `False`, it does not raise) with the "camera lost" state surfaced in
  diagnostics and failing safe (hold display awake). `opencv-python` / `onnxruntime` /
  `mediapipe` all ship cp312 Windows wheels today; `mediapipe` currently caps near 3.12.
- **Monitor standby — the main empirical unknown.** Windows options, preferred order
  where supported:
  - `SendMessageW(HWND_BROADCAST, WM_SYSCOMMAND, SC_MONITORPOWER, 2)` — real DPMS
    standby, system-wide (fine for one display). Works from a normal-user process in the
    interactive session; a session-0 service cannot do this, so the backend must run in
    the kiosk user's session. Wake with `SC_MONITORPOWER, -1` or a synthetic `SendInput`.
  - DDC/CI VCP `0xD6` via `dxva2.dll` (`GetPhysicalMonitorsFromHMONITOR` →
    `SetVCPFeature`) — better wake behaviour where it works, but off-brand 4K panels are
    unreliable and capability strings can be absent or inaccurate. Probe at startup,
    verify it changes panel state, fall back to `SC_MONITORPOWER`.
  - Rejected: brightness-to-zero (backlight stays on), `SetDisplayConfig` detach
    (disruptive window reflow), HDMI-CEC (not on PC GPUs).
  `DisplayController.probe()` records which mechanism is live for diagnostics; the
  controller stays dumb (`wake()` / `sleep()` / `status()`) and "don't re-issue identical
  commands" lives in the policy.
- **Activity seam.** The policy consumes two signal kinds: `note_activity(source, at)`
  discrete pulses (`TOUCH` / `VOICE` / `WAKE_WORD` / `CAMERA`, extensible) and
  `set_presence(state, at)` from the detector. Touch/voice reach it via a new
  `POST /api/presence/activity`; the detector calls in-process; a future wake-word
  detector needs no change elsewhere. `CAMERA PRESENT` holds the display awake;
  `CAMERA ABSENT` starts the inactivity clock; a touch/voice pulse pushes the clock
  forward even while the camera reports absent (someone sitting still). These are
  the `kiosk`-scope `activity` and `presence` signal kinds in
  [presence-module-plan.md](presence-module-plan.md) — `note_activity` /
  `set_presence` are this plan's names for calls into that doc's
  `PresenceAggregator.observe()`; see this doc's "Phase 1 build spec" for the
  concrete mapping.
- **Config + diagnostics.** `MISSION_CONTROL_PRESENCE_*` env vars via a dedicated
  `PresenceSettings` model read through an accessor (the future-store hook).
  `GET /api/presence` returns effective config + live state (presence, camera status,
  detector availability, display mechanism + availability, last-activity-per-source,
  current display state); the frontend polls it like `/api/calendar/auth` and shows a
  read-only Settings section.
- **Testing.** The policy is a pure state machine with an injected `now` callable (house
  style — cf. `MockCalendarProvider`'s injected `today`; no new `freezegun` dependency).
  Camera and `DisplayController` are fakes. "Diagnostic mode" = real detector + no-op
  controller + verbose `/api/presence`, which is also the CI configuration. The presence
  loop must never auto-start under pytest.
- **Licensing.** Prefer Apache/BSD/MIT for code *and* weights (MediaPipe Tasks, OpenVINO
  `person-detection-*`, YOLOX, NanoDet, or OpenCV's bundled HOG — BSD, no download,
  weaker accuracy). Avoid Ultralytics YOLO (AGPL, code and weights). Vendor or
  checksum-pin weights — several candidate libraries auto-download on first use.

## Open items requiring representative hardware

None block starting (activity seam + no-op controller + config + policy + tests land
first). These gate completion:

1. **Monitor control mechanism** — probe + validate on the Pisichen panel and the kiosk
   GPU/driver: does an off→on cycle reliably re-light the panel and how fast; does
   DDC/CI `0xD6` work at all.
2. **Touchscreen digitizer spurious wake** — if the panel wakes on HID jitter from the
   digitizer, "sleep after sustained absence" may never hold.
3. **Webcam** — model, UVC compliance, native resolution, FOV, mounting height/angle,
   low-light behaviour: detector cadence / confidence / minimum bounding-box size cannot
   be tuned without it.
4. **Kiosk PC specs** — CPU class, RAM, usable iGPU (DirectML / OpenVINO): determines
   detector choice and lets "representative resource usage" actually be measured.

Still to pin down (no hardware needed):

- Whether the backend also asserts `SetThreadExecutionState(ES_CONTINUOUS |
  ES_SYSTEM_REQUIRED)` as defence-in-depth on top of the documented power-plan config
  (recommend both).
- Which `useVoiceSession` states count as "active voice interaction" (likely
  `listening` / `thinking` / `speaking`).
- Activity-report transport and throttle (recommend a plain `POST`, ~1 ping / 10 s plus
  a periodic heartbeat; not the WebSocket, which has no reconnect today).
- Where a vendored model lives in the repo (committed small ONNX / Git LFS / checksummed
  fetch) for offline CI.
- Whether presence detection needs a visible "camera active" indicator (voice set the
  precedent with the "Mic on" pill).
- Phase 1 has no explicit manual override ("sleep now" / "stay awake"); the policy seam
  should accept an injected override later.

## Recommended implementation order

1. Detector abstraction + inactivity policy + activity seam + unit tests (no hardware).
2. `PresenceSettings` config + `GET /api/presence` + frontend diagnostics section and
   activity reporting.
3. `DisplayController` with the no-op default + a `SC_MONITORPOWER` implementation behind
   a startup probe.
4. Camera capture + detector, behind `MISSION_CONTROL_PRESENCE_ENABLED=false` by default.
5. On the kiosk: probe DDC/CI, tune the detector, measure resource use, validate wake /
   digitizer behaviour, write the deployment prerequisites.

## Phase 1 build spec: steps 1–2 (no hardware)

Concrete enough to start coding against — covers implementation-order steps 1 and
2 above. Steps 3–5 (`DisplayController` hardware, camera capture, on-kiosk tuning)
stay as described elsewhere in this document; nothing here changes them.

**Module layout**

```
backend/app/
  models.py            # + PresenceSignal, PresenceSignalKind, PresenceScope
                        #   (presence-module-plan.md), + PresenceSettings-shaped
                        #   config model, + the API response models below
  config.py             # + the MISSION_CONTROL_PRESENCE_* fields (table below)
  presence/
    __init__.py          # get_presence_aggregator() singleton, guarded by
                          #   presence_enabled (lazy import — disabled path never
                          #   imports the detector)
    aggregator.py         # PresenceAggregator (presence-module-plan.md); this
                          #   plan constructs exactly one scope, kiosk, for now
    detector.py            # PresenceDetector protocol + a FakeDetector for tests;
                          #   the real OpenCV/ONNX implementation is step 4
  api.py                # + POST /api/presence/activity, GET /api/presence
```

**Domain models** (`app/models.py`), on top of `presence-module-plan.md`'s
`PresenceSignal` / `PresenceSignalKind` / `PresenceScope`:

```python
class ActivitySource(StrEnum):
    touch = "touch"
    voice = "voice"
    wake_word = "wake_word"
    timer = "timer"


class PresenceSettings(BaseModel):
    enabled: bool
    inactivity_timeout_seconds: int
    confidence_threshold: float
    inference_interval_ms: int
    camera_device: str | None


class PresenceDiagnostics(BaseModel):
    """GET /api/presence response."""
    settings: PresenceSettings
    kiosk_state: PresenceState            # from presence-module-plan.md
    detector_available: bool
    camera_status: Literal["ok", "absent", "disconnected", "error", "disabled"]
    display_mechanism_available: bool     # placeholder until step 3 lands; False until then
```

**Config** (`app/config.py`, all `MISSION_CONTROL_`-prefixed, read through an
accessor so a future runtime store can shadow env without a refactor — same
posture as `display_dim_*`):

| Setting | Default | Purpose |
| --- | --- | --- |
| `presence_enabled` | `false` | Master flag. False ⇒ `app/presence/` never imported, `/api/presence` 409s like `/api/voice/token` when its feature is off. |
| `presence_inactivity_timeout_seconds` | `900` (15 min) | Sustained `CAMERA ABSENT` (or, before step 4 ships, no activity pulse) before the kiosk scope flips to not-present. |
| `presence_confidence_threshold` | `0.6` | Detector confidence floor for a positive person detection. Unused until step 4; accepted and validated now so the config shape doesn't change later. |
| `presence_inference_interval_ms` | `750` | Detector cadence. Same status as above. |
| `presence_camera_device` | `None` | Device name/path override; `None` = auto-select. Same status as above. |

**Detector abstraction** (`app/presence/detector.py`) — the seam step 4's real
implementation fills in; step 1 only needs the protocol and a fake:

```python
class DetectionResult(BaseModel):
    present: bool
    confidence: float | None = None

class PresenceDetector(Protocol):
    def open(self) -> None: ...
    def read(self) -> DetectionResult | None: ...   # None = frame unavailable / camera lost
    def close(self) -> None: ...

class FakeDetector:
    """Test double: a scripted sequence of DetectionResult | None, consumed by read()."""
```

**Policy / aggregator wiring** (`app/presence/aggregator.py`, implementing
`PresenceAggregator` from `presence-module-plan.md` with one scope):

```python
_KIOSK = PresenceScope(kind="kiosk", id="kiosk")

def note_activity(source: ActivitySource, at: datetime) -> None:
    """Touch/voice/wake-word/timer pulse. Calls observe() with kind=activity."""

def set_presence(present: bool, at: datetime, *, confidence: float | None = None) -> None:
    """Detector output. Calls observe() with kind=presence, scope=kiosk."""
```

Hysteresis rule for step 1 (detector not wired yet, so exercised only through
`FakeDetector` in tests): a single `present=False` observation does not clear
`kiosk_state.present`; it must stay false for `inactivity_timeout_seconds`
before the state flips. Any `activity` pulse or a `present=True` observation
clears it immediately. Never fire `on_change` twice for the same resulting
state (the aggregator-level rule from `presence-module-plan.md`).

**API** (`app/api.py`):

- `POST /api/presence/activity` — body `{"source": ActivitySource}` → `204`.
  `_require_local()`. **Not** `_require_unlocked()` — activity must register
  while privacy-locked (documented DoD exception, same one
  `display-dimming-plan.md` carves out for its identical endpoint; whichever
  plan lands this endpoint first, the other reuses it unchanged).
- `GET /api/presence` — `PresenceDiagnostics` (above). No gating (read-only,
  matches `/api/display`, `/api/capabilities`). Returns `409` when
  `presence_enabled` is `false`.

**Tests** (pytest, no camera, no display hardware — mirrors the `Testing`
section below, scoped to what step 1–2 can actually exercise):

- `note_activity` clears an absent state immediately; a lone `set_presence(False)`
  does not.
- Sustained `set_presence(False)` past `inactivity_timeout_seconds` (via the
  injected clock) flips `kiosk_state.present`; a `set_presence(True)` or any
  activity pulse before the timeout cancels it.
- `on_change` fires once per actual transition, never on a repeated identical
  observation.
- `presence_enabled=false` ⇒ `get_presence_aggregator()` is never constructed,
  `GET /api/presence` returns `409`, `POST /api/presence/activity` still 204s
  harmlessly (matches "activity must register regardless" — cheap to always
  accept, expensive only to act on).
- `POST /api/presence/activity` is `_require_local`-gated and **not** blocked
  by privacy lock.
- `FakeDetector` sequences (`present → present → None → absent → present`)
  drive the policy through gaps/misses without special-casing `None`
  (treated as "no observation this tick," not as absence).

---

## Product requirements

Mission Control is a continuously running household appliance on a wall-mounted touchscreen with an attached webcam.

Desired behavior:

- Wake the physical display promptly when a person is detected.
- Allow the display to sleep after sustained absence.
- Keep the Mission Control host, backend, calendar synchronization, local wake-word processing, and other services running while the display itself sleeps.
- Avoid rapid sleep/wake cycling caused by occasional missed detections.
- Touch and active voice interaction count as activity and must prevent inappropriate display sleep.
- Failure of camera detection must fail safe: prefer leaving the display awake rather than making Mission Control inaccessible.
- Camera/video processing is local by default. Do not upload camera frames to Gemini or another cloud service as part of this feature.
- Do not record or persist camera video or images as part of normal presence detection.

## Phase 1: Presence Detection

Implement only enough visual understanding to answer the semantic question:

`Is a person currently present?`

Do not perform identity recognition in Phase 1.

### Presence state

Establish a small provider-neutral semantic model such as:

- ABSENT
- PRESENT

Do not expose raw camera frames outside the vision/presence subsystem.

Design the state model so that a future recognition layer can add information such as:

- recognized household profile(s)
- unknown person
- recognition confidence

without changing the meaning or reliability requirements of basic presence detection.

Presence must continue to work even if future recognition cannot identify the person.

### Camera and detector

Investigate and corroborate a suitable local implementation for the actual deployment environment.

Possible technologies may include OpenCV, ONNX Runtime, lightweight person-detection models, platform camera APIs, or other established local approaches. These are candidates, not requirements.

Select an approach based on:

- Windows compatibility first, if confirmed as the target deployment environment
- Linux portability where practical
- reliable human/person detection
- webcam compatibility
- continuously-running CPU/memory cost
- dependency maturity and maintenance
- licensing
- ability to run entirely locally
- reasonable future path toward face detection/recognition

Prefer modest camera resolution and inference cadence suitable for presence detection rather than continuously processing full-resolution/high-frame-rate webcam video.

Measure representative resource usage.

### Presence policy

Use hysteresis/debouncing rather than mapping individual inference results directly to display state.

Expected behavior:

- Positive person detection should wake promptly.
- A single missed detection must not sleep the display.
- Display sleep should require continuous absence for a configurable inactivity period.
- Reappearance after sleep should wake promptly.
- Touch interaction resets inactivity.
- Active voice interaction resets inactivity.
- **An active timer is a keep-awake vote.** While a timer is `running` or `fired`
  (the kiosk exposes these as `hasActiveTimer` / `alarm` from `useTimers()`, and a
  best-effort `navigator.wakeLock('screen')` is already held), the inactivity
  policy must treat it as equal in weight to touch and active voice. When the
  policy would otherwise sleep the display and a timer is active, it must instead
  switch the view to the Timer tab and keep the panel powered rather than issue
  the sleep command; on `fired` it must wake the display if asleep. This is the
  same "Timer is the *ambient* default while active" rule the app already applies
  on its own (start / fire / cold boot) — an automatic actor lands on the Timer
  view; it does **not** lock out explicit touch navigation. See
  `docs/timer-plan.md` → "Physical display stays awake" / "Default view while a
  timer is active".
- Do not repeatedly issue identical display-power commands.

Configuration should include reasonable controls for:

- feature enabled/disabled
- camera/device selection where needed
- inactivity timeout
- detector confidence threshold where relevant
- detection/inference cadence where useful

Use sensible defaults.

## Display Power Control

Research and verify how to turn off or place only the attached display into standby while leaving the Mission Control host operational.

The most likely host is Windows, but do not prematurely bind the architecture to Windows.

Potential mechanisms include operating-system display-power facilities, monitor protocols such as DDC/CI, or other appropriate mechanisms. Treat these as options to investigate, not predetermined solutions.

Keep physical display control behind a narrow interface so the implementation can be changed for different hardware or operating systems.

Do NOT implement system suspend, sleep, or hibernate as a substitute for monitor power management.

Provide safe development/no-op behavior when physical display control is unavailable.

## Phase 2: Local Household Person Recognition

DO NOT implement this phase as part of the current task.

Phase 1 architecture must, however, avoid decisions that make it unnecessarily difficult.

The future goal is to optionally associate locally observed people with Mission Control household profiles, for example:

- Alex
- Jordan
- Unknown

Potential future semantics might resemble:

Presence:
    present: true

Recognized people:
    - profileId: alex
      confidence: ...

Recognition is contextual information, not proof of identity and not an authorization mechanism.

An unknown/unrecognized person is a normal state.

Potential future experiences include:

- emphasizing the recognized person's calendar
- interpreting "my calendar" with person context when confidence is sufficient
- adapting ambient schedule emphasis
- showing information relevant to multiple recognized people

Presence detection must remain independent and more tolerant than identity recognition. A person who cannot be recognized due to distance, angle, lighting, occlusion, or model uncertainty should still keep/wake the display.

### Future recognition technology

When Phase 2 is eventually implemented, evaluate local face detection, embedding generation, and enrolled-profile matching.

Potential technologies may include InsightFace/ONNX Runtime or other local alternatives. Do not commit the architecture to one implementation now.

Enrollment could eventually associate locally generated face embeddings with an existing Mission Control household profile.

Do not add enrollment UI, face databases, recognition dependencies, or model downloads in Phase 1.

## Licensing and Dependency Provenance

Treat licensing as a design requirement for both phases even though Mission Control currently has no planned commercial use.

When selecting computer-vision libraries, ML runtimes, pretrained models, datasets, or model weights:

1. Verify the license of the software code.
2. Separately verify the license of pretrained model weights and training-derived artifacts.
3. Do not assume a library's source-code license also applies to downloaded model weights.
4. Record relevant license/provenance information in an appropriate project-level dependency or licensing document.
5. Update README/project documentation where necessary.
6. Update `.github/copilot-instructions.md` with a durable requirement that future ML/vision dependencies must have both code and model licensing reviewed and documented before adoption.
7. Avoid silently auto-downloading models whose licensing/provenance has not been reviewed.
8. Prefer dependencies/model assets with terms compatible with both current personal use and reasonably foreseeable future use where practical.

If a candidate has different commercial and non-commercial terms, document that explicitly rather than rejecting it automatically.

For example, InsightFace may be evaluated in the future, but its software and supplied pretrained models have different licensing terms; verify the then-current terms before adoption.

## Architecture

Keep these concerns conceptually separate without over-engineering:

Camera acquisition
    ↓
Person/presence detection
    ↓
Presence policy / inactivity state
    ↓
Display power control

Future:

Camera acquisition
    ├── Person/presence detection ──→ display policy
    └── Face detection/recognition ──→ household profile context

Other Mission Control components should consume semantic states rather than camera frames or detector-specific objects.

Do not create a large pluggable framework merely to support hypothetical future detectors. A small clean boundary is sufficient.

## Mission Control Integration

Keep UI changes minimal.

Add presence settings/diagnostics in the existing appropriate Settings surface rather than reserving permanent dashboard space.

Useful diagnostics may include:

- Presence enabled/disabled
- Current semantic presence state
- Camera status
- Detector availability
- Display-control availability
- Inactivity timeout
- Optional developer-oriented detector confidence/timing information

Do not display camera imagery in the normal appliance UI.

## Reliability

Explicitly handle:

- webcam absent
- webcam disconnected/reconnected
- camera temporarily unavailable
- detector initialization failure
- inference failure
- display-control mechanism unavailable
- application/backend restart
- repeated identical detector state
- intermittent missed detections

Presence subsystem failure must not leave the display permanently dark.

## Testing

Add automated tests around the platform-independent policy:

- positive person detection wakes display
- isolated missed detection does not cause sleep
- sustained absence exceeding configured timeout sleeps display
- renewed presence wakes display
- touch activity resets/prevents sleep
- active voice interaction resets/prevents sleep
- unavailable detector fails safe
- display-control failure fails safe
- repeated state observations do not issue redundant power commands

Keep camera and display-control implementations replaceable/testable with fakes.

Provide a diagnostic mode that exercises presence detection without actually sleeping the developer's monitor.

## Manual Validation

If suitable camera hardware is available, validate:

1. Person directly in front of display is detected.
2. Person entering from representative room positions is detected.
3. Brief detector misses do not sleep display.
4. Sustained absence eventually sleeps display.
5. Re-entry wakes display promptly.
6. Ordinary environmental motion is not commonly classified as a person.
7. Mission Control services continue running while display is asleep.
8. Touch/voice activity prevents inappropriate sleep.
9. Approximate continuous CPU and memory usage are measured.

## Execution

Work autonomously:

1. Inspect current repository and deployment assumptions.
2. Research and corroborate appropriate implementation choices for the actual host environment.
3. Document the technical choice and important alternatives considered.
4. Update `AGENTS.md` with the durable licensing/provenance requirement and the separation between presence detection and optional future recognition.
5. Update appropriate project-level dependency/licensing documentation.
6. Implement Phase 1 only.
7. Add configuration and minimal Settings/diagnostic UX.
8. Add automated tests.
9. Run existing backend/frontend tests, type checks, linting, and relevant integration tests.
10. Measure representative resource consumption if hardware/environment allows.
11. Document Windows/Linux/hardware assumptions and limitations.

Do not implement Phase 2 facial/person recognition in this task.

Do not ask for intermediate approval unless blocked by genuinely missing hardware/environment information.

At completion report:

- selected camera/person-detection approach and why
- selected display-power approach and why
- important platform assumptions
- measured resource usage if available
- tests/validation performed
- licensing/provenance documentation added
- explicit recommendations for a later Phase 2 recognition implementation