---
status: reference
summary: Sole authority on mic capture, the one gain stage, sample rates, echo cancellation, and playout.
---

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
   it". *Which* device that one stream opens is a separate, single decision — see
   **Input device selection**.
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
   heard by the open microphone as speech — and is also missed by the Wi-Fi
   speaker tap that forks the same bus (see **Output device selection**).
6. **Level thresholds are acoustic facts; gain is a configuration.** Any decision
   about level is taken at a fixed reference gain, never at whatever gain happens
   to be configured today.

## The capture chain

```
USB microphone / VB-CABLE virtual input   <- chosen by useAudioInput (see below)
  -> getUserMedia({ channelCount: 1, echoCancellation: true,
                    noiseSuppression: false, autoGainControl: false,
                    deviceId?: { exact | ideal } })
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

## Input device selection

The kiosk box has more than one audio input — the physical far-field mic, and,
when a recovered HK Invoke speaker is bridged in, a **VB-CABLE** virtual "CABLE
Output" device carrying that feed. `useAudioInput`
(`frontend/src/voice/useAudioInput.ts`) owns the choice of which one the single
`MicSource` stream opens; `voice/audioInput.ts` holds the pure logic.

- **The choice is per-browser**, stored in `localStorage['mission-control.audio-input']`
  as `"auto"` or `{deviceId,label}` — a property of the machine, exactly like the
  wake-word on/off switch. There is no backend setting.
- **`auto` (the default) prefers a VB-CABLE input** when `enumerateDevices()`
  reports one, matched by label (`isVbCableLabel`), and otherwise lets the OS
  pick. Because the match is on the label, and labels are only readable once the
  page has held a mic grant, a cold boot opens the OS default for the first
  stream and then re-acquires onto VB-CABLE within that first stream cycle. On a
  kiosk that runs continuously this settles in the first minute.
- **An explicit pick is requested strictly** (`deviceId: { exact }`): if that
  device is absent the capture fails with a mic error rather than silently
  recording a different microphone. `auto`'s VB-CABLE preference is best-effort
  (`{ ideal }`). Selection resolves by id first, then by remembered label
  (deviceIds rotate when the mic permission is reset or the device is replugged).
- **`MicSource.setInputDeviceId()` is the only path** from the choice to
  `getUserMedia`, mirroring how `setInputGainDb()` is the only path for gain.
  Changing it while a stream is live tears the stream down and rebuilds it under
  the same listeners; `[voice] mic stream acquired` logs the requested vs. bound
  device so a kiosk operator can confirm what is actually being captured.
- **Settings → Microphone** lists the inputs and the Automatic option (shown when
  voice or wake word is available). No UI when `enumerateDevices` is unavailable.

### The VB-CABLE input can be gated upstream (the on-device Invoke gate)

Nothing in the capture chain changes, but the bytes on "CABLE Output" are no
longer necessarily continuous. When the additive Invoke gate is on
(`invoke_gate_enabled`, default off — see `docs/wake-word-provider-bakeoff.md`),
the on-device `invoke-gate` daemon on the Invoke only streams real room audio
after a candidate; between activations the Windows feeder (in the separate
`ReInvoke2026` repo, `wakeword/feeder/invoke_gate_feeder.py`) writes **synthesised
digital silence** to "CABLE Input". So "CABLE Output" stays a valid, running,
silent input — `MicSource` sees an unbroken stream of zero samples, the selected
wake detector (openWakeWord / Azure) scores ~0, and no turn starts. On an
activation the daemon prefixes a ~2 s preroll burst; the feeder re-primes its
resampler from it. With the gate **off** the feed is continuous as before.
`MicSource` / `useAudioInput` need no changes — this is entirely upstream of the
kiosk.

## Gain: the one knob, and what must not compete with it

`MISSION_CONTROL_MIC_INPUT_GAIN_DB` -> `VoiceConfig.mic_input_gain_db` on
`GET /api/voice/config` -> `useVoiceConfig` -> `micSource.setInputGainDb()` ->
`InputGain`. That is the whole path, and it is the only one. Decibels, converted
as `10^(dB/20)`; `0` disables the stage; validated to −30…+40 dB.

The default is `0` — the stage is off. The kiosk captures through a hardware
microphone path that delivers adequate level on its own, so a software boost is
opt-in per install rather than something every deployment carries. The stage,
its diagnostics, and the threshold decoupling below all stay in place for the
installs that do need it.

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

The "I'm listening" cue plays post-connect for a **push-to-talk** turn only. A
**wake** turn is acknowledged visually (the "● Listening" overlay, shown from the
moment of detection) and plays no cue — a barrelled "Mission Control, what's
tomorrow?" would otherwise get a tone landing mid-command, seconds in
(`useVoiceSession.ts`, `docs/voice-activation-ux-mvp.md`). An audible
at-detection ack for the pause-first style is a parked follow-up
(`docs/voice-activation-ux-plan.md` §B).

Playback rate comes from the provider (`outputSampleRate`), not from a constant.
`AudioSink` schedules each decoded chunk contiguously off a cursor as it arrives;
there is no jitter buffer (removed — it caused audible clicks), so a stream that
arrives slower than real time leaves a gap and logs an underrun.

## Output device selection

The appliance's own sounds — the assistant reply, the listening cue, the timer
chime — can go three ways: the system default speaker, a specific local output
device, or a **recovered HK Invoke over Wi-Fi**. The third is **on hold as of
2026-09** (see the callout under "The Invoke over Wi-Fi" below) — the kiosk uses
Bluetooth for output, `invoke_speaker_host` is empty by default, and the picker
only offers the option when a host is explicitly configured. `voice/audioOutput.ts` +
`voice/useAudioOutput.ts` are the mirror of the input pair; the choice is
per-browser (a property of the machine, like the microphone choice), stored under
`localStorage['mission-control.audio-output']` as `"auto"` (default),
`{deviceId,label}`, or `"invoke"`. There is no backend setting — the backend only
reports whether an Invoke host is configured (`invoke_speaker_configured` on
`GET /api/voice/config`). `useAudioOutput` routes a device pick to
`voice/outputSink.ts` and an `invoke` pick to `voice/speakerOut.ts`.

### A local speaker (`setSinkId`)

The loopback's far end is a bare `<audio>` element. Chromium routes a
peer-connection `<audio>` with no explicit sink to the output endpoint *paired
with the active capture device* (same `groupId`) — not the system default. On
the kiosk the capture device is a VB-CABLE input, whose paired endpoint is the
VB-CABLE *output*, so without intervention every reply, cue and chime is played
straight back into the virtual cable and never heard.

`voice/outputSink.ts` holds the chosen sink id and `aecPlayback.ts` calls
`element.setSinkId()` with it (re-applied on change). An explicit `setSinkId` —
`''` (system default) included — overrides the pairing. `auto` (the default) is
the system default output stated explicitly, and steps off a default that is
itself a VB-CABLE endpoint. `setSinkId` is unavailable in jsdom and Safari; there
a device selection is inert and playout follows the default.

### The Invoke over Wi-Fi (`"invoke"`)

> **Status: on hold (2026-09).** The reliability investigation into this path
> (periodic Wi-Fi-scan choppiness, half-open-socket wedges — see the reliability
> notes below) is tabled. The kiosk now plays its output over **Bluetooth**.
> `invoke_speaker_host` is empty by default; the on-device
> `invoke_speaker_daemon.sh` is started **only** by an explicit
> `invokectl speaker-daemon up` (the ReInvoke2026 host-side watcher no longer
> reconciles it). The code below is retained and still accurate for if the path
> is re-enabled; the MC frontend keeps the picker option.

`createEchoCancelledOutput(context, tap?)` is the one place both output contexts
pass through, so the `tap` forks the bus there: `AudioSink` and `AlarmChime` each
attach a tap, `speakerOut.ts` sums them (`speakerMix.ts`), packs the sum to
PCM16, and sends it as binary frames on `WS /api/voice/speaker`. The backend
(`app/voice/speaker.py`) re-encodes each frame to the ReInvoke2026 Phase-1b wire
codec (`MISSION_CONTROL_INVOKE_SPEAKER_CODEC` — `s16` S16LE/48k/2ch by default,
or `g711u` / `raw`; there is **no handshake** on the port, so this MUST equal the
daemon's `SPK_CODEC`, `invokectl`'s `speaker_codec`, and the feeder's `--codec`
or playback is garbled and slowed) and forwards it over TCP to the
`invoke_speaker_daemon.sh` receiver on the device (separate `ReInvoke2026` repo,
`output/`). **No OS-wide virtual audio device, no separate feeder
process** — MC generates its own output and already bridges browser sockets to
that box (see `app/voice/wake_invoke.py`). The host falls back to
`MISSION_CONTROL_WAKE_WORD_INVOKE_GATE_HOST`; Settings hides the option until one
is set.

- **The stream to the device is continuous, silence included.** Each
  `pcm-speaker-tap-worklet.js` advances its batch by one render quantum on
  *every* `process()` call — real samples when the bus is producing, zeros when
  it is idle. `process()` runs once per 128-sample quantum at exactly real time,
  so a gap in the reply audio lands as real silence *at the quantum it occupies*.
  This is the only correct layer for the fill: the render thread is the one clock
  synchronous with the audio. A wall-clock pacer downstream cannot tell a genuine
  end-of-utterance gap from reply audio arriving a beat late, so it pads the
  latter too and permanently shoves the pending audio back — that is the "plays a
  segment, then an equal gap of silence, then the next segment" stretch.
- **`SpeakerMixer.available()` sums on the furthest writer, never the slowest.**
  Both output contexts (`AudioSink`, `AlarmChime`) have their own `AudioContext`
  and each feeds continuous silence; gating the send rate on
  `min(writeAbs)` pinned it to whichever context's crystal ran behind (and
  stalled entirely if one context suspended). `maxWrittenAbs - readAbs` follows
  the live context; a lagging or frozen second writer is harmless — `write()`
  clamps it back to `readAbs` when it resumes.
- **The local playout is muted only while the Invoke path is carrying audio
  cleanly** (`onRouted` sets a post-tap gain to 0): the socket is open, the
  backend confirms `link:"up"`, *and* the last status frame showed no new
  `sheds` / `reconnects`. A link that is up but dropping frames (the classic
  slow-and-choppy failure) keeps the assistant **and** the timer chime audible on
  the screen instead of replacing them with broken Invoke audio. The bridge
  reports a shed immediately rather than on the 5 s status tick, so the un-mute is
  prompt. The assistant is not heard from both the screen and the Invoke ~0.5 s
  apart; a dropped or unhealthy link un-mutes until it settles.
- **Echo is handled on the device.** The daemon plays through the stock `music`
  ALSA route, leaving the SHARC DSP running, so its hardware AEC uses the played
  audio as the echo reference — the assistant's own speech does not loop into the
  `dsp_mic` capture that VB-CABLE carries back. The browser-side loopback AEC is
  redundant for this path (nothing plays locally) but stays wired for the other
  choices.
- **Clock drift** (browser render clock vs. the Invoke DAC, ~30 ppm) is corrected
  open-loop by `MISSION_CONTROL_INVOKE_SPEAKER_DRIFT_PPM` (default 0), applied in
  the backend bridge as a periodic single-sample slip. Residual drift is an
  occasional inaudible slip absorbed by the device-side buffer. A closed loop
  would need device buffer telemetry — not built.

## Where audio settings live

**Backend, `MISSION_CONTROL_*` (`app/config.py`, documented in `.env.example`).**
Runtime configuration; the kiosk reads what it needs from `GET /api/voice/config`
and `GET /api/voice/wake-config`.

| Setting | Default | Owns |
| --- | --- | --- |
| `MIC_INPUT_GAIN_DB` | `0` | Software capture gain, whole pipeline. `0` = off (default); the hardware mic path carries the level. |
| `WAKE_WORD_THRESHOLD` | `0.3` | Wake score to fire at. Level-dependent. |
| `WAKE_WORD_COOLDOWN_MS` | `2000` | Suppression after a fire. |
| `WAKE_WORD_ENABLED` / `_PHRASE` / `_MODEL_PATH` / `_MODELS_BASE_URL` | off | Wake activation and its model assets. |
| `VOICE_MANUAL_ACTIVITY` | `false` | Gemini only: hybrid vs fully manual turn boundaries. |
| `VOICE_PREFIX_PADDING_MS` / `VOICE_SILENCE_DURATION_MS` | `100` / `250` | Gemini service-VAD endpointing (ignored when manual). |
| `GEMINI_VOICE`, `AZURE_*_VOICE` | — | Reply timbre, per provider. |
| `VOICE_DEBUG_CAPTURE_ENABLED` / `_DIR` / `_KEEP` | on / `voice-captures` / `10` | On-disk WAV captures of provider input. |
| `TIMER_ALARM_MAX_RING_SECONDS` | `300` | How long the chime loops. |
| `INVOKE_SPEAKER_HOST` / `_AUDIO_PORT` | `""` / `5006` | Wi-Fi speaker output target. **Path on hold (2026-09) — leave empty.** Empty ⇒ falls back to `WAKE_WORD_INVOKE_GATE_HOST`; still empty ⇒ Settings omits the "Invoke (Wi-Fi)" speaker option. Setting it also needs a manual `invokectl speaker-daemon up`. |
| `INVOKE_SPEAKER_DRIFT_PPM` | `0` | Open-loop drift slip for the speaker stream (positive ⇒ the Invoke DAC runs fast). |
| `INVOKE_SPEAKER_CODEC` | `s16` | ReInvoke2026 Phase-1b wire codec on `:5006`: `s16` (S16LE/48k/2ch, half the bytes) / `g711u` (µ-law) / `raw` (S32LE). No handshake — MUST equal the daemon's `SPK_CODEC`, `invokectl`'s `speaker_codec`, and the feeder's `--codec`, or playback is slow and garbled. |

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
| `voice/speakerOut.ts` | `MAX_BUFFERED_BYTES` (WS stall threshold), `MAX_SEND_SAMPLES`, reconnect backoff |
| `voice/speakerMix.ts` | ring seconds (how far a fast tap may run ahead) |
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
| `mission-control.audio-input` | The microphone device choice: `"auto"` (default, prefers VB-CABLE) or `{deviceId,label}`. See **Input device selection**. |
| `mission-control.audio-output` | The speaker choice: `"auto"` (default, system default, avoids a VB-CABLE default), `{deviceId,label}`, or `"invoke"` (stream to the Invoke over Wi-Fi). See **Output device selection**. |

## Module map

| File | Responsibility |
| --- | --- |
| `voice/audio.ts` | `MicSource` (the one device + the one gain stage), `MicCapture` (per-turn adapter), `AudioSink` (the output bus) |
| `voice/audioInput.ts` | Pure microphone-choice logic: VB-CABLE detection, the persisted selection, resolve-to-`getUserMedia` |
| `voice/useAudioInput.ts` | Enumerates inputs, keeps the list fresh, pushes the resolved device to `MicSource` |
| `voice/gain.ts` | `InputGain`, `dbToLinear`, `atReferenceGain`, the reference gain |
| `voice/pcm.ts` | Format and rate conversion only — PCM16 to/from Float32, downsample, resample, WAV. No gain, no device, no rate assumptions |
| `voice/aecPlayback.ts` | The echo-cancelled output bus; `setSinkId` on the playout element; the network-speaker tap fork + local mute |
| `voice/outputSink.ts` | The one owner of the output sink id; notifies live playout elements |
| `voice/audioOutput.ts` | Pure speaker-choice logic: the persisted selection (`auto` / device / `invoke`), resolve-to-`setSinkId`, VB-CABLE avoidance |
| `voice/useAudioOutput.ts` | Enumerates outputs, keeps the list fresh; pushes a device pick to `outputSink` and an `invoke` pick to `speakerOut` |
| `voice/speakerOut.ts` | `SpeakerOut`: the `WS /api/voice/speaker` client, tap fan-in, local-mute signal |
| `voice/speakerMix.ts` | `SpeakerMixer`: sums the output-context taps into one mono 48 kHz PCM16 stream |
| `voice/pcm-capture-worklet.js` | Native-rate batching off the audio thread |
| `voice/pcm-speaker-tap-worklet.js` | Same, tapping the output bus for the network speaker |
| `voice/wake/ringBuffer.ts` | Wake pre-roll retention; named wrappers over `pcm.ts` |
| `voice/debugRecorder.ts` | Retains and uploads exactly what reached the provider |
| `timers/chime.ts` | Timer alarm, on the shared output bus |

## Rules for changes

- Adding a consumer of microphone audio means subscribing to `micSource`. Never
  a second `getUserMedia`.
- Changing which device is captured means `micSource.setInputDeviceId()` (driven
  by `useAudioInput`). Never a `deviceId` constraint anywhere else.
- Changing which speaker is played to means `setOutputSinkId()` (driven by
  `useAudioOutput`). Never a `setSinkId` call anywhere else.
- Anything that scales samples belongs in `gain.ts`, or it does not belong.
- Anything that converts format or rate belongs in `pcm.ts`, or it is a duplicate.
- Anything that makes sound connects to the echo-cancelled output — which is
  also what reaches the Wi-Fi speaker. A new output context means a new
  `speakerOut.createTap()` beside its `createEchoCancelledOutput()` call.
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
- **Wi-Fi speaker drift correction is open-loop.** The bridge slips whole samples
  at a configured ppm; there is no closed loop off device buffer telemetry, so a
  wrong `INVOKE_SPEAKER_DRIFT_PPM` still drifts (slowly). The tap is also summed
  per-block with a linear resampler for the rare non-48 kHz output context, which
  can add faint artefacts there — 48 kHz hardware (the norm) is a clean
  pass-through.
- **This path is on hold (2026-09).** The remaining reliability items below were
  not worth chasing further; the kiosk moved to Bluetooth output. Kept here as
  the record if it is ever picked back up.
- **The MC → daemon speaker path is hardware-proven end to end** as of
  2026-09-09: `s16` on every end (MC `INVOKE_SPEAKER_CODEC`, `invokectl`
  `speaker_codec`, the daemon's `SPK_CODEC`), continuous worklet fill, and the
  furthest-writer `available()` — the Invoke plays assistant replies at the right
  speed and timing. Earlier failures for the record: a codec mismatch (MC `s16`
  against a pre-Phase-1b daemon that only decodes `raw` S32LE) is the classic
  ~½-speed-and-distorted symptom and is **not** cleared by a daemon restart
  unless the codec is actually realigned; a *different* stretch — a clean segment
  of audio, then a roughly equal gap of silence, then the next segment, very
  regular — was a pacing bug on the MC side (a downstream wall-clock pacer padding
  normal delivery lag; removed). If either recurs, check `sheds` / `reconnects`
  in the Settings panel and whether the mic uplink is contending for the radio.
- **Periodic choppiness is usually the Wi-Fi link, not this code.** On the
  2026-09-09 kiosk runs the reply audio broke up every ~2 minutes in discrete
  bursts. The cause is device-side: the Invoke's vendor `connection-manager`
  fires full-band scans that pull the radio off-channel for ~1–3 s
  (ReInvoke2026 `transport/AMPDU_FIX_PLAN.md` §6.4). The link RSSI/SNR were
  healthy (−58 dBm / ~31 dB), so this is not an RF-margin problem and moving the
  Invoke closer will not fix it — the fix is device-side. **What MC makes
  worse:** `app/voice/speaker.py` currently escalates a transient send stall
  into a full device-socket teardown (`writer` close → the daemon's
  `tcpserversrc` EOFs → `gst` reprime, ~1 s), so a 2 s blackout becomes a ~4 s
  gap. Partial mitigation landed before the path was tabled: `speaker.py` now
  sets aggressive TCP keepalive on the device socket and caps `writer.drain()`
  at `_SEND_STALL_S` (`_enable_keepalive` / `_drain_or_raise`), so a wedged
  half-open socket is caught in ~8 s instead of hanging forever. Not done: a
  stall grace period that rides a ~3 s blackout without tearing down, and a
  deeper device-side jitter buffer so *reply* audio plays through one scan. The
  mic uplink cannot ride forward — that audio is lost during a scan regardless.
- **The device daemon crash-loops for a few seconds on an unlucky start.**
  `output/invoke_speaker_daemon.sh` on GStreamer 1.10.2 sometimes hits a
  `gst_adapter` CRITICAL in the `rndbuffersize` reblock and `alsasink` then
  rejects the stream as "wrong format" (`rc=1`); the 1 s supervisor retry catches
  it. Seen at daemon start, self-heals, benign once prerolled — but worth a fix
  in ReInvoke2026 (`rndbuffersize` is a workaround for that GStreamer having no
  `rawaudioparse`).
