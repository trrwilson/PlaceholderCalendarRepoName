import { useCallback, useEffect, useRef, useState } from 'react'

import { PIN_LENGTH, type UnlockResult } from './types'

interface Props {
  onClose: () => void
  onUnlock: (pin: string) => Promise<UnlockResult>
  /** Present only within the no-PIN grace window right after entry. */
  onUndo?: () => void
  cooldownMs: number
}

// Calculator layout — 7-8-9 / 4-5-6 / 1-2-3 / 0. The default PIN 8426 traces
// up-left-down-right on it (8 top, 4 left, 2 bottom, 6 right). See resolution 4
// in docs/privacy-mode-plan.md.
const KEYS = ['7', '8', '9', '4', '5', '6', '1', '2', '3'] as const

/**
 * The only way out of privacy mode: a fixed four-digit keypad, no text input
 * (the kiosk has no keyboard). Auto-submits on the fourth digit; a wrong PIN
 * shakes and clears; too many wrong tries disables the pad for a cooldown.
 */
export function PrivacyPad({ onClose, onUnlock, onUndo, cooldownMs }: Props) {
  const [digits, setDigits] = useState('')
  const [shake, setShake] = useState(false)
  const [message, setMessage] = useState<string | null>(null)
  const busyRef = useRef(false)
  const cooling = cooldownMs > 0

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [onClose])

  const submit = useCallback(
    async (pin: string) => {
      busyRef.current = true
      const result = await onUnlock(pin)
      busyRef.current = false
      if (result === 'ok') return onClose()
      setDigits('')
      setShake(true)
      window.setTimeout(() => setShake(false), 420)
      setMessage(
        result === 'locked-out'
          ? 'Too many tries — wait a moment.'
          : result === 'disabled'
            ? 'Privacy mode is not set up.'
            : 'That PIN is not right.',
      )
    },
    [onClose, onUnlock],
  )

  const press = useCallback(
    (key: string) => {
      if (cooling || busyRef.current || digits.length >= PIN_LENGTH) return
      setMessage(null)
      const next = digits + key
      setDigits(next)
      if (next.length === PIN_LENGTH) void submit(next)
    },
    [cooling, digits, submit],
  )

  return (
    <div className="detail-scrim" role="presentation" onClick={onClose}>
      <section
        className={`detail-sheet privacy-pad ${shake ? 'privacy-pad-shake' : ''}`}
        role="dialog"
        aria-label="Turn off privacy mode"
        onClick={(event) => event.stopPropagation()}
      >
        <button className="close-detail" onClick={onClose} aria-label="Close">
          ×
        </button>
        <p className="section-kicker">Privacy mode</p>
        <h2>Enter your PIN to turn it off</h2>

        <div className="privacy-pad-dots" aria-hidden>
          {Array.from({ length: PIN_LENGTH }, (_, index) => (
            <span key={index} className={index < digits.length ? 'filled' : ''} />
          ))}
        </div>
        {message && <p className="privacy-pad-message">{message}</p>}
        {cooling && (
          <p className="privacy-pad-message">
            Locked for {Math.ceil(cooldownMs / 1000)}s
          </p>
        )}

        <div className="privacy-pad-keys">
          {KEYS.map((key) => (
            <button
              key={key}
              className="privacy-key"
              disabled={cooling}
              onClick={() => press(key)}
              aria-label={key}
            >
              {key}
            </button>
          ))}
          <span className="privacy-key-spacer" aria-hidden />
          <button
            className="privacy-key"
            disabled={cooling}
            onClick={() => press('0')}
            aria-label="0"
          >
            0
          </button>
          <button
            className="privacy-key privacy-key-back"
            disabled={cooling || digits.length === 0}
            onClick={() => setDigits((current) => current.slice(0, -1))}
            aria-label="Delete"
          >
            ⌫
          </button>
        </div>

        {onUndo && (
          <button className="privacy-pad-undo quiet-action" onClick={onUndo}>
            That was a mistake — turn it back off
          </button>
        )}
      </section>
    </div>
  )
}
