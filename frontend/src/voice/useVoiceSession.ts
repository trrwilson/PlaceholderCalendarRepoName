import { useCallback, useEffect, useRef, useState } from 'react'

import { AudioSink, MicCapture } from './audio'
import { voiceDebugRecorder } from './debugRecorder'
import { MainThreadLagProbe, VoiceTimeline, prewarmVoice, recordVoiceTurn } from './instrument'
import {
  type ConversationalVoiceProvider,
  type EndpointingMode,
  type VoiceEvent,
  VoiceSessionError,
  VoiceUnavailableError,
  createVoiceProvider,
} from './providers'
import { dispatchToolCall } from './tools'
import type {
  DashboardActions,
  VoiceError,
  VoiceErrorKind,
  VoiceStatus,
  VoiceTranscript,
} from './types'
import { useWakeWord } from './wake/useWakeWord'

const MAX_CONSECUTIVE_FAILURES = 3
/** How long to wait for the model to make *any* progress before giving up.
 * Re-armed on every sign of life — transcript, tool call, or audio — so a turn
 * that is merely slow keeps its budget instead of spending it once. A healthy
 * turn produces an input transcript within a second of the stream ending; 12 s
 * with nothing at all means the session has genuinely stalled. */
const RESPONSE_TIMEOUT_MS = 12_000

/**
 * Audible "I'm listening" cue when a turn opens. On by default (placeholder tone
 * for now); silence it with `localStorage['voice.cue'] = 'off'`.
 *
 * The cue plays through the echo-cancelled output (see `AudioSink`), so it no
 * longer needs to be kept out of the capture by deafening the level detector.
 */
function playListeningCue(sink: AudioSink | null): void {
  let on = true
  try {
    on = localStorage.getItem('voice.cue') !== 'off'
  } catch {
    // localStorage unavailable — default to playing the cue.
  }
  if (on) sink?.playTestTone()
}

// End-of-speech detection is negotiated per provider (`session.endpointing`; see
// EndpointingMode and docs/voice-provider-bakeoff-plan.md -> "End-of-speech
// ownership"):
//
//   client   — no provider VAD; the mic-level check below is the whole
//              endpointer, with `SILENCE_HOLD_MS` after speech ends the turn.
//              The kiosk brackets the turn (startActivity + endActivity).
//   hybrid   — the provider VAD emits `speech-stopped`, which is the primary
//              end-of-turn signal; the mic-level check is a longer-hold backstop
//              (`SERVER_VAD_BACKSTOP_MS`) for when it doesn't arrive. endActivity
//              still fires to finalise.
//   provider — the provider owns end-of-speech and the reply; the mic-level
//              check does NOT endpoint (only `MAX_LISTEN_MS` and the Stop tap
//              do), and endActivity is a no-op.
//
// The backstop judges "are they still talking?" *relative to how loud this
// speaker's speech has actually been*. An absolute floor cuts the quiet tail of
// a normal sentence ("...for five minutes" trails ~15 dB under the stressed head)
// off mid-word — see docs/voice-support-plan.md, tenth run.
//
// Every RMS below is stated at `LEVEL_REFERENCE_GAIN_DB` (gain.ts), and
// `MicCapture` normalises the level it reports to that reference. So these are
// properties of the room and the microphone, and re-tuning
// `MISSION_CONTROL_MIC_INPUT_GAIN_DB` for a quiet mic does not silently move the
// speech gate with it. Re-measure them only against a capture recorded at the
// reference gain.
/** RMS that arms "someone is speaking" the first time. Absolute — room noise
 * must not open a turn. */
const SPEECH_RMS = 0.01
/** Once armed, a frame still counts as speech at this fraction of the turn's
 * running speech level... */
const SPEECH_LEVEL_FRACTION = 0.12
/** ...but never below this absolute floor. */
const SPEECH_RMS_FLOOR = 0.004
/** The speech-level estimate is clamped here, so a cough or a clipped sample
 * can't lift the relative gate out of reach of a normal voice. */
const SPEECH_LEVEL_CEILING = 0.25
/** Silence this long after speech ends the turn when the mic-level check is the
 * only endpointer. Dead time on every such turn, so kept just long enough to
 * ride out a mid-sentence pause. */
const SILENCE_HOLD_MS = 700
/** Silence hold when the provider VAD owns the endpoint (`endpointing: hybrid`,
 * or after a `speech-started` on any provider): trust it to send `speech-stopped`
 * and only step in as a backstop if it doesn't. */
const SERVER_VAD_BACKSTOP_MS = 2_500
/** Never auto-end before this, so a slow start isn't cut off. */
const MIN_LISTEN_MS = 600
/** Hard cap on a single listening turn. */
const MAX_LISTEN_MS = 15_000
/** Give up on a turn where no speech was ever heard. Ending at MAX_LISTEN_MS
 * made someone who tapped by accident stare at "Listening…" for 15 s. */
const NO_SPEECH_TIMEOUT_MS = 5_000
/** After the model says it has finished generating, how long the audio sink may
 * take to play out before we stop waiting. Generous: the whole point is that the
 * reply is already buffered and should be allowed to finish. */
const PLAYOUT_GRACE_MS = 20_000
/** End reasons that mean "we decided on our own that nothing was said". Only
 * these abandon the turn; an explicit tap always submits what we captured. */
const AUTO_ABANDON_REASONS = new Set(['no-speech', 'max-listen-silent'])
/** The mic's echo canceller (browser AEC over the loopback playout) takes a beat
 * to converge on turn start. For this long, don't trust the level enough to arm
 * `spoke` or grow the speech-level estimate — but do keep the silence clock
 * fresh (treat the window as "voice active") so the hold isn't already spent
 * when the window lifts. */
const AEC_SETTLE_MS = 250

const FALLBACK_MESSAGE: Record<VoiceErrorKind, string> = {
  disabled: 'Voice support is turned off.',
  network: 'Could not reach the voice service.',
  microphone: 'The microphone could not be started.',
  session: 'The voice connection failed.',
  unknown: 'Voice input hit an unexpected problem.',
}

function microphoneError(cause: unknown): VoiceSessionError {
  const name = (cause as { name?: string })?.name
  if (name === 'NotAllowedError' || name === 'SecurityError') {
    return new VoiceSessionError('microphone', 'Microphone access is blocked for this display.')
  }
  if (name === 'NotFoundError' || name === 'OverconstrainedError') {
    return new VoiceSessionError('microphone', 'No microphone was found.')
  }
  if (name === 'NotReadableError' || name === 'AbortError') {
    return new VoiceSessionError('microphone', 'The microphone is already in use.')
  }
  return new VoiceSessionError('microphone', FALLBACK_MESSAGE.microphone)
}

interface Options {
  apiBaseUrl: string
  actions: DashboardActions
  surface?: string | null
  /** Privacy mode is on — the session stays up but every tool call except the
   *  unlock keypad is refused (docs/privacy-mode-plan.md, resolution 5). */
  privacyLocked?: boolean
}

/**
 * Tap-to-talk voice control. `startTurn()` mints a constrained ephemeral token,
 * opens a Gemini Live session, and streams the microphone; `stopTurn()` ends the
 * user's turn. One session per turn — simple and robust against session limits.
 *
 * Failures are classified (`VoiceError.kind`) so the UI can explain what broke
 * and offer a retry. After `MAX_CONSECUTIVE_FAILURES` in a row, or a hard
 * `disabled` result from the backend, `status` becomes `unavailable`; a
 * `disabled` result stays that way until reload, other kinds allow another
 * `startTurn()`.
 *
 * The wake-word front end (`useWakeWord`, wired in below) is exactly that: on a
 * local "Mission Control" detection it calls the same `startTurn()` the Ask
 * button does, flushing the buffered pre-roll audio into the session so the
 * start of the command is not lost. End-of-speech follows `session.endpointing`
 * exactly as it does for a tap (see the constants block below). Push-to-talk
 * stays independent of all of it.
 */
export function useVoiceSession({
  apiBaseUrl,
  actions,
  surface = null,
  privacyLocked = false,
}: Options) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState<VoiceTranscript>({ user: '', assistant: '' })
  const [error, setError] = useState<VoiceError | null>(null)
  const [micActive, setMicActive] = useState(false)
  // Latest transcript, for the debug recorder to file alongside the audio it kept.
  const transcriptRef = useRef(transcript)
  transcriptRef.current = transcript

  const sessionRef = useRef<ConversationalVoiceProvider | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const sinkRef = useRef<AudioSink | null>(null)
  const failuresRef = useRef(0)
  const turnCompleteRef = useRef(false)
  const sinkBusyRef = useRef(false)
  const timelineRef = useRef<VoiceTimeline | null>(null)
  // Runs for the whole turn so the timeline can say whether slow response
  // audio was the server generating slowly or this thread being too busy to
  // drain the socket (which throttles the sender via TCP backpressure).
  const lagRef = useRef<MainThreadLagProbe | null>(null)
  // The provider assembles the user transcript and every `user-transcript` event
  // now carries the FULL best-so-far string (not a fragment) — so a late
  // correction from the recogniser replaces the early, often wrong, guess
  // instead of leaving it stranded on screen through the model's thinking time.
  // `final` is the settled text; `interim` is a low-latency preview shown only
  // until settled text starts arriving.
  const finalUserRef = useRef('')
  const interimUserRef = useRef('')
  // Client-side end-of-speech state (see constants above).
  const spokeRef = useRef(false)
  const lastVoiceAtRef = useRef(0)
  const listenStartRef = useRef(0)
  const levelLoggedAtRef = useRef(0)
  const peakRmsRef = useRef(0)
  // Running estimate of this speaker's speech level (peak chunk RMS this turn,
  // clamped), for the relative "still talking" gate.
  const speechLevelRef = useRef(0)
  // Set once the provider VAD reports speech this turn; switches the mic-level
  // backstop to a longer hold (see SERVER_VAD_BACKSTOP_MS).
  const serverVadSeenRef = useRef(false)
  // End-of-speech ownership for the active turn, from `session.endpointing`.
  // Drives whether the mic-level check endpoints (`client` / `hybrid`) or is
  // only a MAX_LISTEN safety cap (`provider`), and the silence-hold length.
  const endpointingRef = useRef<EndpointingMode>('client')
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const privacyLockedRef = useRef(privacyLocked)
  privacyLockedRef.current = privacyLocked
  const errorRef = useRef(error)
  errorRef.current = error
  const statusRef = useRef(status)
  statusRef.current = status
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  // Wake-word plumbing. `wakeApiRef` breaks the render-order cycle between
  // `startTurn` (needs the pre-roll) and `useWakeWord` (needs `handleWake`).
  const wakeApiRef = useRef<{
    takeRetainedAudio: (targetRate?: number) => string[]
    reportActivated: () => void
  } | null>(null)
  const viaWakeRef = useRef(false)

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const teardown = useCallback(() => {
    clearWatchdog()
    lagRef.current?.stop()
    sessionRef.current?.close()
    sessionRef.current = null
    micRef.current?.stop()
    micRef.current = null
    setMicActive(false)
    sinkRef.current?.flush()
    turnCompleteRef.current = false
    sinkBusyRef.current = false
    voiceDebugRecorder.endTurn()
  }, [clearWatchdog])

  const finishTurn = useCallback(() => {
    if (timelineRef.current) {
      lagRef.current?.stop()
      timelineRef.current.mark('main-thread-lag', lagRef.current?.summary())
      if (sinkRef.current) timelineRef.current.mark('audio-arrival', sinkRef.current.arrivalStats())
      timelineRef.current.mark('turn-finished')
      console.info('[voice] turn timeline —', timelineRef.current.summary())
      recordVoiceTurn({
        ok: true,
        ...timelineRef.current.toReport(),
        audio: sinkRef.current?.arrivalStats(),
        lag: lagRef.current?.summary(),
      })
      timelineRef.current = null
    }
    voiceDebugRecorder.note({ transcript: transcriptRef.current })
    teardown()
    setStatus((current) => (current === 'unavailable' ? current : 'idle'))
  }, [teardown])

  const maybeFinish = useCallback(() => {
    if (!turnCompleteRef.current) return
    if (sinkBusyRef.current || sinkRef.current?.pending()) return
    finishTurn()
  }, [finishTurn])

  const recordFailure = useCallback((next: VoiceError) => {
    if (timelineRef.current) {
      lagRef.current?.stop()
      timelineRef.current.mark('main-thread-lag', lagRef.current?.summary())
      if (sinkRef.current) timelineRef.current.mark('audio-arrival', sinkRef.current.arrivalStats())
      timelineRef.current.mark('failed', { kind: next.kind })
      console.info('[voice] turn timeline (failed) —', timelineRef.current.summary())
      recordVoiceTurn({
        ok: false,
        failureKind: next.kind,
        ...timelineRef.current.toReport(),
        audio: sinkRef.current?.arrivalStats(),
        lag: lagRef.current?.summary(),
      })
      timelineRef.current = null
    }
    voiceDebugRecorder.note({
      outcome: 'failed',
      failureKind: next.kind,
      transcript: transcriptRef.current,
    })
    teardown()
    failuresRef.current += 1
    setError(next)
    setStatus(failuresRef.current >= MAX_CONSECUTIVE_FAILURES ? 'unavailable' : 'error')
  }, [teardown])

  // After the user's turn ends, the model should start responding (audio, text,
  // or another tool call) within a few seconds. It has been observed to instead
  // go silent for over a minute and then drop the socket with a server error;
  // rather than leave the UI stuck in "Thinking…", give up and let the person
  // retry. Re-armed on every sign of progress.
  const armWatchdog = useCallback(() => {
    clearWatchdog()
    watchdogRef.current = setTimeout(() => {
      timelineRef.current?.mark('response-watchdog-fired')
      recordFailure({
        kind: 'session',
        message: 'The assistant stopped responding. Tap to try again.',
      })
    }, RESPONSE_TIMEOUT_MS)
  }, [clearWatchdog, recordFailure])

  const handleEvent = useCallback(
    (event: VoiceEvent) => {
      switch (event.type) {
        case 'user-transcript':
          // A transcript is progress. Without this the watchdog kept counting
          // from `endUserTurn` while the model was demonstrably working, and a
          // turn that transcribed late but was otherwise fine got killed.
          if (statusRef.current === 'thinking' || statusRef.current === 'speaking') armWatchdog()
          if (event.final) {
            // Full transcript-so-far from the provider — replace, don't append,
            // so a revised hypothesis supersedes the earlier one.
            finalUserRef.current = event.text
            interimUserRef.current = ''
            setTranscript((t) => ({ ...t, user: finalUserRef.current }))
          } else if (!finalUserRef.current) {
            // Preview only, and only while nothing settled has arrived yet.
            interimUserRef.current = event.text
            setTranscript((t) => ({ ...t, user: interimUserRef.current }))
          }
          break
        case 'assistant-transcript':
          if (statusRef.current === 'thinking' || statusRef.current === 'speaking') armWatchdog()
          setTranscript((t) => ({ ...t, assistant: t.assistant + event.text }))
          break
        case 'audio': {
          armWatchdog()
          // Enqueue first; only mark the sink busy if a buffer was actually
          // scheduled, so a decode failure can't wedge the turn in 'speaking'.
          const queued = sinkRef.current?.enqueue(event.data) ?? false
          if (queued) sinkBusyRef.current = true
          setStatus((current) => (current === 'listening' ? current : 'speaking'))
          break
        }
        case 'tool-call':
          armWatchdog()
          dispatchToolCall(event.name, event.args, {
            actions: actionsRef.current,
            apiBaseUrl,
            privacyLocked: privacyLockedRef.current,
          })
            .then((result) => {
              armWatchdog()
              // The provider formats this for its own wire contract (`{ output }`
              // for Gemini, a JSON string for the Azure relay).
              sessionRef.current?.respondTool(event.id, event.name, result)
            })
            .catch((cause: unknown) =>
              sessionRef.current?.respondTool(event.id, event.name, {
                ok: false,
                error: String(cause),
              }),
            )
          break
        case 'generation-complete':
          // All the audio that is coming has been sent. Release the jitter
          // buffer — otherwise a tail shorter than the cushion is never
          // scheduled, and the last word of the reply is simply lost (the
          // previous run flushed with `stillQueued: 1`).
          //
          // `turnComplete` is *not* a dependable follow-up: the server withholds
          // it until it thinks playback has finished, and on a reply arriving at
          // 0.26x real time it did not come at all before the 12 s watchdog
          // killed a turn that had already said everything it had to say. Treat
          // generation-complete as the end of the model's work and give the sink
          // a bounded window to play out.
          clearWatchdog()
          turnCompleteRef.current = true
          sinkRef.current?.finalizeStream()
          if (sinkRef.current?.pending()) {
            watchdogRef.current = setTimeout(finishTurn, PLAYOUT_GRACE_MS)
            maybeFinish()
          } else {
            finishTurn()
          }
          break
        case 'waiting-for-input':
          // The model has nothing to say because we sent it nothing to answer.
          // That is our bug to fix upstream, not an assistant failure — end the
          // turn quietly instead of holding "Thinking…" until the watchdog.
          if (statusRef.current === 'thinking') {
            console.info('[voice] server is waiting for input — ending an empty turn')
            finishTurn()
          }
          break
        case 'interrupted':
          // A real barge-in can only happen while the mic is live. Once the
          // user has released and we're waiting on / playing the reply, an
          // `interrupted` is spurious and must not discard the response audio.
          if (statusRef.current === 'listening') {
            sinkRef.current?.flush()
            sinkBusyRef.current = false
          } else {
            console.info('[voice] ignoring interrupted outside listening', {
              status: statusRef.current,
            })
          }
          break
        case 'turn-complete':
        case 'closing':
          // The server usually closes the socket right after `turnComplete`,
          // while the reply audio is still playing out of the local buffer.
          // Mark the turn done and let the sink drain rather than cutting it.
          clearWatchdog()
          turnCompleteRef.current = true
          if (event.type === 'closing' && !sessionRef.current) break
          // No more audio is coming, so release whatever is still sitting in the
          // jitter buffer instead of waiting for a cushion that will never fill.
          sinkRef.current?.finalizeStream()
          if (sinkRef.current?.pending()) {
            // Safety net: force-finish if the buffer never drains.
            watchdogRef.current = setTimeout(finishTurn, PLAYOUT_GRACE_MS)
            maybeFinish()
          } else {
            finishTurn()
          }
          break
        case 'error':
          recordFailure({ kind: event.kind, message: event.error.message || FALLBACK_MESSAGE[event.kind] })
          break
        case 'diagnostic':
          // Local / Hybrid pipeline trace. The provider already logs it and
          // stashes the full object on `window.__voiceLocal`; mark the turn.
          timelineRef.current?.mark('local-diagnostic', {
            disposition: String((event.data as Record<string, unknown>)?.disposition ?? ''),
            intent: String((event.data as Record<string, unknown>)?.intent ?? ''),
          })
          break
        case 'escalation':
          // The local layer handed this turn to the cloud. There is no cloud
          // text path wired yet — the following `assistant-transcript` carries
          // the user-facing note; just mark it for the bake-off timeline.
          timelineRef.current?.mark('escalation', { reason: event.reason, tier: event.tier })
          break
        case 'speech-started':
          // The provider VAD (`endpointing: hybrid` / `provider`) heard the user
          // begin. Trust it to endpoint the turn; the mic-level check relaxes to
          // a long backstop from here (SERVER_VAD_BACKSTOP_MS).
          serverVadSeenRef.current = true
          spokeRef.current = true
          lastVoiceAtRef.current = performance.now()
          timelineRef.current?.mark('server-speech-started')
          break
        case 'speech-stopped':
          // Semantic VAD does not endpoint an incomplete phrase ("set a timer
          // for…"), so this is a trustworthy end-of-turn — more so than the
          // raw-energy backstop. In `hybrid` mode `endActivity` still goes out
          // from `endUserTurn` to finalise; in `provider` mode it is a no-op and
          // the reply is already on its way.
          serverVadSeenRef.current = true
          timelineRef.current?.mark('server-speech-stopped')
          if (
            statusRef.current === 'listening' &&
            spokeRef.current &&
            performance.now() - listenStartRef.current >= MIN_LISTEN_MS
          ) {
            endUserTurnRef.current('server-vad')
          }
          break
        case 'open':
          break
      }
    },
    [apiBaseUrl, armWatchdog, clearWatchdog, finishTurn, maybeFinish, recordFailure],
  )

  const endUserTurn = useCallback(
    (reason: string) => {
      if (statusRef.current !== 'listening') return
      // Flip the ref synchronously so the mic callback stops forwarding audio
      // this same tick, before React re-renders.
      statusRef.current = 'thinking'
      timelineRef.current?.mark('user-turn-end', { reason, spoke: spokeRef.current })
      micRef.current?.stop()
      micRef.current = null
      setMicActive(false)
      // Nothing above the speech threshold was ever heard *and* nobody asked us
      // to submit, so there is nothing for the model to answer. Asking anyway and
      // then failing on the response watchdog blames the assistant for an empty
      // question — end quietly and leave the kiosk ready for another tap.
      //
      // An explicit Stop tap is deliberate and always submits, threshold or not:
      // the person decided they were done, and a quiet voice that never crossed
      // SPEECH_RMS is exactly the case where they most need it to go through.
      if (!spokeRef.current && AUTO_ABANDON_REASONS.has(reason)) {
        timelineRef.current?.mark('turn-abandoned-no-speech')
        voiceDebugRecorder.note({ outcome: 'abandoned' })
        finishTurn()
        return
      }
      sessionRef.current?.endActivity()
      setStatus('thinking')
      armWatchdog()
    },
    [armWatchdog, finishTurn],
  )

  const stopTurn = useCallback(() => endUserTurn('tap'), [endUserTurn])

  // `handleEvent` is defined above `endUserTurn`; the provider VAD path needs to
  // reach it, so bounce through a ref.
  const endUserTurnRef = useRef(endUserTurn)
  endUserTurnRef.current = endUserTurn

  // Called ~every 100 ms with the mic RMS while listening. Backstop for the
  // provider VAD: ends the turn after a clear pause once speech has been heard,
  // or at the hard cap.
  const handleLevel = useCallback(
    (rms: number) => {
      if (statusRef.current !== 'listening') return
      const now = performance.now()
      const listenedMs = now - listenStartRef.current

      peakRmsRef.current = Math.max(peakRmsRef.current, rms)

      // While the echo canceller converges, keep the silence clock fresh but
      // don't trust the level enough to arm `spoke` or grow the speech-level
      // estimate — residual cue/echo is still leaking through.
      if (listenedMs < AEC_SETTLE_MS) {
        lastVoiceAtRef.current = now
        return
      }

      if (rms > speechLevelRef.current) {
        speechLevelRef.current = Math.min(rms, SPEECH_LEVEL_CEILING)
      }
      // "Still talking" is judged relative to this speaker's own speech level,
      // floored, so the quiet tail of a sentence still counts. Arming `spoke`
      // the first time stays absolute so room noise can't start a turn.
      const voiceGate = spokeRef.current
        ? Math.max(SPEECH_RMS_FLOOR, speechLevelRef.current * SPEECH_LEVEL_FRACTION)
        : SPEECH_RMS

      if (now - levelLoggedAtRef.current > 1_000) {
        levelLoggedAtRef.current = now
        console.info('[voice] mic level', {
          peakRms: Math.round(peakRmsRef.current * 1000) / 1000,
          gate: Math.round(voiceGate * 1000) / 1000,
          spoke: spokeRef.current,
          endpointing: endpointingRef.current,
          serverVad: serverVadSeenRef.current,
          listenedMs: Math.round(listenedMs),
        })
        peakRmsRef.current = 0
      }

      if (rms >= voiceGate) {
        spokeRef.current = true
        lastVoiceAtRef.current = now
      }

      if (listenedMs < MIN_LISTEN_MS) return

      // `provider` end-of-speech: the provider VAD owns the boundary. The
      // mic-level check does not endpoint — only the hard cap and the Stop tap.
      if (endpointingRef.current === 'provider') {
        if (listenedMs >= MAX_LISTEN_MS) {
          endUserTurn(spokeRef.current ? 'max-listen' : 'max-listen-silent')
        }
        return
      }

      // `hybrid`: the provider's `speech-stopped` is the primary endpoint, so the
      // mic-level check waits the longer backstop. `client`: it is the whole
      // endpointer, so the short hold. A `speech-started` on any provider also
      // switches to the backstop.
      const useBackstop = endpointingRef.current === 'hybrid' || serverVadSeenRef.current
      const hold = useBackstop ? SERVER_VAD_BACKSTOP_MS : SILENCE_HOLD_MS
      if (spokeRef.current && now - lastVoiceAtRef.current >= hold) {
        endUserTurn(useBackstop ? 'silence-backstop' : 'silence')
      } else if (!spokeRef.current && listenedMs >= NO_SPEECH_TIMEOUT_MS) {
        endUserTurn('no-speech')
      } else if (listenedMs >= MAX_LISTEN_MS) {
        endUserTurn(spokeRef.current ? 'max-listen' : 'max-listen-silent')
      }
    },
    [endUserTurn],
  )

  const startTurn = useCallback(async (opts?: { viaWake?: boolean }) => {
    const viaWake = opts?.viaWake === true
    viaWakeRef.current = viaWake
    if (!viaWake && (status === 'listening' || status === 'connecting')) return
    if (status === 'unavailable' && errorRef.current?.kind === 'disabled') return
    teardown()
    const timeline = new VoiceTimeline()
    timelineRef.current = timeline
    timeline.mark('tap')
    lagRef.current = new MainThreadLagProbe()
    lagRef.current.start()
    finalUserRef.current = ''
    interimUserRef.current = ''
    setTranscript({ user: '', assistant: '' })
    setError(null)
    setStatus('connecting')

    if (!sinkRef.current) {
      sinkRef.current = new AudioSink(() => {
        sinkBusyRef.current = false
        maybeFinish()
      })
    }
    const mic = new MicCapture()
    micRef.current = mic
    // Must happen synchronously in the Ask button's user gesture so Chrome
    // permits response audio after the asynchronous token/session setup.
    sinkRef.current.activate()
    mic.activate()
    timeline.mark('gesture-setup-done', { sinkState: sinkRef.current.state() })

    try {
      const session = await createVoiceProvider(apiBaseUrl, handleEvent, surface, timeline)
      sessionRef.current = session
      endpointingRef.current = session.endpointing
      await session.connect()

      // Start retaining the audio this turn sends to the provider (the pre-roll
      // below and then every live-mic chunk) for `window.__voiceDebug`.
      sinkRef.current?.setOutputSampleRate(session.outputSampleRate)

      voiceDebugRecorder.beginTurn({
        sampleRate: session.inputSampleRate,
        viaWake,
        apiBaseUrl,
      })
      const { provider, model } = timeline.toReport()
      voiceDebugRecorder.note({ provider: provider ?? null, model: model ?? null })

      spokeRef.current = false
      lastVoiceAtRef.current = 0
      levelLoggedAtRef.current = 0
      peakRmsRef.current = 0
      speechLevelRef.current = 0
      serverVadSeenRef.current = false
      listenStartRef.current = performance.now()
      // The cue routes through the echo-cancelled output, so the open mic no
      // longer hears it as speech — just play it.
      playListeningCue(sinkRef.current)
      // Open the user's turn before any audio frame. Only `client` end-of-speech
      // actually sends an activity marker; `hybrid` / `provider` no-op here.
      session.startActivity()
      if (viaWake) {
        // Flush the audio captured between the wake phrase and now (session
        // setup takes a few seconds; the person is already talking) so the
        // start of the command reaches the model.
        const preroll = wakeApiRef.current?.takeRetainedAudio(session.inputSampleRate) ?? []
        for (const chunk of preroll) {
          session.sendAudio(chunk)
          voiceDebugRecorder.appendChunk(chunk, 'preroll')
        }
        timeline.mark('wake-preroll-flushed', { chunks: preroll.length })
      }
      try {
        await mic.start(
          (chunk) => {
            // Never send audio after we've closed the activity — a stray frame
            // after `activityEnd` can leave the turn without a transcript or reply.
            if (statusRef.current === 'listening') {
              sessionRef.current?.sendAudio(chunk)
              voiceDebugRecorder.appendChunk(chunk, 'mic')
            }
          },
          handleLevel,
          session.inputSampleRate,
        )
      } catch (cause: unknown) {
        throw microphoneError(cause)
      }
      setMicActive(true)
      timeline.mark('mic-started')

      failuresRef.current = 0
      // Sync so the mic callback's `statusRef` guard is already open.
      statusRef.current = 'listening'
      setStatus('listening')
      if (viaWake) wakeApiRef.current?.reportActivated()
    } catch (cause: unknown) {
      if (cause instanceof VoiceUnavailableError) {
        teardown()
        setError({ kind: 'disabled', message: cause.message || FALLBACK_MESSAGE.disabled })
        setStatus('unavailable')
        return
      }
      const kind: VoiceErrorKind = cause instanceof VoiceSessionError ? cause.kind : 'unknown'
      const message = cause instanceof Error && cause.message ? cause.message : FALLBACK_MESSAGE[kind]
      recordFailure({ kind, message })
    }
  }, [apiBaseUrl, handleEvent, handleLevel, maybeFinish, recordFailure, status, surface, teardown])

  const dismissError = useCallback(() => {
    setError(null)
    setStatus((current) => (current === 'error' ? 'idle' : current))
  }, [])

  const startTurnRef = useRef(startTurn)
  startTurnRef.current = startTurn

  // A local wake detection enters the exact same flow as tapping Ask. The
  // status flips to `connecting` synchronously here — the immediate on-screen
  // acknowledgement the plan asks for, before any token fetch or Gemini
  // connection. Guarded to `armed` so a stray detection during a turn (the
  // detector is suspended then anyway) or the assistant's own audio cannot open
  // a second session.
  const handleWake = useCallback(() => {
    if (statusRef.current !== 'armed') return
    statusRef.current = 'connecting'
    setStatus('connecting')
    void startTurnRef.current({ viaWake: true })
  }, [])

  const voiceBusy =
    status !== 'idle' && status !== 'armed' && status !== 'unavailable'
  const wake = useWakeWord({ apiBaseUrl, voiceBusy, onWake: handleWake })
  wakeApiRef.current = wake

  // Surface the armed state through `status` when nothing else is happening, so
  // the Ask button / overlay can show "listening for Mission Control". `armed`
  // behaves like `idle` for every guard.
  useEffect(() => {
    if (status === 'idle' && wake.diagnostics.state === 'armed') setStatus('armed')
    else if (status === 'armed' && wake.diagnostics.state !== 'armed') setStatus('idle')
  }, [status, wake.diagnostics.state])

  useEffect(() => {
    // Pull the lazy SDK chunk and the mic worklet into cache before the first
    // tap so their download is not on the turn's critical path.
    void prewarmVoice()
    return () => {
      teardown()
      sinkRef.current?.close()
      sinkRef.current = null
    }
  }, [teardown])

  return {
    status,
    transcript,
    error,
    micActive,
    startTurn,
    stopTurn,
    dismissError,
    wake: wake.diagnostics,
    setWakeEnabled: wake.setEnabled,
    setWakeProvider: wake.setProvider,
  }
}
