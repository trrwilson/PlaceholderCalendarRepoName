// Mirrors backend/app/models.py `PhotoItem` / `PhotoStreamSnapshot` — keep
// field names in sync. See docs/photo-stream-plan.md.

export type PhotoStreamStatus = 'disabled' | 'starting' | 'ok' | 'needs_sign_in' | 'error'

export interface PhotoItem {
  id: string
  name: string
  width: number | null
  height: number | null
  taken_at: string | null
  version: string
  bytes: number
}

export interface PhotoStreamSnapshot {
  enabled: boolean
  status: PhotoStreamStatus
  photos: PhotoItem[]
  last_sync: string | null
  detail: string | null
}

export interface PhotoStreamMessage {
  type: string
  photos?: PhotoStreamSnapshot
}
