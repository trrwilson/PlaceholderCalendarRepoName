import { useEffect } from 'react'

import type { VoiceError, VoiceErrorKind } from './types'

const HEADLINE: Record<VoiceErrorKind, string> = {
  disabled: 'Voice is turned off',
  network: 'Can’t reach the voice service',
  microphone: 'Microphone problem',
  session: 'Voice connection failed',
  unknown: 'Voice is unavailable',
}

const AUTO_DISMISS_MS = 10_000

interface Props {
  error: VoiceError
  onRetry: () => void
  onDismiss: () => void
}

/**
 * Transient announcement shown when a failure has just switched the Ask button
 * off. Auto-dismisses; the button's own "Voice off" state is the durable signal.
 * Offers a retry for everything except a hard `disabled` result from the backend.
 */
export function VoiceToast({ error, onRetry, onDismiss }: Props) {
  useEffect(() => {
    const id = window.setTimeout(onDismiss, AUTO_DISMISS_MS)
    return () => window.clearTimeout(id)
  }, [error, onDismiss])

  return (
    <div className="voice-toast" role="alert">
      <div className="voice-toast-body">
        <strong>{HEADLINE[error.kind]}</strong>
        <span>{error.message}</span>
      </div>
      {error.kind !== 'disabled' && (
        <button className="voice-toast-retry" onClick={onRetry}>
          Try again
        </button>
      )}
      <button className="voice-toast-close" onClick={onDismiss} aria-label="Dismiss voice message">
        ×
      </button>
    </div>
  )
}
