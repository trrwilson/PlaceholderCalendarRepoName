// Mirrors backend/app/models.py `DisplayState` — keep field names in sync.

export type DisplayMechanism = 'wmi' | 'ddcci' | 'none'

export interface DisplayState {
  brightness: number
  reference_brightness: number
  night_mode: boolean
  mechanism: DisplayMechanism
  colocated: boolean
  available: boolean
  last_error: string | null
}

export interface DisplayMessage {
  type: string
  display?: DisplayState
}
