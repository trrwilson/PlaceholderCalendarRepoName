import { useCallback, useEffect, useRef, useState } from 'react'

import { AudioSink, MicCapture } from './audio'
import { VoiceTimeline, prewarmVoice } from './instrument'
import {
  GeminiVoiceSession,
  VoiceSessionError,
  VoiceUnavailableError,
  type VoiceEvent,
} from './session'
import { dispatchToolCall } from './tools'
import type {
  DashboardActions,
  VoiceError,
  VoiceErrorKind,
  VoiceStatus,
  VoiceTranscript,
} from './types'

const MAX_CONSECUTIVE_FAILURES = 3
/** How long to wait for the model to make progress after a turn before giving up.
 * A good turn produces an input transcript within ~50 ms of the stream ending
 * and audio within ~2 s; 12 s means the preview model has genuinely stalled. */
const RESPONSE_TIMEOUT_MS = 12_000

/**
 * Audible "I'm listening" cue when a turn opens. On by default (placeholder tone
 * for now); silence it with `localStorage['voice.cue'] = 'off'`.
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

// Client-side end-of-speech detection. The service's own VAD has been slow to
// endpoint push-to-talk turns (10–20 s), so once we have heard speech and then
// a clear pause, we end the turn ourselves. Server VAD stays on as a backstop.
/** Mono 16 kHz RMS above this counts as speech. */
const SPEECH_RMS = 0.01
/** Silence this long after speech ends the turn. */
const SILENCE_HOLD_MS = 1_000
/** Never auto-end before this, so a slow start isn't cut off. */
const MIN_LISTEN_MS = 600
/** Hard cap on a single listening turn. */
const MAX_LISTEN_MS = 15_000

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
 * A wake-word front end would live here later: it would call `startTurn()` on
 * detection and `stopTurn()` on end-of-speech instead of the button.
 */
export function useVoiceSession({ apiBaseUrl, actions, surface = null }: Options) {
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [transcript, setTranscript] = useState<VoiceTranscript>({ user: '', assistant: '' })
  const [error, setError] = useState<VoiceError | null>(null)
  const [micActive, setMicActive] = useState(false)

  const sessionRef = useRef<GeminiVoiceSession | null>(null)
  const micRef = useRef<MicCapture | null>(null)
  const sinkRef = useRef<AudioSink | null>(null)
  const failuresRef = useRef(0)
  const turnCompleteRef = useRef(false)
  const sinkBusyRef = useRef(false)
  const timelineRef = useRef<VoiceTimeline | null>(null)
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
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const errorRef = useRef(error)
  errorRef.current = error
  const statusRef = useRef(status)
  statusRef.current = status
  const watchdogRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const clearWatchdog = useCallback(() => {
    if (watchdogRef.current) {
      clearTimeout(watchdogRef.current)
      watchdogRef.current = null
    }
  }, [])

  const teardown = useCallback(() => {
    clearWatchdog()
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
      timelineRef.current.mark('turn-finished')
      console.info('[voice] turn timeline —', timelineRef.current.summary())
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
      timelineRef.current.mark('failed', { kind: next.kind })
      console.info('[voice] turn timeline (failed) —', timelineRef.current.summary())
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
            .then((response) => {
              armWatchdog()
              // Gemini's FunctionResponse contract: an "output" key is the
              // result, an "error" key is a failure. A dispatcher result that
              // already flagged `ok: false` is reported as an error.
              const payload =
                response && response.ok === false
                  ? { error: response.error ?? 'tool failed' }
                  : { output: response }
              sessionRef.current?.respondTool(event.id, event.name, payload)
            })
            .catch((cause: unknown) =>
              sessionRef.current?.respondTool(event.id, event.name, { error: String(cause) }),
            )
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
          if (sinkRef.current?.pending()) {
            // Safety net: force-finish if the buffer never drains.
            watchdogRef.current = setTimeout(finishTurn, 15_000)
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
      timelineRef.current?.mark('user-turn-end', { reason })
      micRef.current?.stop()
      micRef.current = null
      setMicActive(false)
      sessionRef.current?.endActivity()
      setStatus('thinking')
      armWatchdog()
    },
    [armWatchdog],
  )

  const stopTurn = useCallback(() => endUserTurn('tap'), [endUserTurn])

  // Called ~every 100 ms with the mic RMS while listening. Ends the turn after a
  // clear pause once speech has been heard, or at the hard cap. The service's own
  // VAD stays on as a backstop.
  const handleLevel = useCallback(
    (rms: number) => {
      if (statusRef.current !== 'listening') return
      const now = performance.now()
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
      } else if (listenedMs >= MAX_LISTEN_MS) {
        endUserTurn(spokeRef.current ? 'max-listen' : 'max-listen-silent')
      }
    },
    [endUserTurn],
  )

  const startTurn = useCallback(async () => {
    if (status === 'listening' || status === 'connecting') return
    if (status === 'unavailable' && errorRef.current?.kind === 'disabled') return
    teardown()
    const timeline = new VoiceTimeline()
    timelineRef.current = timeline
    timeline.mark('tap')
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
      const session = new GeminiVoiceSession(apiBaseUrl, handleEvent, surface, timeline)
      sessionRef.current = session
      await session.connect()

      spokeRef.current = false
      lastVoiceAtRef.current = 0
      levelLoggedAtRef.current = 0
      peakRmsRef.current = 0
      listenStartRef.current = performance.now()
      // Cue first (through the speakers), then open the mic turn — so the tone
      // isn't captured as the start of the user's speech.
      playListeningCue(sinkRef.current)
      // Manual activity detection: open the user's turn before any audio frame.
      session.startActivity()
      try {
        await mic.start((chunk) => {
          // Never send audio after we've closed the activity — a stray frame
          // after `activityEnd` can leave the turn without a transcript or reply.
          if (statusRef.current === 'listening') sessionRef.current?.sendAudio(chunk)
        }, handleLevel)
      } catch (cause: unknown) {
        throw microphoneError(cause)
      }
      setMicActive(true)
      timeline.mark('mic-started')

      failuresRef.current = 0
      // Sync so the mic callback's `statusRef` guard is already open.
      statusRef.current = 'listening'
      setStatus('listening')
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

  return { status, transcript, error, micActive, startTurn, stopTurn, dismissError }
}
