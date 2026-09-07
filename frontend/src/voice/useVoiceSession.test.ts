import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from './providers/types'
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
      level: (() => {}) as (rms: number) => void,
      connectBehavior: (() => Promise.resolve()) as () => Promise<void>,
      micStart: (() => Promise.resolve()) as () => Promise<void>,
    },
    spies: {
      endActivity: vi.fn(),
      close: vi.fn(),
      respondTool: vi.fn(),
    },
  }
})

vi.mock('./providers', () => ({
  VoiceUnavailableError: h.VoiceUnavailableError,
  VoiceSessionError: h.VoiceSessionError,
  createVoiceProvider: async (_url: string, onEvent: (event: VoiceEvent) => void) => {
    h.state.emit = onEvent
    return {
      timeline: { mark: vi.fn() },
      inputSampleRate: 16_000,
      connect: () => h.state.connectBehavior(),
      startActivity: vi.fn(),
      endActivity: h.spies.endActivity,
      sendAudio: vi.fn(),
      respondTool: h.spies.respondTool,
      close: h.spies.close,
    }
  },
}))

vi.mock('./audio', () => ({
  MicCapture: class {
    activate = vi.fn()
    start = (_chunk: (b: string) => void, onLevel?: (rms: number) => void) => {
      if (onLevel) h.state.level = onLevel
      return h.state.micStart()
    }
    stop = vi.fn()
  },
  AudioSink: class {
    activate = vi.fn()
    state = vi.fn(() => 'running')
    pending = vi.fn(() => false)
    playTestTone = vi.fn(() => 450)
    enqueue = vi.fn(() => true)
    finalizeStream = vi.fn()
    arrivalStats = vi.fn(() => ({}))
    flush = vi.fn()
    close = vi.fn()
  },
}))

vi.mock('./instrument', () => ({
  prewarmVoice: () => Promise.resolve(),
  recordVoiceTurn: vi.fn(),
  MainThreadLagProbe: class {
    start = vi.fn()
    stop = vi.fn()
    summary = vi.fn(() => ({ maxLagMs: 0, meanLagMs: 0, samples: 0 }))
  },
  VoiceTimeline: class {
    mark = vi.fn()
    elapsed = vi.fn(() => 0)
    summary = vi.fn(() => '')
    toReport = vi.fn(() => ({ milestones: {} }))
    entries = []
  },
}))

// Wake word has its own dedicated state-machine suite (./wake/wakeSession.test.ts);
// here it is inert so these tests stay about push-to-talk.
vi.mock('./wake/useWakeWord', () => ({
  useWakeWord: () => ({
    diagnostics: {
      state: 'off',
      available: false,
      userEnabled: true,
      phrase: 'Mission Control',
      detail: null,
      lastScore: null,
      lastDetectionAt: null,
      activationLatencyMs: null,
    },
    setEnabled: vi.fn(),
    takeRetainedAudio: () => [],
    reportActivated: vi.fn(),
  }),
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
    expect(h.spies.endActivity).toHaveBeenCalled()

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
    // The raw dispatch result is handed to the provider, which formats it for its
    // own wire contract.
    await waitFor(() =>
      expect(h.spies.respondTool).toHaveBeenCalledWith(
        '1',
        'show_view',
        expect.objectContaining({ ok: true }),
      ),
    )
  })

  it('concatenates settled transcription fragments verbatim and shows an interim preview first', async () => {
    const { result } = renderHook(() => useVoiceSession(options))
    await act(async () => {
      await result.current.startTurn()
    })

    // Low-latency preview before anything has settled.
    act(() => h.state.emit({ type: 'user-transcript', text: "what's tomo", final: false }))
    expect(result.current.transcript.user).toBe("what's tomo")

    // Settled fragments arrive with their own spacing and are joined as-is —
    // no trimming, no separator guessing ("What 's to morrow?" was the bug).
    act(() => h.state.emit({ type: 'user-transcript', text: "what's", final: true }))
    act(() => h.state.emit({ type: 'user-transcript', text: ' tomorrow', final: true }))
    act(() => h.state.emit({ type: 'user-transcript', text: '?', final: true }))

    expect(result.current.transcript.user).toBe("what's tomorrow?")

    // Once settled text exists, a late interim fragment does not clobber it.
    act(() => h.state.emit({ type: 'user-transcript', text: 'stale', final: false }))
    expect(result.current.transcript.user).toBe("what's tomorrow?")
  })

  it('ends the turn on its own after speech is followed by a pause', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVoiceSession(options))
      await act(async () => {
        await result.current.startTurn()
      })
      expect(result.current.status).toBe('listening')

      // Speak for a bit...
      for (let i = 0; i < 8; i += 1) {
        act(() => h.state.level(0.05))
        vi.advanceTimersByTime(100)
      }
      expect(result.current.status).toBe('listening')

      // ...then go quiet past the hold window.
      for (let i = 0; i < 12; i += 1) {
        act(() => h.state.level(0.001))
        vi.advanceTimersByTime(100)
      }

      expect(result.current.status).toBe('thinking')
      expect(h.spies.endActivity).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('does not mistake the listening cue for the user speaking', async () => {
    // The regression: the cue plays out of the speakers while the mic is already
    // open, and the level detector heard it at 0.063 RMS — six times SPEECH_RMS.
    // That set `spoke`, and SILENCE_HOLD_MS then ended the turn ~700 ms after the
    // mic opened, before the person had said anything. The model got a beep,
    // answered nothing, and the response watchdog blamed it for the silence.
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVoiceSession(options))
      await act(async () => {
        await result.current.startTurn()
      })
      expect(result.current.status).toBe('listening')

      act(() => h.state.level(0.063))

      // Comfortably past SILENCE_HOLD_MS: had the cue counted, the turn would be
      // over by now.
      await act(async () => {
        vi.advanceTimersByTime(1_500)
        h.state.level(0.001)
      })

      expect(result.current.status).toBe('listening')
      expect(h.spies.endActivity).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('submits the turn once real speech is followed by a pause', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVoiceSession(options))
      await act(async () => {
        await result.current.startTurn()
      })

      // Past the cue, so this is the person.
      await act(async () => {
        vi.advanceTimersByTime(800)
        h.state.level(0.05)
      })
      await act(async () => {
        vi.advanceTimersByTime(1_200)
        h.state.level(0.001)
      })

      expect(result.current.status).toBe('thinking')
      expect(h.spies.endActivity).toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons a turn where nothing was ever said instead of failing it', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVoiceSession(options))
      await act(async () => {
        await result.current.startTurn()
      })

      await act(async () => {
        vi.advanceTimersByTime(800)
        h.state.level(0.001)
      })
      await act(async () => {
        vi.advanceTimersByTime(6_000)
        h.state.level(0.001)
      })

      // Quietly back to idle — not "The assistant stopped responding", and the
      // model is never asked to answer an empty question.
      expect(result.current.status).toBe('idle')
      expect(result.current.error).toBeNull()
      expect(h.spies.endActivity).not.toHaveBeenCalled()

      // And nothing is left armed to fail the turn after the fact.
      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })
      expect(result.current.status).toBe('idle')
    } finally {
      vi.useRealTimers()
    }
  })

  it('gives up instead of hanging when the model never responds after the turn', async () => {
    vi.useFakeTimers()
    try {
      const { result } = renderHook(() => useVoiceSession(options))
      await act(async () => {
        await result.current.startTurn()
      })
      act(() => result.current.stopTurn())
      expect(result.current.status).toBe('thinking')

      await act(async () => {
        vi.advanceTimersByTime(20_000)
      })

      expect(result.current.status).toBe('error')
      expect(result.current.error?.kind).toBe('session')
    } finally {
      vi.useRealTimers()
    }
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
