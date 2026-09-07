# Audio pipeline

The single authoritative description of how Mission Control captures, processes
and plays audio, and where every audio setting lives. Written because the answer
to "how do I make the microphone hotter?" had grown four plausible answers.

Companion documents cover *why* individual decisions were made — the endpointing
history in `voice-support-plan.md` (eighth and tenth runs), wake-word geometry in
`wake-word-plan.md`, on-device STT in `local-voice-plan.md`. This document covers
the *shape*: one device, one gain, one output bus, and which knob owns what.

## Principles

1. **One microphone.** Exactly one `getUserMedia` stream, one `AudioContext`, one
   capture worklet, for the whole app. `MicSource` (`frontend/src/voice/audio.ts`)
   owns it and reference-counts subscribers. Wake-word detection and the voice
   turn are both just listeners on the same frames. A second capture stack on one
   device is the classic source of "the mic works until the other feature uses
   it".
2. **One software gain, applied once, as early as possible.** `InputGain`
   (`voice/gain.ts`), inside `MicSource`, upstream of the fan-out. Every consumer
   sees the same gained, ±1-saturated audio and none of them knows it happened.
3. **Nothing competes with that gain.** Enumerated below — this is the rule that
   was actually being broken.
4. **Rates travel with the audio.** No module assumes 16 kHz or 24 kHz. Capture
   rate is `ConversationalVoiceProvider.inputSampleRate`, playback rate is
   `outputSampleRate`, the wake ring buffer's rate is `WAKE_SAMPLE_RATE` (fixed by
   the model). Conversion lives in one place: `voice/pcm.ts`.
5. **One output bus, and everything the appliance plays goes through it.**
   Assistant replies, the listening cue, and the timer chime all render into the
   echo-cancelled output (`voice/aecPlayback.ts`). Anything that bypasses it is
   heard by the open microphone as speech.
6. **Level thresholds are acoustic facts; gain is a configuration.** Any decision
   about level is taken at a fixed reference gain, never at whatever gain happens
   to be configured today.

## The capture chain

```
USB microphone
  -> getUserMedia({ channelCount: 1, echoCancellation: true,
                    noiseSuppression: false, autoGainControl: false })
  -> AudioContext (native rate, typically 48 kHz)
  -> pcm-capture-worklet.js         4800-sample (~100 ms) Float32 batches
  -> InputGain.apply()              <- THE gain stage; +-1 saturation; peak/RMS/clip
  -> fan-out to every MicSource listener, same buffer:
       |- OpenWakeWordDetector  downsample to 16 kHz -> mel -> embedding -> score
       |                         `- AudioRingBuffer (4 s pre-roll, 16 kHz)
       `- MicCapture            downsample to provider.inputSampleRate
                                 |- floatToPcm16Base64 -> provider.sendAudio()
                                 |                     -> voiceDebugRecorder
                                 `- RMS -> atReferenceGain() -> useVoiceSession
```

The `getUserMedia` constraints are deliberate and each has a reason:

| Constraint | Value | Why |
| --- | --- | --- |
| `channelCount` | `1` | Every downstream consumer is mono. |
| `echoCancellation` | `true` | Needs a render reference to work — see **Output**. |
| `noiseSuppression` | `false` | It dug the quiet tail of a sentence below the endpointer's gate and truncated commands (`voice-support-plan.md`, tenth run). |
| `autoGainControl` | `false` | It is a *second, automatic* gain. It would fight the fixed one and flatten the dynamic range the endpointer reads. |

## Gain: the one knob, and what must not compete with it

`MISSION_CONTROL_MIC_INPUT_GAIN_DB` -> `VoiceConfig.mic_input_gain_db` on
`GET /api/voice/config` -> `useVoiceConfig` -> `micSource.setInputGainDb()` ->
`InputGain`. That is the whole path, and it is the only one. Decibels, converted
as `10^(dB/20)`; `0` disables the stage; validated to −30…+40 dB.

Four mechanisms could plausibly change capture level. Only the first is allowed
to, and the other three are held off explicitly:

| Mechanism | Status | How it is held off |
| --- | --- | --- |
| `InputGain` (this one) | **the knob** | Applied once, in `MicSource`, before fan-out. |
| Browser auto-gain-control | disabled | `autoGainControl: false` in the capture constraints. |
| Per-consumer scaling | forbidden | `pcm.ts` does format and rate only, never amplitude. The wake detector, the downsamplers and the provider adapters never touch sample values. |
| Client level thresholds | decoupled | See below. |

### Why the thresholds had to be decoupled

`useVoiceSession`'s end-of-speech backstop compares mic RMS against absolute
numbers (`SPEECH_RMS`, `SPEECH_RMS_FLOOR`, `SPEECH_LEVEL_CEILING`) that were
measured on real kiosk audio. Those measurements were taken *after* the gain
stage. So raising the gain to rescue a quiet microphone also scaled everything
the endpointer sees: room noise starts arming "someone is speaking", and the
relative gate for the quiet tail of a sentence moves with it. One knob, two
effects, one of them undocumented — that is the competition this document exists
to remove.

The fix is `LEVEL_REFERENCE_GAIN_DB` (`gain.ts`). Thresholds are *stated* at that
reference gain, and `MicCapture` normalises the level it reports back to it
(`atReferenceGain(rms, micSource.inputGainLinear)`) before `useVoiceSession` sees
it. Turning the gain knob now changes what the recogniser hears and nothing else.

Two consequences worth knowing:

- The thresholds are properties of the room and the microphone. Re-measure them
  from a capture recorded **at the reference gain**; do not nudge them to
  compensate for a gain change.
- Changing `LEVEL_REFERENCE_GAIN_DB` invalidates all of them at once.

### What the gain still legitimately affects

Not everything can be normalised away, and these are expected to need a re-check
after a large gain change:

- **Wake-word scores.** openWakeWord's mel features are level-dependent, and a
  gain high enough to clip degrades them. Re-check
  `MISSION_CONTROL_WAKE_WORD_THRESHOLD` against the throttled
  `[wake] peak score` console line.
- **Provider-side VAD and ASR.** That is the point of the knob.
- **Debug captures.** `voiceDebugRecorder` records the provider input, i.e.
  post-gain audio. A capture that sounds clipped *is* what the model got.

### Tuning it

Watch the throttled `[voice] mic input level` line (every 2 s; silence the whole
voice trace with `localStorage['voice.trace'] = 'off'`). Aim for a speech `peak`
of roughly 0.3–0.7 with `clipPct` at 0. `peak` is measured pre-saturation, so a
value above 1 tells you how far over you are. `micSource.inputGainStats()`
returns the same numbers on demand.

## Output

Three things make sound: the assistant's reply, the "I'm listening" cue, and the
timer chime. All three render through `createEchoCancelledOutput()`.

Chromium's `getUserMedia({ echoCancellation: true })` only cancels audio it
considers a *remote* stream — the render side of a WebRTC call. Anything played
through a plain `AudioContext` destination is never in the AEC reference, so with
the mic and speakers a foot apart on a wall panel, the appliance hears itself at
full level. `aecPlayback.ts` implements the documented loopback workaround:
render into a `MediaStreamAudioDestinationNode`, pipe it through a local
`RTCPeerConnection` pair, play the far end through an `<audio>` element. It
degrades to `context.destination` where `RTCPeerConnection` is unavailable
(jsdom, a locked-down runtime), so audio always plays — it just is not cancelled.

Echo cancellation is a whole-appliance requirement, not a voice-module one: the
timer chime rings *while* someone says "Mission Control, stop the timer", so
`timers/chime.ts` uses the same bus even though it has nothing to do with voice.

There are two audio contexts on the output side (`AudioSink`'s and
`AlarmChime`'s) because the chime must work with voice switched off entirely.
Each builds its own loopback; both are in the AEC reference.

Playback rate comes from the provider (`outputSampleRate`), not from a constant.
`AudioSink` schedules each decoded chunk contiguously off a cursor as it arrives;
there is no jitter buffer (removed — it caused audible clicks), so a stream that
arrives slower than real time leaves a gap and logs an underrun.

## Where audio settings live

**Backend, `MISSION_CONTROL_*` (`app/config.py`, documented in `.env.example`).**
Runtime configuration; the kiosk reads what it needs from `GET /api/voice/config`
and `GET /api/voice/wake-config`.

| Setting | Default | Owns |
| --- | --- | --- |
| `MIC_INPUT_GAIN_DB` | `20` | Capture gain, whole pipeline. |
| `WAKE_WORD_THRESHOLD` | `0.3` | Wake score to fire at. Level-dependent. |
| `WAKE_WORD_COOLDOWN_MS` | `2000` | Suppression after a fire. |
| `WAKE_WORD_ENABLED` / `_PHRASE` / `_MODEL_PATH` / `_MODELS_BASE_URL` | off | Wake activation and its model assets. |
| `VOICE_MANUAL_ACTIVITY` | `false` | Gemini only: hybrid vs fully manual turn boundaries. |
| `VOICE_PREFIX_PADDING_MS` / `VOICE_SILENCE_DURATION_MS` | `100` / `250` | Gemini service-VAD endpointing (ignored when manual). |
| `GEMINI_VOICE`, `AZURE_*_VOICE` | — | Reply timbre, per provider. |
| `VOICE_DEBUG_CAPTURE_ENABLED` / `_DIR` / `_KEEP` | on / `voice-captures` / `10` | On-disk WAV captures of provider input. |
| `TIMER_ALARM_MAX_RING_SECONDS` | `300` | How long the chime loops. |

The Azure relay's own VAD settings (`semantic_vad`, `azure_semantic_vad` with
`silence_duration_ms: 500`, 24 kHz PCM in and out) are pinned in
`app/voice/relay.py` rather than exposed — they are part of that provider's
session contract, not a household setting.

**Frontend constants.** Tuned against measurements, not meant to be configured
per install. Change them with a capture in hand.

| Where | Constants |
| --- | --- |
| `voice/gain.ts` | `DEFAULT_INPUT_GAIN_DB` (fallback when the backend is unreachable — keep in step with `config.py`), `LEVEL_REFERENCE_GAIN_DB` |
| `voice/useVoiceSession.ts` | `SPEECH_RMS`, `SPEECH_LEVEL_FRACTION`, `SPEECH_RMS_FLOOR`, `SPEECH_LEVEL_CEILING`, `SILENCE_HOLD_MS`, `SERVER_VAD_BACKSTOP_MS`, `MIN_LISTEN_MS`, `MAX_LISTEN_MS`, `NO_SPEECH_TIMEOUT_MS`, `AEC_SETTLE_MS`, `PLAYOUT_GRACE_MS`, `RESPONSE_TIMEOUT_MS` |
| `voice/audio.ts` | default capture / playback rates, `GAIN_LOG_INTERVAL_MS`, sink lead and cue tone |
| `voice/wake/openWakeWord.ts` | `OWW` model geometry, `PREROLL_SECONDS` |
| `voice/debugRecorder.ts` | ring capacity, `MAX_CAPTURE_SECONDS` |
| `timers/chime.ts` | repeat intervals, partials and levels |

**Per-browser `localStorage` switches.** Diagnostics and personal preference; no
kiosk UI, by design.

| Key | Effect |
| --- | --- |
| `voice.trace` = `off` | Silences the voice timeline **and** the mic input-level line. |
| `voice.cue` = `off` | No "I'm listening" tone. |
| `voice.debug.capture` = `off` | Stop retaining/uploading turn audio. |
| `voice.debug.count` | In-browser capture ring size (default 10). |
| `wake.debug` = `off` | Silences the wake peak-score line. |
| `mission-control.wake-word` | The user's wake-word on/off choice. |

## Module map

| File | Responsibility |
| --- | --- |
| `voice/audio.ts` | `MicSource` (the one device + the one gain stage), `MicCapture` (per-turn adapter), `AudioSink` (the output bus) |
| `voice/gain.ts` | `InputGain`, `dbToLinear`, `atReferenceGain`, the reference gain |
| `voice/pcm.ts` | Format and rate conversion only — PCM16 to/from Float32, downsample, resample, WAV. No gain, no device, no rate assumptions |
| `voice/aecPlayback.ts` | The echo-cancelled output bus |
| `voice/pcm-capture-worklet.js` | Native-rate batching off the audio thread |
| `voice/wake/ringBuffer.ts` | Wake pre-roll retention; named wrappers over `pcm.ts` |
| `voice/debugRecorder.ts` | Retains and uploads exactly what reached the provider |
| `timers/chime.ts` | Timer alarm, on the shared output bus |

## Rules for changes

- Adding a consumer of microphone audio means subscribing to `micSource`. Never
  a second `getUserMedia`.
- Anything that scales samples belongs in `gain.ts`, or it does not belong.
- Anything that converts format or rate belongs in `pcm.ts`, or it is a duplicate.
- Anything that makes sound connects to the echo-cancelled output.
- A new absolute level threshold must say what gain it was measured at, and read
  a level normalised to `LEVEL_REFERENCE_GAIN_DB`.
- Changing `MISSION_CONTROL_MIC_INPUT_GAIN_DB`'s default means changing
  `DEFAULT_INPUT_GAIN_DB` and `.env.example` in the same commit.

## Known gaps

- **AEC phase 2 is not built.** The loopback trick covers audio *this page*
  plays. Audio from other processes on the kiosk box (a debug WAV in a media
  player, Windows sounds) is still uncancelled. The plan is a Windows audio
  worker capturing mic + WASAPI render loopback as the reference over
  `WS /api/voice/capture`, with `MISSION_CONTROL_VOICE_AEC_ENABLED` as the off
  switch for a hardware-AEC microphone. Neither the worker nor that setting
  exists yet.
- **The wake model's ONNX feature maths is unvalidated on hardware.** See
  `wake-word-plan.md`.
- **No automated acoustic test.** Everything above is unit-tested at the seams
  (gain maths, rate conversion, endpointing decisions from synthetic levels), but
  the real round-trip is verified by hand on the kiosk.
