import { useEffect, useState } from 'react'

// A tiny module-level "how many dialogs currently own speech input" counter —
// deliberately not a React context, so any full-screen dialog anywhere in the
// tree (today: the notes PTT modal; AGENTS.md non-goals rule out speculative
// abstraction, but this one is already needed twice as designed: creating a
// note and editing one) can opt in with one hook call and no provider wiring.
// `useVoiceSession` is the single reader — see its `suppressed` option.
let count = 0
const listeners = new Set<() => void>()

function notify(): void {
  for (const listener of listeners) listener()
}

/**
 * Call with `true` for the lifetime a dialog should own speech input: the
 * global wake-word detector suspends (exactly as it does mid-turn) and the Ask
 * button / a wake detection cannot open a new turn while any dialog holds this.
 * Safe to call from more than one dialog at once.
 */
export function useSuppressVoice(active: boolean): void {
  useEffect(() => {
    if (!active) return
    count += 1
    notify()
    return () => {
      count -= 1
      notify()
    }
  }, [active])
}

/** True while at least one dialog holds `useSuppressVoice(true)`. */
export function useVoiceSuppressed(): boolean {
  const [suppressed, setSuppressed] = useState(() => count > 0)
  useEffect(() => {
    const listener = () => setSuppressed(count > 0)
    listeners.add(listener)
    listener()
    return () => {
      listeners.delete(listener)
    }
  }, [])
  return suppressed
}
