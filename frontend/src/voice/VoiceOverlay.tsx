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
  transcript: VoiceTranscript
  error: VoiceError | null
  onStop: () => void
  onDismissError: () => void
}

/**
 * Transient voice status + transcript. Sits over the contextual rail rather than
 * occupying permanent space; the dashboard itself carries the substantive answer.
 */
export function VoiceOverlay({ status, transcript, error, onStop, onDismissError }: Props) {
  if (status === 'idle' || status === 'armed' || status === 'unavailable') return null

  return (
    <section className={`voice-overlay voice-${status}`} role="status" aria-live="polite">
      <div className="voice-overlay-head">
        <span className="voice-pulse" aria-hidden="true" />
        <strong>{LABELS[status]}</strong>
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
      {status === 'listening' && !transcript.user && (
        <p className="voice-hint">Ask about today, this week, or what&rsquo;s next.</p>
      )}
    </section>
  )
}
