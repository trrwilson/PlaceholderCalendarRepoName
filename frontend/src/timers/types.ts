// Mirrors the Timer models in backend/app/models.py — keep the field names
// (snake_case) in sync with that file.

export type TimerState = 'running' | 'paused' | 'fired' | 'dismissed'

export interface Timer {
  id: string
  label: string | null
  created_at: string
  fires_at: string
  duration_seconds: number
  state: TimerState
  /** Frozen seconds left; present only while `state` is `paused`. */
  remaining_seconds?: number | null
}

export interface TimerMutationResult {
  timer: Timer
  replaced: Timer | null
}

/** The server→client envelope (backend ApplicationMessage), timer fields only. */
export interface TimerMessage {
  type: string
  message: string
  timers?: Timer[]
  timer?: Timer | null
  replaced?: Timer | null
}

/** The six-hour product ceiling, mirrored from backend TIMER_MAX_SECONDS. */
export const TIMER_MAX_SECONDS = 21_600
/** Storage resolution minimum, mirrored from backend TIMER_MIN_SECONDS. */
export const TIMER_MIN_SECONDS = 5
/**
 * How long the alarm chime loops before it stops on its own; the visual
 * "Timer finished" state persists until dismissed. Mirrors the backend
 * MISSION_CONTROL_TIMER_ALARM_MAX_RING_SECONDS default.
 */
export const ALARM_MAX_RING_MS = 300_000
