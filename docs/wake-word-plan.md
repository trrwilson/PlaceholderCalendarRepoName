# Mission Control: Local Wake-Word Activation

Design, implement, and integrate local wake-word activation for Mission Control.

The wake phrase is:

> "Mission Control"

Mission Control already has a functional tap/push-to-talk voice path using the browser microphone and Gemini Live. Wake-word activation should build on that existing voice architecture rather than replace or duplicate it unnecessarily.

The primary deployment host is likely Windows, but Linux remains possible. Do not assume a specific wake-word engine, microphone architecture, or OS integration before inspecting the repository and corroborating current options.

---

## Product Goal

Allow a person near the wall-mounted Mission Control display to say:

> "Mission Control"

and naturally begin a voice interaction without touching the screen.

Desired experience:

1. Mission Control waits locally for the wake phrase.
2. Saying "Mission Control" activates promptly.
3. The UI immediately and visibly acknowledges activation.
4. Speech following the wake phrase becomes the existing Mission Control voice turn.
5. Gemini handles the utterance through the existing voice/tool architecture.
6. Mission Control presents the result visually and, when appropriate, through existing assistant audio.
7. After the interaction completes or times out, Mission Control returns to local wake-word listening.

The normal idle wake-word path should not continuously stream room audio to Gemini or another cloud service.

Preserve push-to-talk as a fully supported fallback and diagnostic path.

---

# Core Principles

## 1. Wake-word detection is local activation, not conversational AI

Keep these responsibilities conceptually distinct:

Local audio
    ↓
Wake-word detector
    ↓ "Mission Control"
Voice-session activation
    ↓
Existing Gemini voice session
    ↓
Mission Control tools / UI / calendar / Home Assistant

The wake-word system answers only:

> "Should Mission Control begin listening to this person now?"

Gemini answers:

> "What did the person ask, and what should Mission Control do?"

Do not send continuous ambient audio to Gemini merely to recognize the wake phrase.

## 2. Preserve the existing voice architecture

Inspect the existing:
- microphone capture
- Gemini Live session
- audio playback
- voice state machine
- tool dispatch
- transcript UI
- push-to-talk controls

Reuse these paths where practical.

Do not create a parallel implementation of:
- Gemini sessions
- tool calling
- transcription
- assistant audio
- dashboard actions

Wake-word activation should enter the same logical interaction flow as manual activation.

## 3. Push-to-talk remains first-class

The existing Ask / microphone control must continue to work independently of wake-word detection.

This provides:
- accessibility
- fallback when wake detection fails
- debugging
- recovery when microphone conditions are poor
- a deterministic way to distinguish wake-word problems from Gemini problems

---

# Investigation Before Implementation

Inspect the repository and current runtime environment first.

Research and corroborate appropriate current wake-word implementations for:
- Windows
- local CPU inference
- custom phrase "Mission Control"
- continuously running operation
- Python and/or browser integration
- microphone compatibility
- resource consumption
- false-positive tuning
- custom-model training
- licensing

Possible candidates include:
- openWakeWord
- Picovoice Porcupine
- other actively maintained local keyword-spotting implementations

These are candidates, not mandated choices.

Prefer:
- local inference
- mature maintained implementation
- modest continuous CPU use
- good Windows support
- customizable detection threshold
- ability to own/control the "Mission Control" wake phrase
- clear licensing for runtime AND trained model assets

Document why the selected approach was chosen.

---

# Critical Architecture Decision: Microphone Ownership

Explicitly investigate how wake-word detection should coexist with the existing browser microphone capture.

Do not assume two independent processes can continuously own or capture the microphone reliably.

Evaluate alternatives such as:

### Option A: Local host audio service owns the microphone

Microphone
    ↓
Local wake-word / audio service
    ├── wake detection
    └── activated audio → Mission Control voice path

### Option B: Browser owns the microphone

Browser audio capture
    ├── local wake detector
    └── activated stream → Gemini

### Option C: Shared/local audio pipeline

A local service owns acquisition and exposes audio/state to whichever Mission Control component needs it.

Select the simplest reliable architecture after verifying behavior on the expected host.

Avoid duplicating microphone capture stacks merely because implementation is convenient.

---

# Wake-to-Command Audio Handoff

Treat this as an explicit engineering problem.

Natural speech may be:

> "Mission Control ... what's happening tomorrow?"

or:

> "Mission Control, what's happening tomorrow?"

The beginning of the command must not be lost while the wake detector is triggering and the Gemini session is being established.

Investigate a small rolling local audio buffer or equivalent mechanism so recently captured audio can be retained around activation.

Determine experimentally whether:
- wake phrase should be omitted from Gemini input
- audio immediately following the phrase should be forwarded
- some pre-trigger audio should be retained
- Gemini session startup latency requires local buffering

Do not blindly forward long periods of ambient pre-wake audio.

---

# Interaction State Model

Integrate wake-word activation coherently with the existing voice state machine.

Conceptually support:

IDLE / ARMED
    ↓ "Mission Control"
ACTIVATED
    ↓
LISTENING
    ↓ end of utterance
THINKING
    ↓
RESPONDING
    ↓
IDLE / ARMED

The exact implementation should follow the existing voice state architecture.

The screen should give immediate acknowledgement of successful wake detection. Do not wait for Gemini connection or transcription before visually acknowledging the user.

Example:

> ● Listening

During processing:

> Checking tomorrow...

During response, the display remains the primary output medium where useful.

---

# End-of-Utterance Handling

Wake-word activation eventually needs hands-free completion of the voice turn.

Investigate how the existing Gemini Live VAD/end-of-speech behavior can replace the manual Stop interaction after wake-word activation.

Requirements:
- normal pauses must not prematurely end a command
- the user should not need to touch Stop
- interactions should terminate predictably
- sessions must not remain open indefinitely after abandoned activations

Retain manual Stop/Cancel as a fallback while developing this.

---

# Assistant Audio and Echo Interaction

Mission Control can play assistant speech through speakers near the microphone.

Ensure assistant output does not repeatedly trigger:
- the "Mission Control" detector
- new Gemini turns
- spurious microphone capture
- feedback loops

Evaluate appropriate behavior such as:
- suspending wake detection while Mission Control is speaking
- resuming after playback completes
- echo cancellation where supported
- short post-playback suppression/debounce if necessary

Do not permanently disable interruption/barge-in capability through an overly simplistic solution.

It is acceptable for the first implementation to prohibit wake-word reactivation while Mission Control is speaking, provided the behavior is explicit and documented.

---

# Detection Reliability

Wake-word detection should be evaluated as an appliance feature, not merely demonstrated once.

Expose configurable values where appropriate:
- wake-word detection threshold
- cooldown / debounce interval
- wake-word feature enabled/disabled
- microphone selection if existing architecture supports it

Test the phrase "Mission Control" under representative conditions:
- several distances from the display
- different speaking volumes
- multiple household voices
- normal room noise
- television/music/background speech
- speech immediately following the wake phrase
- repeated activation
- assistant audio playing

Measure both:

### False negatives
Deliberate "Mission Control" utterances that fail to activate.

### False positives
Normal household audio that activates Mission Control unexpectedly.

Do not optimize one while ignoring the other.

---

# Performance

Wake-word inference may run continuously.

Measure representative:
- CPU utilization
- memory utilization
- wake detection latency
- microphone/audio processing overhead

Avoid processing unnecessarily high bandwidth audio for keyword spotting.

The component should be suitable for continuously running on a modest Windows mini-PC/thin-client class host.

---

# Failure Behavior

Wake-word failure must not make voice support unusable.

Examples:
- wake detector unavailable
- model fails to load
- microphone unavailable
- microphone disconnected
- detector crashes
- configured model missing
- local audio pipeline fails

In these cases:
- push-to-talk should remain usable whenever the underlying microphone still works
- Mission Control itself should remain operational
- UI/settings should expose useful diagnostic status
- avoid repeated noisy retries or log flooding

A wake-word failure is a degraded convenience feature, not a Mission Control fatal error.

---

# Settings and Diagnostics

Integrate wake-word configuration into the existing Settings experience rather than consuming permanent dashboard space.

Useful settings/status include:

- Wake word enabled
- Wake phrase: Mission Control
- Detector status
- Microphone status
- Selected microphone where applicable
- Detection threshold where appropriate
- Current state: Armed / Listening / Disabled / Error

Developer diagnostics may additionally expose:
- latest detector score
- detection timestamp
- activation-to-listening latency
- model/runtime information

Do not turn normal kiosk UI into a debugging console.

---

# Privacy

Before wake activation, audio processing should remain local by default.

Do not:
- stream ambient room audio continuously to Gemini
- record ambient audio
- persist arbitrary microphone captures
- upload wake-word samples during normal operation

Any model-training workflow requiring external processing should be clearly separate from runtime inference and documented.

---

# Licensing and Model Provenance

Treat runtime software and trained wake-word model licensing as separate concerns.

Before adopting a wake-word engine or downloaded/trained model:

1. Verify the runtime/library license.
2. Verify the license governing the actual "Mission Control" trained model.
3. Record where the model came from.
4. Record how it was trained or obtained.
5. Record restrictions on redistribution or commercial use.
6. Avoid assuming an open-source runtime implies that model weights have the same license.

Update:
- project-level dependency/license documentation
- relevant README/resources
- `AGENTS.md`

Add a durable project instruction that ML/audio/vision model artifacts must have licensing and provenance reviewed independently from the software libraries that execute them.

There is currently no planned commercialization, but preserve enough provenance that future use does not require reconstructing how model assets were obtained.

---

# Candidate Technology Notes

openWakeWord is one candidate worth evaluating. Its runtime is local and open source, custom models are possible, and its current Python packaging supports Windows through ONNX Runtime.

Picovoice Porcupine is another candidate worth evaluating, particularly as a comparison for custom wake-word quality and Windows support.

Do not select either solely because it is mentioned here.

Evaluate both implementation suitability and licensing/model terms before committing.

---

# Testing

Add automated tests around the application-level wake/voice state machine independent of the actual microphone/model.

At minimum test:

1. Wake detection transitions Armed → Listening.
2. Wake detection starts the existing voice-session path.
3. Push-to-talk continues working with wake-word support enabled.
4. Push-to-talk works when wake-word support is unavailable.
5. Repeated detector signals do not create concurrent voice sessions.
6. Wake signals during an active voice turn are handled safely.
7. Assistant playback cannot accidentally create another voice session.
8. Abandoned activation times out safely.
9. Wake detector errors leave Mission Control usable.
10. Disabling wake-word support stops continuous detection.
11. Restart returns to the appropriate armed/disabled state.

Keep actual model/microphone tests separate from deterministic application tests.

---

# Manual Validation

On representative hardware, validate:

1. "Mission Control" activates while standing directly at the display.
2. It activates from realistic across-room distance.
3. "Mission Control, what's happening tomorrow?" does not lose the beginning of the command.
4. "Mission Control" followed by a pause still permits the subsequent command.
5. Ordinary conversation does not frequently activate the system.
6. Television/music/background speech does not frequently activate it.
7. Mission Control's own audio output does not reactivate itself.
8. Multiple successive voice interactions work.
9. Push-to-talk continues working.
10. Recovery after detector/microphone failure is reasonable.
11. CPU/memory use is acceptable for continuous operation.

---

# Execution

Work autonomously through this task.

1. Inspect the existing voice implementation first.
2. Understand current microphone ownership and Gemini session lifecycle.
3. Research and corroborate current wake-word implementation alternatives.
4. Document the selected architecture and alternatives considered.
5. Update `.github/copilot-instructions.md` with durable wake-word, local-audio, and model-licensing principles.
6. Update project-level licensing/provenance resources.
7. Train or obtain a "Mission Control" model using a documented, appropriately licensed process.
8. Implement local wake detection.
9. Integrate detection into the existing voice-session path.
10. Preserve push-to-talk.
11. Implement safe audio handoff and interaction state transitions.
12. Add configuration/settings/diagnostics.
13. Add automated tests.
14. Run existing backend/frontend/type-check/lint/test suites.
15. Test on available microphone hardware.
16. Measure activation latency and representative continuous resource use.
17. Document Windows/Linux assumptions and limitations.

Do not:
- redesign unrelated Mission Control UI
- replace the existing Gemini/tool architecture
- implement speaker recognition
- implement facial/person recognition
- route wake-word recognition through Gemini
- continuously send ambient microphone audio to the cloud
- remove the existing push-to-talk path
- introduce a generalized audio framework unless current requirements actually demand it

Before completion, verify that saying "Mission Control" and immediately speaking a command behaves like a natural hands-free version of the existing Ask interaction rather than a separate voice system.

Report:
- selected detector/model and why
- microphone ownership architecture
- wake-to-Gemini audio handoff design
- measured wake latency
- representative CPU/memory utilization
- false-positive/false-negative observations from available testing
- licensing/model provenance
- automated validation results
- remaining limitations