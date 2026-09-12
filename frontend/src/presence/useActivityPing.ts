import { useEffect, useRef } from 'react'

// Matches docs/display-dimming-plan.md's activity seam ("throttled client-side
// to ~1 per 10s"): comfortably under `display_dim_after_seconds` (20s) so any
// burst of touches keeps resetting the backend's idle-dim countdown before it
// elapses, without a network request on every single tap.
const THROTTLE_MS = 10_000

/**
 * Kiosk touch is a presence signal too — not just the camera. Pings
 * `POST /api/presence/activity` on pointer input so
 * `app/presence/display_policy.py`'s idle-dim countdown resets while someone
 * is actively using the panel, the same way a voice turn already does
 * server-side (`note_activity(ActivitySource.voice)`). Best-effort and fire-
 * and-forget: a dropped ping just means the next tap tries again.
 */
export function useActivityPing(apiBaseUrl: string): void {
  const lastSentAt = useRef(0)

  useEffect(() => {
    const ping = () => {
      const now = Date.now()
      if (now - lastSentAt.current < THROTTLE_MS) return
      lastSentAt.current = now
      fetch(`${apiBaseUrl}/api/presence/activity`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ source: 'touch' }),
      }).catch(() => {
        // Offline / backend down: presence pings are best-effort.
      })
    }
    document.addEventListener('pointerdown', ping)
    return () => document.removeEventListener('pointerdown', ping)
  }, [apiBaseUrl])
}
