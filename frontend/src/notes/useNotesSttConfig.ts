import { useCallback, useEffect, useRef, useState } from 'react'

/** Mirrors the backend `NotesSttProviderInfo`. */
export interface NotesSttProviderInfo {
  id: string
  label: string
  configured: boolean
}

/** Mirrors the backend `NotesSttConfig` (GET /api/notes/stt-config). */
export interface NotesSttConfigResponse {
  provider: string
  providers: NotesSttProviderInfo[]
}

const EMPTY: NotesSttConfigResponse = { provider: 'gemini', providers: [] }

function looksValid(value: unknown): value is NotesSttConfigResponse {
  const v = value as Partial<NotesSttConfigResponse> | null
  return !!v && typeof v.provider === 'string' && Array.isArray(v.providers)
}

/**
 * The active notes-dictation provider and the bake-off switch for it — the
 * Settings-picker peer of `useVoiceConfig`, but for the Home notes pane's
 * push-to-talk mic (its own switch from the conversational assistant
 * provider; see backend/app/notes_stt.py). A missing/malformed response is
 * treated as "unavailable" (`providers: []`), so Settings simply omits the
 * section, exactly like `useVoiceConfig`.
 */
export function useNotesSttConfig(apiBaseUrl: string) {
  const [config, setConfig] = useState<NotesSttConfigResponse>(EMPTY)
  const [busy, setBusy] = useState(false)
  const aliveRef = useRef(true)

  const load = useCallback(async () => {
    try {
      const response = await fetch(`${apiBaseUrl}/api/notes/stt-config`)
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

  const setProvider = useCallback(
    async (provider: string) => {
      setBusy(true)
      try {
        const response = await fetch(`${apiBaseUrl}/api/notes/stt-config`, {
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
