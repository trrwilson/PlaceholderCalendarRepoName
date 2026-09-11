import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAppSocket } from '../realtime/useAppSocket'
import type { CameraGalleryMessage, CameraGallerySnapshot, StoredClip } from './types'

export interface CameraActivityApi {
  /** Newest-first, bounded. Empty when the feature is off or quiet. */
  clips: StoredClip[]
  sourceStatus: CameraGallerySnapshot['source_status']
  /** False when eufy is disabled (GET /api/household 409s) — the gallery
   * renders nothing in that case, same as every other optional capability. */
  available: boolean
}

const EMPTY: CameraGallerySnapshot = { clips: [], source_status: 'disabled', cameras_online: false }

const isSnapshot = (value: unknown): value is CameraGallerySnapshot =>
  !!value && typeof value === 'object' && Array.isArray((value as CameraGallerySnapshot).clips)

/**
 * The eufy clip gallery's live state. The backend is authoritative — it owns
 * the bridge connection and pushes every change over the shared `/api/ws`
 * connection; this hook reconciles from `GET /api/household` whenever the
 * socket (re)opens, mirroring `useDisplay`. See docs/eufy-sdk-integration.md.
 */
export function useCameraActivity(apiBaseUrl: string): CameraActivityApi {
  const [snapshot, setSnapshot] = useState<CameraGallerySnapshot>(EMPTY)
  const [available, setAvailable] = useState(false)

  const refresh = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/household`)
      if (response.status === 409) {
        setAvailable(false)
        setSnapshot(EMPTY)
        return
      }
      if (!response.ok) return
      const data: unknown = await response.json()
      if (isSnapshot(data)) {
        setAvailable(true)
        setSnapshot(data)
      }
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
      const message = data as unknown as CameraGalleryMessage
      if (message.type !== 'camera_clips' || !Array.isArray(message.camera_clips)) return
      setAvailable(true)
      setSnapshot((prev) => ({
        clips: message.camera_clips!,
        source_status: message.camera_status ?? prev.source_status,
        cameras_online: prev.cameras_online,
      }))
    },
  })

  return useMemo(
    () => ({ clips: snapshot.clips, sourceStatus: snapshot.source_status, available }),
    [snapshot, available],
  )
}
