import { useCallback, useEffect, useRef, useState } from 'react'

import { micSource } from '../audio'
import { createWakeDetector, WakeUnavailableError, type WakeDetector, type WakeEvent } from './detector'

/** Mirrors the backend `WakeWordConfig` (GET /api/voice/wake-config). */
interface WakeConfigResponse {
  enabled: boolean
  phrase: string
  threshold: number
  cooldown_ms: number
  model_path: string
  models_base_url: string
}

export type WakeState =
  | 'off' // feature disabled by config, by the user, or voice is unavailable
  | 'loading' // fetching config / loading the model / acquiring the mic
  | 'armed' // listening locally for the wake phrase
  | 'suspended' // a voice turn is in progress — not listening
  | 'error' // the detector could not start or has failed; push-to-talk is unaffected

export interface WakeDiagnostics {
  state: WakeState
  /** True when the backend config permits wake word (both flags + intended model). */
  available: boolean
  /** The user's on/off choice (persisted); only meaningful when `available`. */
  userEnabled: boolean
  phrase: string
  detail: string | null
  lastScore: number | null
  lastDetectionAt: number | null
  /** wake → "Listening" acknowledgement, for the most recent activation. */
  activationLatencyMs: number | null
}

interface Options {
  apiBaseUrl: string
  /** True while a voice turn is connecting / listening / thinking / speaking. */
  voiceBusy: boolean
  /** Called when the wake phrase is heard while armed. */
  onWake: (event: WakeEvent) => void
}

const USER_PREF_KEY = 'mission-control.wake-word'

function readUserPref(): boolean {
  try {
    return localStorage.getItem(USER_PREF_KEY) !== 'off'
  } catch {
    return true
  }
}

/**
 * Owns the local wake-word detector: fetches its config, brings the detector up
 * when the feature is enabled and idle, suspends it during a voice turn and
 * while the assistant is speaking (no self-triggering, no barge-in loop), and
 * exposes diagnostics for Settings.
 *
 * A detector failure is contained here — it flips this hook to `error` and
 * leaves the rest of the voice stack, push-to-talk included, working.
 */
export function useWakeWord({ apiBaseUrl, voiceBusy, onWake }: Options) {
  const [config, setConfig] = useState<WakeConfigResponse | null>(null)
  const [configFailed, setConfigFailed] = useState(false)
  const [userEnabled, setUserEnabled] = useState(readUserPref)
  const [state, setState] = useState<WakeState>('off')
  const [detail, setDetail] = useState<string | null>(null)
  const [lastScore, setLastScore] = useState<number | null>(null)
  const [lastDetectionAt, setLastDetectionAt] = useState<number | null>(null)
  const [activationLatencyMs, setActivationLatencyMs] = useState<number | null>(null)

  const detectorRef = useRef<WakeDetector | null>(null)
  const pendingWakeAtRef = useRef<number | null>(null)
  const onWakeRef = useRef(onWake)
  onWakeRef.current = onWake
  const voiceBusyRef = useRef(voiceBusy)
  voiceBusyRef.current = voiceBusy

  const available = !!config?.enabled && !configFailed
  const shouldRun = available && userEnabled

  useEffect(() => {
    let cancelled = false
    fetch(`${apiBaseUrl}/api/voice/wake-config`)
      .then((r) => (r.ok ? (r.json() as Promise<WakeConfigResponse>) : Promise.reject(new Error(String(r.status)))))
      .then((c) => {
        if (!cancelled) setConfig(c)
      })
      .catch(() => {
        if (!cancelled) setConfigFailed(true)
      })
    return () => {
      cancelled = true
    }
  }, [apiBaseUrl])

  // Bring the detector up / tear it down as the feature is enabled or disabled.
  useEffect(() => {
    if (!shouldRun || !config) {
      detectorRef.current?.dispose()
      detectorRef.current = null
      setState('off')
      return
    }
    let disposed = false
    setState('loading')
    setDetail(null)
    const detector = createWakeDetector(
      {
        modelPath: config.model_path,
        modelsBaseUrl: config.models_base_url,
        threshold: config.threshold,
        cooldownMs: config.cooldown_ms,
      },
      micSource,
    )
    detectorRef.current = detector
    detector
      .start({
        onWake: (event) => {
          if (disposed) return
          pendingWakeAtRef.current = event.at
          setLastScore(event.score)
          setLastDetectionAt(Date.now())
          onWakeRef.current(event)
        },
        onScore: (score) => {
          if (!disposed) setLastScore(score)
        },
        onError: (error) => {
          if (!disposed) {
            setState('error')
            setDetail(error.message)
          }
        },
      })
      .then(() => {
        if (!disposed) setState(voiceBusyRef.current ? 'suspended' : 'armed')
      })
      .catch((cause: unknown) => {
        if (disposed) return
        detectorRef.current = null
        setState('error')
        setDetail(
          cause instanceof WakeUnavailableError
            ? cause.message
            : cause instanceof Error
              ? cause.message
              : 'wake detector failed to start',
        )
      })
    return () => {
      disposed = true
      detector.dispose()
      if (detectorRef.current === detector) detectorRef.current = null
    }
  }, [shouldRun, config])

  // Suspend during a turn / assistant speech; resume (arm) when idle again.
  useEffect(() => {
    const detector = detectorRef.current
    if (!detector || !detector.running) return
    if (voiceBusy) {
      detector.suspend()
      setState((s) => (s === 'error' || s === 'off' || s === 'loading' ? s : 'suspended'))
    } else {
      detector.resume()
      setState((s) => (s === 'error' || s === 'off' || s === 'loading' ? s : 'armed'))
    }
  }, [voiceBusy])

  useEffect(
    () => () => {
      detectorRef.current?.dispose()
      detectorRef.current = null
    },
    [],
  )

  const setEnabled = useCallback((next: boolean) => {
    try {
      localStorage.setItem(USER_PREF_KEY, next ? 'on' : 'off')
    } catch {
      // best effort; the in-memory choice still applies for this session
    }
    setUserEnabled(next)
  }, [])

  /** Everything heard since the wake phrase, as base64 PCM16 chunks to flush into the session. */
  const takeRetainedAudio = useCallback((targetRate?: number): string[] => {
    return detectorRef.current?.takeRetainedAudio(targetRate) ?? []
  }, [])

  /** Call when the activated turn reaches "Listening" — records wake→ack latency. */
  const reportActivated = useCallback(() => {
    const at = pendingWakeAtRef.current
    pendingWakeAtRef.current = null
    if (at != null) setActivationLatencyMs(Math.round(performance.now() - at))
  }, [])

  const diagnostics: WakeDiagnostics = {
    state,
    available,
    userEnabled,
    phrase: config?.phrase ?? 'Mission Control',
    detail,
    lastScore,
    lastDetectionAt,
    activationLatencyMs,
  }

  return { diagnostics, setEnabled, takeRetainedAudio, reportActivated }
}
