import { useCallback, useEffect, useRef, useState } from 'react'

import { AudioSink, MicCapture } from './audio'
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

function appendTranscript(current: string, incoming: string): string {
  const text = incoming.trim()
  if (!text || current.endsWith(text)) return current
  // Some Live transcription updates are complete revisions, others are the
  // newly recognized token(s). Support both without repeating the utterance.
  if (text.startsWith(current)) return text
  let overlap = 0
  for (let length = Math.min(current.length, text.length); length > 0; length -= 1) {
    if (current.endsWith(text.slice(0, length))) {
      overlap = length
      break
    }
  }
  if (overlap) return current + text.slice(overlap)
  const separator = /^[,.;:!?'’)]/.test(text) || /[([]$/.test(current) ? '' : ' '
  return `${current}${separator}${text}`.trim()
}

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
  const actionsRef = useRef(actions)
  actionsRef.current = actions
  const errorRef = useRef(error)
  errorRef.current = error

  const teardown = useCallback(() => {
    sessionRef.current?.close()
    sessionRef.current = null
    micRef.current?.stop()
    micRef.current = null
    setMicActive(false)
    sinkRef.current?.flush()
    turnCompleteRef.current = false
    sinkBusyRef.current = false
  }, [])

  const finishTurn = useCallback(() => {
    teardown()
    setStatus((current) => (current === 'unavailable' ? current : 'idle'))
  }, [teardown])

  const maybeFinish = useCallback(() => {
    if (turnCompleteRef.current && !sinkBusyRef.current) finishTurn()
  }, [finishTurn])

  const recordFailure = useCallback((next: VoiceError) => {
    teardown()
    failuresRef.current += 1
    setError(next)
    setStatus(failuresRef.current >= MAX_CONSECUTIVE_FAILURES ? 'unavailable' : 'error')
  }, [teardown])

  const handleEvent = useCallback(
    (event: VoiceEvent) => {
      switch (event.type) {
        case 'user-transcript':
          setTranscript((t) => ({ ...t, user: appendTranscript(t.user, event.text) }))
          break
        case 'assistant-transcript':
          setTranscript((t) => ({ ...t, assistant: t.assistant + event.text }))
          break
        case 'audio':
          sinkBusyRef.current = true
          sinkRef.current?.enqueue(event.data)
          setStatus((current) => (current === 'listening' ? current : 'speaking'))
          break
        case 'tool-call':
          dispatchToolCall(event.name, event.args, {
            actions: actionsRef.current,
            apiBaseUrl,
          })
            .then((response) => sessionRef.current?.respondTool(event.id, event.name, response))
            .catch((cause: unknown) =>
              sessionRef.current?.respondTool(event.id, event.name, {
                ok: false,
                error: String(cause),
              }),
            )
          break
        case 'interrupted':
          sinkRef.current?.flush()
          sinkBusyRef.current = false
          break
        case 'turn-complete':
          turnCompleteRef.current = true
          maybeFinish()
          break
        case 'closing':
          if (sessionRef.current) finishTurn()
          break
        case 'error':
          recordFailure({ kind: event.kind, message: event.error.message || FALLBACK_MESSAGE[event.kind] })
          break
        case 'open':
          break
      }
    },
    [apiBaseUrl, finishTurn, maybeFinish, recordFailure],
  )

  const startTurn = useCallback(async () => {
    if (status === 'listening' || status === 'connecting') return
    if (status === 'unavailable' && errorRef.current?.kind === 'disabled') return
    teardown()
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

    try {
      const session = new GeminiVoiceSession(apiBaseUrl, handleEvent, surface)
      sessionRef.current = session
      await session.connect()

      try {
        await mic.start((chunk) => sessionRef.current?.sendAudio(chunk))
      } catch (cause: unknown) {
        throw microphoneError(cause)
      }
      setMicActive(true)
      console.debug('[voice] microphone capture started')

      failuresRef.current = 0
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
  }, [apiBaseUrl, handleEvent, maybeFinish, recordFailure, status, surface, teardown])

  const stopTurn = useCallback(() => {
    if (status !== 'listening') return
    micRef.current?.stop()
    micRef.current = null
    setMicActive(false)
    sessionRef.current?.endAudioStream()
    setStatus('thinking')
  }, [status])

  const dismissError = useCallback(() => {
    setError(null)
    setStatus((current) => (current === 'error' ? 'idle' : current))
  }, [])

  useEffect(() => {
    return () => {
      teardown()
      sinkRef.current?.close()
      sinkRef.current = null
    }
  }, [teardown])

  return { status, transcript, error, micActive, startTurn, stopTurn, dismissError }
}
