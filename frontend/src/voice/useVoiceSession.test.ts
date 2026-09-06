import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from './session'
import { useVoiceSession } from './useVoiceSession'

const h = vi.hoisted(() => {
  class VoiceUnavailableError extends Error {}
  class VoiceSessionError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
    }
  }
  return {
    VoiceUnavailableError,
    VoiceSessionError,
    state: {
      emit: (() => {}) as (event: VoiceEvent) => void,
      connectBehavior: (() => Promise.resolve()) as () => Promise<void>,
      micStart: (() => Promise.resolve()) as () => Promise<void>,
    },
    spies: {
      endAudioStream: vi.fn(),
      close: vi.fn(),
      respondTool: vi.fn(),
    },
  }
})

vi.mock('./session', () => ({
  VoiceUnavailableError: h.VoiceUnavailableError,
  VoiceSessionError: h.VoiceSessionError,
  GeminiVoiceSession: class {
    constructor(_url: string, onEvent: (event: VoiceEvent) => void) {
      h.state.emit = onEvent
    }
    connect = () => h.state.connectBehavior()
    endAudioStream = h.spies.endAudioStream
    sendAudio = vi.fn()
    respondTool = h.spies.respondTool
    close = h.spies.close
  },
}))

vi.mock('./audio', () => ({
  MicCapture: class {
    activate = vi.fn()
    start = () => h.state.micStart()
    stop = vi.fn()
  },
  AudioSink: class {
    activate = vi.fn()
    enqueue = vi.fn()
    flush = vi.fn()
    close = vi.fn()
  },
}))

const actions = { showView: vi.fn(), focusDate: vi.fn(), highlightEvent: vi.fn(() => ({ matched: false })) }
const options = { apiBaseUrl: 'http://api.test', actions }

beforeEach(() => {
  h.state.connectBehavior = () => Promise.resolve()
  h.state.micStart = () => Promise.resolve()
  vi.clearAllMocks()
})
afterEach(() => vi.unstubAllGlobals())

describe('useVoiceSession', () => {
  it('opens the mic on a turn and returns to idle after the reply plays out', async () => {
    const { result } = renderHook(() => useVoiceSession(options))

    await act(async () => {
      await result.current.startTurn()
    })
    expect(result.current.status).toBe('listening')

    act(() => result.current.stopTurn())
    expect(result.current.status).toBe('thinking')
    expect(h.spies.endAudioStream).toHaveBeenCalled()

    act(() => h.state.emit({ type: 'assistant-transcript', text: 'Here is Friday' }))
    act(() => h.state.emit({ type: 'turn-complete' }))

    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.transcript.assistant).toBe('Here is Friday')
    expect(h.spies.close).toHaveBeenCalled()
  })

  it('dispatches a tool call and answers the model', async () => {
    const { result } = renderHook(() => useVoiceSession(options))
    await act(async () => {
      await result.current.startTurn()
    })

    await act(async () => {
      h.state.emit({ type: 'tool-call', id: '1', name: 'show_view', args: { view: 'week' } })
      await Promise.resolve()
    })

    expect(actions.showView).toHaveBeenCalledWith('week', null)
    await waitFor(() =>
      expect(h.spies.respondTool).toHaveBeenCalledWith('1', 'show_view', expect.objectContaining({ ok: true })),
    )
  })

  it('accumulates incremental user transcription into one utterance', async () => {
    const { result } = renderHook(() => useVoiceSession(options))
    await act(async () => {
      await result.current.startTurn()
    })

    act(() => h.state.emit({ type: 'user-transcript', text: 'what', final: false }))
    act(() => h.state.emit({ type: 'user-transcript', text: "'s", final: false }))
    act(() => h.state.emit({ type: 'user-transcript', text: 'tomorrow', final: false }))
    act(() => h.state.emit({ type: 'user-transcript', text: '?', final: true }))

    expect(result.current.transcript.user).toBe("what's tomorrow?")
  })

  it('goes unavailable with kind "disabled" when the backend says voice is off', async () => {
    h.state.connectBehavior = () => Promise.reject(new h.VoiceUnavailableError('voice support is disabled'))
    const { result } = renderHook(() => useVoiceSession(options))

    await act(async () => {
      await result.current.startTurn()
    })

    expect(result.current.status).toBe('unavailable')
    expect(result.current.error).toEqual({ kind: 'disabled', message: 'voice support is disabled' })
  })

  it('classifies a blocked microphone and stays retryable at first', async () => {
    h.state.micStart = () => Promise.reject(Object.assign(new Error('denied'), { name: 'NotAllowedError' }))
    const { result } = renderHook(() => useVoiceSession(options))

    await act(async () => {
      await result.current.startTurn()
    })

    expect(result.current.status).toBe('error')
    expect(result.current.error?.kind).toBe('microphone')
  })

  it('surfaces the failure kind and gives up after repeated transport failures', async () => {
    h.state.connectBehavior = () =>
      Promise.reject(new h.VoiceSessionError('network', 'Could not reach the voice service.'))
    const { result } = renderHook(() => useVoiceSession(options))

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await result.current.startTurn()
      })
    }

    expect(result.current.status).toBe('unavailable')
    expect(result.current.error?.kind).toBe('network')
  })

  it('lets a non-disabled failure be retried', async () => {
    h.state.connectBehavior = () => Promise.reject(new h.VoiceSessionError('session', 'dropped'))
    const { result } = renderHook(() => useVoiceSession(options))
    for (let attempt = 0; attempt < 3; attempt += 1) {
      await act(async () => {
        await result.current.startTurn()
      })
    }
    expect(result.current.status).toBe('unavailable')

    h.state.connectBehavior = () => Promise.resolve()
    await act(async () => {
      await result.current.startTurn()
    })
    expect(result.current.status).toBe('listening')
  })
})
