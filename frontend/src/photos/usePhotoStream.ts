import { useCallback, useEffect, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { PhotoStreamMessage, PhotoStreamSnapshot } from './types'

const DISABLED: PhotoStreamSnapshot = { enabled: false, status: 'disabled', photos: [], last_sync: null, detail: null }

const isSnapshot = (value: unknown): value is PhotoStreamSnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as PhotoStreamSnapshot).photos)

/**
 * The household photo stream. The backend owns the OneDrive mirror and pushes a
 * full snapshot on `/api/ws` after any sync that changed it; this hook
 * reconciles from `GET /api/photos` whenever the socket (re)opens, the same
 * shape as `useCameraActivity`. See docs/photo-stream-plan.md.
 */
export function usePhotoStream(apiBaseUrl: string): PhotoStreamSnapshot {
  const [snapshot, setSnapshot] = useState<PhotoStreamSnapshot>(DISABLED)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/photos`)
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isSnapshot(data)) setSnapshot(data)
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
      const message = data as unknown as PhotoStreamMessage
      if (message.type === 'photos' && isSnapshot(message.photos)) setSnapshot(message.photos)
    },
  })

  return snapshot
}

/** URL for one cached photo; `version` busts the browser cache when it changes. */
export function photoUrl(apiBaseUrl: string, id: string, version: string): string {
  return `${apiBaseUrl}/api/photos/${encodeURIComponent(id)}?v=${encodeURIComponent(version)}`
}
