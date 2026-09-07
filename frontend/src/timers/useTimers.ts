import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AlarmChime } from './chime'
import { ALARM_MAX_RING_MS, type Timer, type TimerMessage, type TimerMutationResult } from './types'

export type TimerConnection = 'connecting' | 'live' | 'offline'

interface Options {
  apiBaseUrl: string
  onConnectionChange?: (state: TimerConnection) => void
  /** The initiating kiosk started a timer (used to announce a replaced one). */
  onStarted?: (timer: Timer, replaced: Timer | null) => void
  /** A timer reached its firing time (backend push or the local safety net). */
  onFired?: (timer: Timer) => void
}

export interface TimersApi {
  timer: Timer | null
  remainingMs: number
  /** `fired` from the backend, or the local clock passed `fires_at` with no push. */
  alarm: boolean
  hasActiveTimer: boolean
  start: (durationSeconds: number, label?: string | null) => Promise<TimerMutationResult>
  extend: (addSeconds: number) => Promise<void>
  cancel: () => Promise<void>
  dismiss: () => Promise<void>
}

/**
 * Owns the single active timer. The backend is authoritative for
 * create/extend/cancel/fire (pushed over `/api/ws`, reconciled against
 * `GET /api/timers` on connect); the countdown seconds and a safety-net fire are
 * computed locally from `fires_at` so a dropped socket still rings.
 */
export function useTimers({ apiBaseUrl, onConnectionChange, onStarted, onFired }: Options): TimersApi {
  const [timer, setTimer] = useState<Timer | null>(null)
  const [remainingMs, setRemainingMs] = useState(0)

  const timerRef = useRef<Timer | null>(null)
  timerRef.current = timer
  const onConnRef = useRef(onConnectionChange)
  onConnRef.current = onConnectionChange
  const onStartedRef = useRef(onStarted)
  onStartedRef.current = onStarted
  const onFiredRef = useRef(onFired)
  onFiredRef.current = onFired
  const firedRef = useRef<Set<string>>(new Set())
  const chimeRef = useRef<AlarmChime | null>(null)
  if (!chimeRef.current) chimeRef.current = new AlarmChime()

  const hasActiveTimer = !!timer && timer.state !== 'dismissed'
  const alarm =
    hasActiveTimer && (timer.state === 'fired' || (timer.state === 'running' && remainingMs <= 0))

  const applyTimers = useCallback((list: Timer[]) => {
    const next = list.find((entry) => entry.state === 'running' || entry.state === 'fired') ?? null
    if (next) firedRef.current.forEach((id) => id !== next.id && firedRef.current.delete(id))
    setTimer(next)
  }, [])

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/timers`)
      const data: unknown = await response.json()
      if (Array.isArray(data)) applyTimers(data as Timer[])
    } catch {
      // Offline: keep the last known timer; the local clock keeps counting.
    }
  }, [apiBaseUrl, applyTimers])

  // -- live connection (no reconnect today, matching /api/ws elsewhere) --------
  useEffect(() => {
    let socket: WebSocket | null = null
    let disposed = false
    onConnRef.current?.('connecting')
    void refresh()
    try {
      socket = new WebSocket(`${apiBaseUrl.replace(/^http/, 'ws')}/api/ws`)
      socket.addEventListener('open', () => {
        onConnRef.current?.('live')
        void refresh()
      })
      socket.addEventListener('close', () => {
        if (!disposed) onConnRef.current?.('offline')
      })
      socket.addEventListener('message', (event: MessageEvent) => {
        try {
          const data = JSON.parse(String(event.data)) as TimerMessage
          if (Array.isArray(data.timers)) applyTimers(data.timers)
        } catch {
          // Non-JSON / unrelated frame — ignore.
        }
      })
    } catch {
      onConnRef.current?.('offline')
    }
    return () => {
      disposed = true
      socket?.close()
    }
  }, [apiBaseUrl, refresh, applyTimers])

  // -- countdown: a 1 Hz tick only while a timer is active --------------------
  useEffect(() => {
    if (!timer || timer.state === 'dismissed') {
      setRemainingMs(0)
      return
    }
    const target = new Date(timer.fires_at).getTime()
    const tick = () => setRemainingMs(target - Date.now())
    tick()
    const id = window.setInterval(tick, 1_000)
    const onVisible = () => {
      if (document.visibilityState === 'visible') tick()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      window.clearInterval(id)
      document.removeEventListener('visibilitychange', onVisible)
    }
  }, [timer])

  // -- fire notification (once per timer id), incl. the local safety net ------
  useEffect(() => {
    if (alarm && timer && !firedRef.current.has(timer.id)) {
      firedRef.current.add(timer.id)
      onFiredRef.current?.(timer)
    }
  }, [alarm, timer])

  // -- alarm chime: loop while firing, stop after the backstop ----------------
  useEffect(() => {
    const chime = chimeRef.current
    if (!chime) return
    if (!alarm) {
      chime.stop()
      return
    }
    chime.start()
    const backstop = window.setTimeout(() => chime.stop(), ALARM_MAX_RING_MS)
    return () => {
      window.clearTimeout(backstop)
      chime.stop()
    }
  }, [alarm])

  // -- unlock the audio context on the first interaction anywhere -------------
  useEffect(() => {
    const chime = chimeRef.current
    const unlock = () => chime?.unlock()
    window.addEventListener('pointerdown', unlock, { once: true })
    return () => window.removeEventListener('pointerdown', unlock)
  }, [])

  // -- best-effort screen wake lock while a timer is active ------------------
  useEffect(() => {
    if (!hasActiveTimer || typeof navigator === 'undefined' || !('wakeLock' in navigator)) return
    let sentinel: WakeLockSentinel | null = null
    let released = false
    const acquire = () => {
      navigator.wakeLock
        ?.request('screen')
        .then((next) => {
          if (released) void next.release?.().catch(() => undefined)
          else sentinel = next
        })
        .catch(() => undefined)
    }
    acquire()
    const onVisible = () => {
      if (document.visibilityState === 'visible') acquire()
    }
    document.addEventListener('visibilitychange', onVisible)
    return () => {
      released = true
      document.removeEventListener('visibilitychange', onVisible)
      void sentinel?.release?.().catch(() => undefined)
    }
  }, [hasActiveTimer])

  // -- actions ---------------------------------------------------------------
  const start = useCallback(
    async (durationSeconds: number, label?: string | null): Promise<TimerMutationResult> => {
      const response = await fetch(`${apiBaseUrl}/api/timers`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ duration_seconds: Math.round(durationSeconds), label: label ?? null }),
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}))
        const detail = (body as { detail?: unknown }).detail
        throw new Error(typeof detail === 'string' ? detail : 'Could not start the timer.')
      }
      const result = (await response.json()) as TimerMutationResult
      firedRef.current.delete(result.timer.id)
      setTimer(result.timer)
      onStartedRef.current?.(result.timer, result.replaced)
      return result
    },
    [apiBaseUrl],
  )

  const extend = useCallback(
    async (addSeconds: number) => {
      const current = timerRef.current
      if (!current) return
      const response = await fetch(`${apiBaseUrl}/api/timers/${current.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ add_seconds: Math.round(addSeconds) }),
      })
      if (!response.ok) {
        const body: unknown = await response.json().catch(() => ({}))
        const detail = (body as { detail?: unknown }).detail
        throw new Error(typeof detail === 'string' ? detail : 'Could not extend the timer.')
      }
      const next = (await response.json()) as Timer
      firedRef.current.delete(next.id)
      setTimer(next)
    },
    [apiBaseUrl],
  )

  const remove = useCallback(async () => {
    const current = timerRef.current
    if (!current) return
    setTimer(null)
    try {
      await fetch(`${apiBaseUrl}/api/timers/${current.id}`, { method: 'DELETE' })
    } catch {
      // The WS echo / next refresh reconciles if the request was lost.
    }
  }, [apiBaseUrl])

  return useMemo(
    () => ({
      timer,
      remainingMs,
      alarm,
      hasActiveTimer,
      start,
      extend,
      cancel: remove,
      dismiss: remove,
    }),
    [timer, remainingMs, alarm, hasActiveTimer, start, extend, remove],
  )
}
