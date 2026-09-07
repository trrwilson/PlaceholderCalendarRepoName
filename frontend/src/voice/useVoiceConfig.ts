import { useCallback, useEffect, useRef, useState } from 'react'

import { micSource } from './audio'
import { DEFAULT_INPUT_GAIN_DB } from './gain'

/** Mirrors the backend `VoiceProviderInfo`. */
export interface VoiceProviderInfo {
  id: string
  label: string
  implemented: boolean
  configured: boolean
}

/** Mirrors the backend `VoiceConfig` (GET /api/voice/config). */
export interface VoiceConfigResponse {
  enabled: boolean
  provider: string
  providers: VoiceProviderInfo[]
  /**
   * Amplitude gain, in dB, the kiosk applies to captured microphone audio before
   * wake-word detection and before it is streamed to the provider (0 disables).
   * A property of the shared capture pipeline, not of any one provider — hence
   * delivered on this always-safe endpoint.
   */
  mic_input_gain_db: number
}

const EMPTY: VoiceConfigResponse = {
  enabled: false,
  provider: 'gemini',
  providers: [],
  mic_input_gain_db: DEFAULT_INPUT_GAIN_DB,
}

function looksValid(value: unknown): value is VoiceConfigResponse {
  const v = value as Partial<VoiceConfigResponse> | null
  return !!v && typeof v.enabled === 'boolean' && Array.isArray(v.providers)
}

/**
 * The active conversational voice provider and the bake-off switch for it
 * (`docs/voice-provider-bakeoff-plan.md`). `setProvider` PUTs the choice — a
 * process-memory override on the backend, applied to the next turn — and
 * refetches. A missing / malformed response is treated as "voice config
 * unavailable" (`enabled: false`), so Settings simply omits the section, exactly
 * like `useWakeWord`.
 */
export function useVoiceConfig(apiBaseUrl: string) {
  const [config, setConfig] = useState<VoiceConfigResponse>(EMPTY)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/voice/config`)
      const body: unknown = response.ok ? await response.json() : null
      if (aliveRef.current) setConfig(looksValid(body) ? body : EMPTY)
    } catch {
      if (aliveRef.current) setConfig(EMPTY)
    }
  }, [apiBaseUrl])

  useEffect(() => {
    aliveRef.current = true
    void load()
    return () => {
      aliveRef.current = false
    }
  }, [load])

  // Push the configured capture gain down to the shared microphone — the single
  // path by which the backend setting reaches the one gain stage. Applies even
  // when voice is disabled (wake word may still be listening); `EMPTY` carries
  // `DEFAULT_INPUT_GAIN_DB` so an unreachable or malformed backend keeps a
  // sensible boost rather than dropping to unity.
  useEffect(() => {
    const db = config.mic_input_gain_db
    micSource.setInputGainDb(Number.isFinite(db) ? db : DEFAULT_INPUT_GAIN_DB)
  }, [config.mic_input_gain_db])

  const setProvider = useCallback(
    async (provider: string) => {
      setBusy(true)
      try {
        const response = await fetch(`${apiBaseUrl}/api/voice/config`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ provider }),
        })
        const body: unknown = response.ok ? await response.json() : null
        if (aliveRef.current && looksValid(body)) setConfig(body)
        else await load()
      } catch {
        await load()
      } finally {
        if (aliveRef.current) setBusy(false)
      }
    },
    [apiBaseUrl, load],
  )

  return { config, busy, setProvider, reload: load }
}
