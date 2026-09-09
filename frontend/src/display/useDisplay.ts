import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { DisplayMessage, DisplayState } from './types'

const isDisplayState = (value: unknown): value is DisplayState =>
  !!value && typeof value === 'object' && typeof (value as DisplayState).brightness === 'number'

export interface DisplayApi {
  /** Current target brightness, 0-100. */
  brightness: number
  /** The level night mode restores to (captured when it was switched on). */
  reference: number
  nightMode: boolean
  /** Effector in use; `none` on any host not colocated with the kiosk. */
  mechanism: DisplayState['mechanism']
  setNightMode: (on: boolean) => Promise<void>
  setBrightness: (pct: number) => Promise<void>
}

const OFF: DisplayState = {
  brightness: 100,
  reference_brightness: 100,
  night_mode: false,
  mechanism: 'none',
  colocated: false,
  available: false,
  last_error: null,
}

/**
 * Owns the physical panel's brightness / night-mode state. The backend is
 * authoritative — a browser tab cannot set Windows brightness — and pushes every
 * change over the shared `/api/ws` connection; this hook reconciles from
 * `GET /api/display` whenever the socket (re)opens. See
 * docs/display-dimming-plan.md.
 */
export function useDisplay(apiBaseUrl: string): DisplayApi {
  const [state, setState] = useState<DisplayState>(OFF)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/display`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isDisplayState(data)) setState(data)
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
      const message = data as unknown as DisplayMessage
      if (message.type !== 'display' && !message.type?.startsWith('display-')) return
      if (isDisplayState(message.display)) setState(message.display)
    },
  })

  const put = useCallback(
    async (body: Record<string, unknown>) => {
      try {
        const response = await fetch(`${apiBaseUrl}/api/display`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
        if (response.ok) {
          const data: unknown = await response.json()
          if (isDisplayState(data)) setState(data)
        }
      } catch {
        // The ws echo / next reconcile will catch up if the request was lost.
      }
    },
    [apiBaseUrl],
  )

  const setNightMode = useCallback((on: boolean) => put({ night_mode: on }), [put])
  const setBrightness = useCallback((pct: number) => put({ brightness: pct }), [put])

  return useMemo(
    () => ({
      brightness: state.brightness,
      reference: state.reference_brightness,
      nightMode: state.night_mode,
      mechanism: state.mechanism,
      setNightMode,
      setBrightness,
    }),
    [state, setNightMode, setBrightness],
  )
}
