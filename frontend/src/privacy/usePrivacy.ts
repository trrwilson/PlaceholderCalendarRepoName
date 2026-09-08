import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { PrivacyMessage, PrivacyState, UnlockResult } from './types'

const isPrivacyState = (value: unknown): value is PrivacyState =>
  !!value && typeof value === 'object' && typeof (value as PrivacyState).locked === 'boolean'

export interface PrivacyApi {
  locked: boolean
  since: string | null
  /** Whether an unlock PIN is configured — the kiosk hides the entry
   *  affordances (and voice cannot enter privacy mode) when it is not. */
  available: boolean
  /** Enter privacy mode (no secret — the safe direction). Resolves false if the
   *  feature is not configured. */
  lock: () => Promise<boolean>
  /** Try the PIN. `ok` clears the lock (the ws echo also arrives). */
  unlock: (pin: string) => Promise<UnlockResult>
  /** The no-PIN undo, valid for a few seconds after entry. */
  undo: () => Promise<boolean>
  /** ms left on a wrong-PIN cooldown, 0 when clear. */
  cooldownMs: number
}

const OFF: PrivacyState = { locked: false, since: null, available: false }

/**
 * Owns the household-global privacy-mode flag. The backend is authoritative — it
 * persists the state and pushes every lock / unlock over the shared `/api/ws`
 * connection; this hook reconciles from `GET /api/privacy` whenever the socket
 * (re)opens. See docs/privacy-mode-plan.md.
 */
export function usePrivacy(apiBaseUrl: string): PrivacyApi {
  const [state, setState] = useState<PrivacyState>(OFF)
  const [cooldownUntil, setCooldownUntil] = useState(0)
  const [cooldownMs, setCooldownMs] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/privacy`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isPrivacyState(data)) setState(data)
    } catch {
      // Offline: keep the last known state.
    }
  }, [apiBaseUrl])

  useEffect(() => {
    void refresh()
  }, [refresh])

  useAppSocket(apiBaseUrl, {
    onOpen: () => void refresh(),
    onMessage: (data) => {
      const message = data as unknown as PrivacyMessage
      if (message.type !== 'privacy' && !message.type?.startsWith('privacy-')) return
      if (isPrivacyState(message.privacy)) setState(message.privacy)
    },
  })

  // Tick the cooldown down to zero.
  useEffect(() => {
    if (cooldownUntil <= Date.now()) {
      setCooldownMs(0)
      return
    }
    const tick = () => {
      const left = cooldownUntil - Date.now()
      setCooldownMs(Math.max(0, left))
      if (left <= 0) window.clearInterval(id)
    }
    tick()
    const id = window.setInterval(tick, 500)
    return () => window.clearInterval(id)
  }, [cooldownUntil])

  const lock = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/privacy/lock`, { method: 'POST' })
      if (!response.ok) return false
      setState((await response.json()) as PrivacyState)
      return true
    } catch {
      return false
    }
  }, [apiBaseUrl])

  const unlock = useCallback(
    async (pin: string): Promise<UnlockResult> => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/privacy/unlock`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ pin }),
        })
        if (response.ok) {
          setState((await response.json()) as PrivacyState)
          return 'ok'
        }
        if (response.status === 429) {
          const secs = Number(response.headers.get('retry-after')) || 60
          setCooldownUntil(Date.now() + secs * 1000)
          return 'locked-out'
        }
        if (response.status === 409) return 'disabled'
        return 'bad-pin'
      } catch {
        return 'error'
      }
    },
    [apiBaseUrl],
  )

  const undo = useCallback(async (): Promise<boolean> => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/privacy/unlock/grace`, { method: 'POST' })
      if (!response.ok) return false
      setState((await response.json()) as PrivacyState)
      return true
    } catch {
      return false
    }
  }, [apiBaseUrl])

  return useMemo(
    () => ({
      locked: state.locked,
      since: state.since,
      available: state.available,
      lock,
      unlock,
      undo,
      cooldownMs,
    }),
    [state, lock, unlock, undo, cooldownMs],
  )
}
