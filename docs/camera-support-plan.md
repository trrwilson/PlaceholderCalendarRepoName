# Mission Control: Presence Detection and Future Person Recognition

Design, implement, and integrate local webcam-based presence detection for Mission Control.

This is a two-phase capability:

1. Phase 1, implement now: reliable local person/presence detection used for display wake/sleep behavior.
2. Phase 2, design for but do not implement now: optional local recognition of enrolled household members.

Do not make Phase 2 a dependency of Phase 1.

Before implementation, inspect the repository, existing architecture, configuration conventions, deployment documentation, and current likely host environment. The most likely host is Windows, but Linux remains possible. Do not assume a particular camera, detection framework, ML runtime, or display-power mechanism without verifying suitability.

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