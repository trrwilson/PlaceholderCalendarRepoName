// Mirrors backend/app/models.py `StoredClip` / `CameraGallerySnapshot` — keep
// field names in sync. See docs/eufy-sdk-integration.md.

export type EufySourceStatus = 'connected' | 'connecting' | 'needs_signin' | 'disabled' | 'error'

export interface StoredClip {
  clip_id: string
  camera_id: string
  camera_name: string
  occurred_at: string
  approx_duration_seconds: number | null
  has_thumbnail: boolean
}

export interface CameraGallerySnapshot {
  clips: StoredClip[]
  source_status: EufySourceStatus
  cameras_online: boolean
}

export interface CameraGalleryMessage {
  type: string
  camera_clips?: StoredClip[]
  camera_status?: EufySourceStatus
}
