import type { VoiceTimeline } from '../instrument'
import { type VoiceGrant, VoiceSessionError, VoiceUnavailableError } from './types'

/** Local wall-clock time as `YYYY-MM-DDTHH:mm:ss` with no timezone offset. */
function localIsoNow(): string {
  const d = new Date()
  const p = (n: number) => String(n).padStart(2, '0')
  return (
    `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}` +
    `T${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`
  )
}

/**
 * Ask the backend for a session grant. Provider-neutral: the response says which
 * provider (`grant.provider`) and carries whatever that provider's client needs
 * (a Gemini ephemeral token, or a relay ticket).
 */
export async function fetchVoiceGrant(
  apiBaseUrl: string,
  surface: string | null,
  timeline: VoiceTimeline,
): Promise<VoiceGrant> {
  timeline.mark('token-request')
  let response: Response
  try {
    response = await fetch(`${apiBaseUrl}/api/voice/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        surface,
        // The backend may run in UTC; the assistant's "today" must be the
        // kiosk's local day. Send local wall-clock time (no offset) plus the
        // zone name as a label.
        client_time: localIsoNow(),
        timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      }),
    })
  } catch {
    throw new VoiceSessionError('network', 'Could not reach the voice service.')
  }
  if (response.status === 409) {
    const detail = (await response.json().catch(() => ({}))).detail
    throw new VoiceUnavailableError(detail ?? 'voice support is unavailable')
  }
  if (!response.ok) {
    throw new VoiceSessionError('network', `Voice token request failed (${response.status}).`)
  }
  const grant: VoiceGrant = await response.json()
  timeline.mark('token-received', {
    provider: grant.provider,
    model: grant.model,
    apiVersion: grant.api_version,
    manualActivity: grant.manual_activity ?? false,
  })
  return grant
}
