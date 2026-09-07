// Fetches the session grant and constructs the matching conversational voice
// provider for a kiosk turn (see docs/voice-provider-bakeoff-plan.md).
//
// Gemini opens the Live session browser-direct with an ephemeral token; the
// Azure contestants go through the backend relay. `useVoiceSession` drives
// whichever it gets through the same `ConversationalVoiceProvider` interface and
// `VoiceEvent` stream — it never sees a wire protocol.

import type { VoiceTimeline } from '../instrument'
import { GeminiVoiceProvider } from './gemini'
import { fetchVoiceGrant } from './grant'
import { RelayVoiceProvider } from './relay'
import type { ConversationalVoiceProvider, VoiceEvent } from './types'

export type { ConversationalVoiceProvider, VoiceEvent, VoiceGrant } from './types'
export { VoiceSessionError, VoiceUnavailableError } from './types'

export async function createVoiceProvider(
  apiBaseUrl: string,
  onEvent: (event: VoiceEvent) => void,
  surface: string | null,
  timeline: VoiceTimeline,
): Promise<ConversationalVoiceProvider> {
  const grant = await fetchVoiceGrant(apiBaseUrl, surface, timeline)
  if (grant.provider === 'gemini') {
    return new GeminiVoiceProvider(grant, onEvent, timeline)
  }
  // azure_voice_live / azure_openai_realtime[_mini] — all relayed.
  return new RelayVoiceProvider(apiBaseUrl, grant, onEvent, timeline)
}
