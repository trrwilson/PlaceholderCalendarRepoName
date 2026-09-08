// Mirrors PrivacyState in backend/app/models.py — keep field names in sync.
// See docs/privacy-mode-plan.md.

export interface PrivacyState {
  locked: boolean
  /** naive local ISO string, or null while unlocked. Advisory only. */
  since: string | null
  /** true only when an unlock PIN is configured on the backend. */
  available: boolean
}

/** The server→client envelope (backend ApplicationMessage), privacy field only. */
export interface PrivacyMessage {
  type: string
  message: string
  privacy?: PrivacyState | null
}

export type UnlockResult = 'ok' | 'bad-pin' | 'locked-out' | 'disabled' | 'error'

/** MVP: a fixed four-digit PIN on a 0-9 keypad (see resolution 4). */
export const PIN_LENGTH = 4
