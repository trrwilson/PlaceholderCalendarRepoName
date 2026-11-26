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
  // Best-effort display/detail metadata; absent on many photos.
  caption?: string | null
  place?: string | null
  place_detail?: string | null
  latitude?: number | null
  longitude?: number | null
  camera_make?: string | null
  camera_model?: string | null
  f_number?: number | null
  exposure_seconds?: number | null
  iso?: number | null
  focal_length_mm?: number | null
  tags?: string[]
  added_at?: string | null
  original_type?: string | null
  original_bytes?: number | null
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
