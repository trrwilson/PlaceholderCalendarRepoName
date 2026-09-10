// The application-level wake/voice state machine, mic and model mocked out —
// the deterministic tests the wake-word plan asks for (its "Testing" section).
// The real detector (ONNX + microphone) is exercised separately on hardware.

import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type { VoiceEvent } from '../providers/types'
import { useVoiceSession } from '../useVoiceSession'

const h = vi.hoisted(() => {
  class VoiceUnavailableError extends Error {}
  class VoiceSessionError extends Error {
    kind: string
    constructor(kind: string, message: string) {
      super(message)
      this.kind = kind
    }
  }
  const detector = {
    started: false,
    suspended: false,
    disposed: false,
    running: false,
    startBehavior: (() => Promise.resolve()) as () => Promise<void>,
    onWake: (() => {}) as (event: { score: number; at: number }) => void,
    retained: [] as string[],
    endActivationCalls: 0,
    controls: [] as string[],
  }
  return {
    VoiceUnavailableError,
    VoiceSessionError,
    detector,
    fireWake: (score = 0.8) => detector.onWake({ score, at: performance.now() }),
    session: {
      connect: vi.fn(() => Promise.resolve()),
      startActivity: vi.fn(),
      endActivity: vi.fn(),
      sendAudio: vi.fn(),
      close: vi.fn(),
      respondTool: vi.fn(),
      surface: null as string | null,
    },
    // The active turn's mic-level callback, so a test can feed content speech.
    level: (() => {}) as (rms: number) => void,
    // The "I'm listening" cue — suppressed for wake turns, kept for push-to-talk.
    playTestTone: vi.fn(),
    emit: (() => {}) as (event: VoiceEvent) => void,
  }
})

vi.mock('../providers', () => ({
  VoiceUnavailableError: h.VoiceUnavailableError,
  VoiceSessionError: h.VoiceSessionError,
  createVoiceProvider: async (
    _url: string,
    onEvent: (event: VoiceEvent) => void,
    surface: string | null,
  ) => {
    h.emit = onEvent
    h.session.surface = surface
    return {
      timeline: { mark: vi.fn() },
      inputSampleRate: 16_000,
      outputSampleRate: 24_000,
      endpointing: 'hybrid',
      connect: h.session.connect,
      startActivity: h.session.startActivity,
      endActivity: h.session.endActivity,
      sendAudio: h.session.sendAudio,
      respondTool: h.session.respondTool,
      close: h.session.close,
    }
  },
}))

vi.mock('../audio', () => ({
  micSource: {},
  MicCapture: class {
    activate = vi.fn()
    start = (_chunk: (b: string) => void, onLevel?: (rms: number) => void) => {
      if (onLevel) h.level = onLevel
      return Promise.resolve()
    }
    stop = vi.fn()
  },
  AudioSink: class {
    activate = vi.fn()
    setOutputSampleRate = vi.fn()
    state = vi.fn(() => 'running')
    pending = vi.fn(() => false)
    playTestTone = h.playTestTone
    enqueue = vi.fn(() => true)
    finalizeStream = vi.fn()
    arrivalStats = vi.fn(() => ({}))
    flush = vi.fn()
    close = vi.fn()
  },
}))

vi.mock('../instrument', () => ({
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

vi.mock('./detector', async () => {
  const actual = await vi.importActual<typeof import('./detector')>('./detector')
  return {
    ...actual,
    createWakeDetector: () => ({
      get running() {
        return h.detector.running
      },
      get suspended() {
        return h.detector.suspended
      },
      start: (handlers: { onWake: () => void }) => {
        h.detector.onWake = handlers.onWake
        return h.detector.startBehavior().then(() => {
          h.detector.started = true
          h.detector.running = true
        })
      },
      suspend: () => {
        h.detector.suspended = true
      },
      resume: () => {
        h.detector.suspended = false
      },
      takeRetainedAudio: () => h.detector.retained.splice(0),
      endActivation: () => {
        h.detector.endActivationCalls += 1
      },
      sendControl: (cmd: string) => {
        h.detector.controls.push(cmd)
      },
      dispose: () => {
        h.detector.disposed = true
        h.detector.running = false
      },
    }),
  }
})

const WAKE_CONFIG = {
  enabled: true,
  phrase: 'Mission Control',
  threshold: 0.5,
  cooldown_ms: 2_000,
  provider: 'openwakeword',
  providers: [
    { id: 'openwakeword', label: 'openWakeWord (in-browser)', implemented: true, configured: true },
    { id: 'azure', label: 'Azure custom keyword (backend)', implemented: true, configured: false },
  ],
  model_path: '/models/wake/mission_control.onnx',
  models_base_url: '/models/wake',
  invoke_gate_configured: false,
  invoke_gate_enabled: false,
}

const actions = {
  showView: vi.fn(),
  focusDate: vi.fn(),
  highlightEvent: vi.fn(() => ({ matched: false })),
  setPeopleFilter: vi.fn(() => ({ matched: [], unmatched: [] })),
  requestPrivacyUnlock: vi.fn(),
}
const options = { apiBaseUrl: 'http://api.test', actions }

function stubWakeConfig(body: unknown = WAKE_CONFIG, ok = true) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => ({ ok, json: async () => body })) as unknown as typeof fetch,
  )
}

async function renderArmed() {
  const hook = renderHook(() => useVoiceSession(options))
  await waitFor(() => expect(h.detector.started).toBe(true))
  await waitFor(() => expect(hook.result.current.status).toBe('armed'))
  return hook
}

beforeEach(() => {
  h.detector.started = false
  h.detector.suspended = false
  h.detector.disposed = false
  h.detector.running = false
  h.detector.startBehavior = () => Promise.resolve()
  h.detector.retained = []
  h.detector.endActivationCalls = 0
  h.detector.controls = []
  h.level = () => {}
  h.session.surface = null
  h.session.connect.mockClear()
  h.session.startActivity.mockClear()
  h.session.endActivity.mockClear()
  h.session.sendAudio.mockClear()
  h.session.close.mockClear()
  vi.clearAllMocks()
  try {
    localStorage.clear()
  } catch {
    // no-op
  }
  stubWakeConfig()
})

afterEach(() => vi.unstubAllGlobals())

describe('wake-word / voice state machine', () => {
  it('arms once the detector has loaded (idle → armed)', async () => {
    const { result } = await renderArmed()
    expect(result.current.wake.state).toBe('armed')
    expect(result.current.wake.available).toBe(true)
  })

  it('a detection transitions armed → connecting → listening on the existing session path', async () => {
    const { result } = await renderArmed()

    await act(async () => {
      h.fireWake()
    })
    // Immediate acknowledgement — no waiting on the token or Gemini.
    // (connect resolves synchronously in the mock, so we land on listening.)
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.session.connect).toHaveBeenCalledTimes(1)
    expect(h.session.startActivity).toHaveBeenCalledTimes(1)
  })

  it('flushes the retained pre-roll audio into the session before the live mic', async () => {
    h.detector.retained = ['chunk-a', 'chunk-b']
    const { result } = await renderArmed()

    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.session.sendAudio).toHaveBeenCalledWith('chunk-a')
    expect(h.session.sendAudio).toHaveBeenCalledWith('chunk-b')
  })

  it('returns to armed after the turn completes', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))

    act(() => result.current.stopTurn())
    act(() => h.emit({ type: 'turn-complete' }))
    await waitFor(() => expect(result.current.status).toBe('armed'))
  })

  it('suspends the detector during a turn and resumes it after', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.detector.suspended).toBe(true)

    act(() => result.current.stopTurn())
    act(() => h.emit({ type: 'turn-complete' }))
    await waitFor(() => expect(h.detector.suspended).toBe(false))
  })

  it('push-to-talk still works with wake word armed', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      await result.current.startTurn()
    })
    expect(result.current.status).toBe('listening')
    expect(h.session.connect).toHaveBeenCalledTimes(1)
  })

  it('push-to-talk still works when the detector is unavailable', async () => {
    h.detector.startBehavior = () => Promise.reject(new Error('no onnxruntime-web'))
    const { result } = renderHook(() => useVoiceSession(options))
    await waitFor(() => expect(result.current.wake.state).toBe('error'))

    await act(async () => {
      await result.current.startTurn()
    })
    expect(result.current.status).toBe('listening')
  })

  it('repeated detections do not open concurrent sessions', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
      h.fireWake()
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.session.connect).toHaveBeenCalledTimes(1)
  })

  it('a detection during an active turn is ignored', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      await result.current.startTurn()
    })
    expect(result.current.status).toBe('listening')

    await act(async () => {
      h.fireWake()
    })
    expect(h.session.connect).toHaveBeenCalledTimes(1)
  })

  it('a detection while the assistant is speaking cannot start another session', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      await result.current.startTurn()
    })
    act(() => result.current.stopTurn())
    act(() => h.emit({ type: 'audio', data: 'aGk=' }))
    await waitFor(() => expect(result.current.status).toBe('speaking'))

    await act(async () => {
      h.fireWake()
    })
    expect(h.session.connect).toHaveBeenCalledTimes(1)
  })

  it('a wake turn with no content speech is dismissed silently, never asking for a reply', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))

    // The person walked away / it was a false wake — Stop with nothing said.
    act(() => result.current.stopTurn())
    await waitFor(() => expect(result.current.status).toBe('armed'))
    // No `activity-end` → the provider is never asked to answer an empty turn.
    expect(h.session.endActivity).not.toHaveBeenCalled()
    expect(h.detector.suspended).toBe(false)
  })

  it('a long pause between keyword and command does not end the turn (content gate)', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useVoiceSession(options))
      await vi.waitFor(() => expect(h.detector.started).toBe(true))
      await act(async () => {
        h.fireWake()
        await Promise.resolve()
      })
      await vi.waitFor(() => expect(hook.result.current.status).toBe('listening'))

      // 2.5 s of silence after "Mission Control" — provider VAD would endpoint
      // here, but the content gate holds the turn open.
      await act(async () => {
        vi.advanceTimersByTime(2_500)
        h.emit({ type: 'speech-stopped' })
      })
      expect(hook.result.current.status).toBe('listening')
      expect(h.session.endActivity).not.toHaveBeenCalled()

      // The command finally arrives — the gate opens and a later end-of-speech
      // now finalises the turn.
      await act(async () => {
        h.emit({ type: 'user-transcript', text: "Mission Control, what's tomorrow?", final: true })
      })
      await act(async () => {
        vi.advanceTimersByTime(700)
        h.emit({ type: 'speech-stopped' })
      })
      await vi.waitFor(() => expect(h.session.endActivity).toHaveBeenCalledTimes(1))
    } finally {
      vi.useRealTimers()
    }
  })

  it('abandons silently when no content arrives within the content-gate timeout', async () => {
    vi.useFakeTimers()
    try {
      const hook = renderHook(() => useVoiceSession(options))
      await vi.waitFor(() => expect(h.detector.started).toBe(true))
      await act(async () => {
        h.fireWake()
        await Promise.resolve()
      })
      await vi.waitFor(() => expect(hook.result.current.status).toBe('listening'))

      await act(async () => {
        vi.advanceTimersByTime(3_500)
      })
      await vi.waitFor(() => expect(hook.result.current.status).toBe('armed'))
      expect(h.session.endActivity).not.toHaveBeenCalled()
    } finally {
      vi.useRealTimers()
    }
  })

  it('a wake turn whose only transcript is the keyword is abandoned', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))

    await act(() => {
      h.emit({ type: 'user-transcript', text: 'Mission Control', final: true })
    })
    act(() => result.current.stopTurn())
    await waitFor(() => expect(result.current.status).toBe('armed'))
    expect(h.session.endActivity).not.toHaveBeenCalled()
  })

  it('content speech on the live mic opens the gate', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))

    // Past AEC settle, a run of speech-level frames.
    await act(async () => {
      await new Promise((r) => setTimeout(r, 300))
      for (let i = 0; i < 5; i += 1) h.level(0.05)
    })
    expect(result.current.status).toBe('listening')
    // The gate is open now: an explicit stop submits the turn.
    act(() => result.current.stopTurn())
    await waitFor(() => expect(h.session.endActivity).toHaveBeenCalledTimes(1))
  })

  it('requests the wake surface so the backend can clamp endpointing', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.session.surface).toBe('kiosk-wake')
  })

  it('suppresses the listening cue for a wake turn but keeps it for push-to-talk', async () => {
    const { result } = await renderArmed()
    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.playTestTone).not.toHaveBeenCalled()
    expect(result.current.activationStyle).toBe('wake')

    act(() => result.current.stopTurn())
    act(() => h.emit({ type: 'turn-complete' }))
    await waitFor(() => expect(result.current.status).toBe('armed'))

    await act(async () => {
      await result.current.startTurn()
    })
    expect(h.playTestTone).toHaveBeenCalledTimes(1)
    expect(result.current.activationStyle).toBe('ptt')
  })

  it('disabling wake word disposes the detector and stops detection', async () => {
    const { result } = await renderArmed()
    act(() => result.current.setWakeEnabled(false))
    await waitFor(() => expect(h.detector.disposed).toBe(true))
    await waitFor(() => expect(result.current.status).toBe('idle'))
    expect(result.current.wake.state).toBe('off')
  })

  it('exposes the wake-word bake-off: provider + selectable back ends, and switches via PUT', async () => {
    const put = vi.fn(async () => ({ ok: true, json: async () => ({ ...WAKE_CONFIG, provider: 'azure' }) }))
    vi.stubGlobal(
      'fetch',
      vi.fn(async (_url: string, init?: RequestInit) =>
        init?.method === 'PUT' ? put() : { ok: true, json: async () => WAKE_CONFIG },
      ) as unknown as typeof fetch,
    )
    const { result } = await renderArmed()
    expect(result.current.wake.provider).toBe('openwakeword')
    expect(result.current.wake.providers.map((p) => p.id)).toEqual(['openwakeword', 'azure'])

    await act(async () => {
      await result.current.setWakeProvider('azure')
    })
    expect(put).toHaveBeenCalledTimes(1)
    await waitFor(() => expect(result.current.wake.provider).toBe('azure'))
  })

  it('invoke gate on: a wake drives connecting → listening, and the gate is told `done` at turn end', async () => {
    // The provider stays openWakeWord; the Invoke gate is layered on top.
    stubWakeConfig({ ...WAKE_CONFIG, invoke_gate_configured: true, invoke_gate_enabled: true })
    const { result } = await renderArmed()
    expect(result.current.wake.provider).toBe('openwakeword')
    expect(result.current.wake.invokeGateEnabled).toBe(true)

    await act(async () => {
      h.fireWake()
    })
    await waitFor(() => expect(result.current.status).toBe('listening'))
    expect(h.session.connect).toHaveBeenCalledTimes(1)

    act(() => result.current.stopTurn())
    act(() => h.emit({ type: 'turn-complete' }))
    await waitFor(() => expect(result.current.status).toBe('armed'))
    expect(h.detector.endActivationCalls).toBeGreaterThan(0)
  })

  it('does not arm when the backend reports wake word disabled', async () => {
    stubWakeConfig({ ...WAKE_CONFIG, enabled: false })
    const { result } = renderHook(() => useVoiceSession(options))
    await waitFor(() => expect(result.current.wake.available).toBe(false))
    // give any stray effect a chance
    await act(async () => {
      await Promise.resolve()
    })
    expect(h.detector.started).toBe(false)
    expect(result.current.status).toBe('idle')
  })

  it('tears the detector down on unmount (clean restart state)', async () => {
    const { unmount } = await renderArmed()
    unmount()
    expect(h.detector.disposed).toBe(true)
    expect(h.detector.running).toBe(false)
  })
})
