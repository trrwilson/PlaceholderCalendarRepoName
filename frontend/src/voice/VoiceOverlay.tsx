import type { VoiceError, VoiceStatus, VoiceTranscript } from './types'

const LABELS: Record<VoiceStatus, string> = {
  idle: '',
  armed: '',
  connecting: 'Connecting…',
  listening: 'Listening…',
  thinking: 'Thinking…',
  speaking: 'Mission Control',
  error: 'Voice unavailable',
  unavailable: '',
}

interface Props {
  status: VoiceStatus
  /** `wake` turns are acknowledged visually the instant the phrase is detected —
   *  the mic is already live, so "Listening" is honest even while `connecting`. */
  activationStyle?: 'ptt' | 'wake'
  transcript: VoiceTranscript
  error: VoiceError | null
  onStop: () => void
  onDismissError: () => void
}

/**
 * Transient voice status + transcript. Sits over the contextual rail rather than
 * occupying permanent space; the dashboard itself carries the substantive answer.
 */
export function VoiceOverlay({
  status,
  activationStyle = 'ptt',
  transcript,
  error,
  onStop,
  onDismissError,
}: Props) {
  if (status === 'idle' || status === 'armed' || status === 'unavailable') return null

  // A wake turn's mic is live from the moment the phrase is detected (the
  // detector runs on the shared mic), so "Listening" is truthful even before the
  // provider socket is open — unlike push-to-talk's "Connecting…".
  const wakeConnecting = status === 'connecting' && activationStyle === 'wake'
  const label = wakeConnecting ? 'Listening…' : LABELS[status]
  const showHint = (status === 'listening' || wakeConnecting) && !transcript.user

  return (
    <section
      className={`voice-overlay voice-${status}${activationStyle === 'wake' ? ' voice-wake' : ''}`}
      role="status"
      aria-live="polite"
    >
      <div className="voice-overlay-head">
        <span className="voice-pulse" aria-hidden="true" />
        <strong>{label}</strong>
        {status === 'listening' && (
          <button className="voice-action" onClick={onStop}>
            Stop
          </button>
        )}
        {status === 'error' && (
          <button className="voice-action" onClick={onDismissError}>
            Dismiss
          </button>
        )}
      </div>
      {status === 'error' && error && <p className="voice-error-text">{error.message}</p>}
      {transcript.user && (
        <p className="voice-said" data-tentative={status === 'listening'}>
          <span>You</span>
          {transcript.user}
        </p>
      )}
      {transcript.assistant && <p className="voice-reply">{transcript.assistant}</p>}
      {showHint && (
        <p className="voice-hint">Ask about today, this week, or what&rsquo;s next.</p>
      )}
    </section>
  )
}
