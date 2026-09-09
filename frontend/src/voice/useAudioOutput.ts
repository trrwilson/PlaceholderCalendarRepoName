import { useCallback, useEffect, useState } from 'react'

import {
  type AudioOutputSelection,
  readAudioOutputSelection,
  writeAudioOutputSelection,
} from './audioOutput'
import { speakerOut, type SpeakerLinkStatus } from './speakerOut'

export interface AudioOutputDiagnostics {
  /** An Invoke host is configured, so "Invoke" is a real choice. */
  available: boolean
  /** The persisted choice: the local screen, or the Invoke over Wi-Fi. */
  selection: AudioOutputSelection
  /** Live link state from `SpeakerOut` (connection, backend-reported health). */
  status: SpeakerLinkStatus
}

/**
 * Owns the speaker-output choice: persists it per-browser (`AUDIO_OUTPUT_PREF_KEY`)
 * and pushes it into the one shared `SpeakerOut`, which opens / closes
 * `WS /api/voice/speaker` and mutes the local playout while the Invoke link is
 * live. Parallels `useAudioInput`. When no Invoke host is configured the choice
 * is forced back to `screen`.
 */
export function useAudioOutput({
  available,
  apiBaseUrl,
}: {
  available: boolean
  apiBaseUrl: string
}) {
  const [selection, setSelection] = useState<AudioOutputSelection>(readAudioOutputSelection)
  const [status, setStatus] = useState<SpeakerLinkStatus>(() => speakerOut.status())

  useEffect(() => speakerOut.onStatusChange(setStatus), [])

  const effective: AudioOutputSelection = available ? selection : 'screen'
  useEffect(() => {
    speakerOut.setRoute(effective, apiBaseUrl)
  }, [effective, apiBaseUrl])

  const choose = useCallback((next: AudioOutputSelection) => {
    writeAudioOutputSelection(next)
    setSelection(next)
  }, [])

  const diagnostics: AudioOutputDiagnostics = { available, selection: effective, status }
  return { diagnostics, choose }
}
