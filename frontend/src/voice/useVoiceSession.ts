import { useCallback, useEffect, useRef, useState } from 'react'

import { AudioSink, MicCapture } from './audio'
import { MainThreadLagProbe, VoiceTimeline, prewarmVoice, recordVoiceTurn } from './instrument'
import {
  type ConversationalVoiceProvider,
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
 * Returns how long the cue will still be audible, in ms, so the caller can keep
 * the level detector deaf until it has finished — the mic hears it otherwise.
 */
function playListeningCue(sink: AudioSink | null): number {
  let on = true
  try {
    on = localStorage.getItem('voice.cue') !== 'off'
  } catch {
    // localStorage unavailable — default to playing the cue.
  }
  return on ? (sink?.playTestTone() ?? 0) : 0
}

// Client-side end-of-speech detection. The service's own VAD has been slow to
// endpoint push-to-talk turns (10–20 s), so once we have heard speech and then
// a clear pause, we end the turn ourselves. Server VAD stays on as a backstop.
/** Mono 16 kHz RMS above this counts as speech. */
const SPEECH_RMS = 0.01
/** Silence this long after speech ends the turn. This is dead time on every
 * single turn — the person has stopped talking and nothing is happening yet — so
 * it is kept just long enough to ride out a mid-sentence pause. The service VAD
 * is a backstop underneath it (see `voice_silence_duration_ms` on the backend). */
const SILENCE_HOLD_MS = 700
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
/** Extra margin past the cue before the level detector is trusted, covering
 * speaker latency and the ~100 ms worklet frame the tone tail lands in. */
const CUE_GUARD_MS = 150

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
 * start of the command is not lost, and end-of-speech is the existing
 * client-side silence detection. Push-to-talk stays independent of all of it.
 */
export function useVoiceSession({ apiBaseUrl, actions, surface = null }: Options) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState<VoiceTranscript>({ user: '', assistant: '' })
  const [error, setError] = useState<VoiceError | null>(null)
  const [micActive, setMicActive] = useState(false)

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
  // Transcription is assembled from two independent Gemini streams. `final`
  // (`inputTranscription`) fragments are the settled text and are concatenated
  // verbatim; `interim` (`interimInputTranscription`) is a low-latency preview
  // shown only until the settled text starts arriving. Neither is trimmed or
  // re-spaced — the fragments already carry the right whitespace.
  const finalUserRef = useRef('')
  const interimUserRef = useRef('')
  // Client-side end-of-speech state (see constants above).
  const spokeRef = useRef(false)
  const lastVoiceAtRef = useRef(0)
  const listenStartRef = useRef(0)
  const levelLoggedAtRef = useRef(0)
  const peakRmsRef = useRef(0)
  // `performance.now()` before which mic levels are ignored: the listening cue
  // is still sounding and would otherwise register as the user speaking.
  const deafUntilRef = useRef(0)
  const actionsRef = useRef(actions)
  actionsRef.current = actions
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
            finalUserRef.current += event.text
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

  // Called ~every 100 ms with the mic RMS while listening. Ends the turn after a
  // clear pause once speech has been heard, or at the hard cap. The service's own
  // VAD stays on as a backstop.
  const handleLevel = useCallback(
    (rms: number) => {
      if (statusRef.current !== 'listening') return
      const now = performance.now()
      if (now < deafUntilRef.current) {
        // The cue is still sounding. Ignore the level entirely *and* keep the
        // listen window starting from now, so MIN_LISTEN_MS / NO_SPEECH_TIMEOUT_MS
        // measure the person's time, not the tone's.
        listenStartRef.current = now
        return
      }
      peakRmsRef.current = Math.max(peakRmsRef.current, rms)
      if (now - levelLoggedAtRef.current > 1_000) {
        levelLoggedAtRef.current = now
        console.info('[voice] mic level', {
          peakRms: Math.round(peakRmsRef.current * 1000) / 1000,
          threshold: SPEECH_RMS,
          spoke: spokeRef.current,
          listenedMs: Math.round(now - listenStartRef.current),
        })
        peakRmsRef.current = 0
      }
      if (rms >= SPEECH_RMS) {
        spokeRef.current = true
        lastVoiceAtRef.current = now
      }
      const listenedMs = now - listenStartRef.current
      if (listenedMs < MIN_LISTEN_MS) return
      if (spokeRef.current && now - lastVoiceAtRef.current >= SILENCE_HOLD_MS) {
        endUserTurn('silence')
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
      await session.connect()

      spokeRef.current = false
      lastVoiceAtRef.current = 0
      levelLoggedAtRef.current = 0
      peakRmsRef.current = 0
      listenStartRef.current = performance.now()
      // The cue plays out of the speakers while the mic is coming up, and the
      // mic hears it: playing "first" does not keep it out of the capture, it
      // only overlaps the first ~250 ms of it. Note when it stops and stay deaf
      // until then rather than pretending the ordering solves it.
      deafUntilRef.current =
        performance.now() + playListeningCue(sinkRef.current) + CUE_GUARD_MS
      // Manual activity detection: open the user's turn before any audio frame.
      session.startActivity()
      if (viaWake) {
        // Flush the audio captured between the wake phrase and now (session
        // setup takes a few seconds; the person is already talking) so the
        // start of the command reaches the model.
        const preroll = wakeApiRef.current?.takeRetainedAudio(session.inputSampleRate) ?? []
        for (const chunk of preroll) session.sendAudio(chunk)
        timeline.mark('wake-preroll-flushed', { chunks: preroll.length })
      }
      try {
        await mic.start(
          (chunk) => {
            // Never send audio after we've closed the activity — a stray frame
            // after `activityEnd` can leave the turn without a transcript or reply.
            if (statusRef.current === 'listening') sessionRef.current?.sendAudio(chunk)
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
  }
}
