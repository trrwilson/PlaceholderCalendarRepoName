export type ViewMode = 'home' | 'week' | 'month' | 'timer' | 'lists'
export type VoiceStatus =
  | 'idle'
  // Wake word is loaded and listening locally for the phrase. No session, no
  // cloud audio. Behaves like `idle` for every control; only the affordance
  // copy differs.
  | 'armed'
  | 'connecting'
  | 'listening'
  | 'thinking'
  | 'speaking'
  | 'error'
  | 'unavailable'

export interface VoiceTranscript {
  user: string
  assistant: string
}

/**
 * Where a failed turn broke, so the UI can say something useful and decide
 * whether a retry is worth offering:
 * - `disabled`   backend says voice is off / unconfigured (409) — not retryable
 * - `network`    couldn't reach the token endpoint or load the SDK
 * - `microphone` getUserMedia denied / no device / device busy
 * - `session`    the Gemini Live connection itself failed or dropped
 * - `unknown`    anything else
 */
export type VoiceErrorKind = 'disabled' | 'network' | 'microphone' | 'session' | 'unknown'

export interface VoiceError {
  kind: VoiceErrorKind
  message: string
}

/** What the voice agent is allowed to do to the on-screen dashboard. */
export interface DashboardActions {
  showView(view: ViewMode, date: Date | null): void
  focusDate(date: Date): void
  highlightEvent(query: string): { matched: boolean; title?: string; when?: string }
  /**
   * Change which household members' calendars are shown (the People filter).
   * `mode: 'only'` shows just `people`, `'all'` clears the filter, `'add'` /
   * `'remove'` adjust it. Entries are calendar ids or loose name matches.
   * View state only — never touches a provider.
   */
  setPeopleFilter(mode: 'only' | 'add' | 'remove' | 'all', people: string[]): {
    matched: string[]
    unmatched: string[]
  }
  /**
   * Open the on-screen PIN keypad so a household member can turn OFF privacy
   * mode. Voice can ask for the keypad but can never enter the PIN itself —
   * speaking it aloud would defeat the point. See docs/privacy-mode-plan.md.
   */
  requestPrivacyUnlock(): void
}
