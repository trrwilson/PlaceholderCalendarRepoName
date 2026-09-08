import { useCallback, useEffect, useRef, useState } from 'react'

import { micSource } from './audio'
import {
  type AudioInputDevice,
  type AudioInputSelection,
  readAudioInputSelection,
  resolveAudioInput,
  toAudioInputDevices,
  writeAudioInputSelection,
} from './audioInput'

export interface AudioInputDiagnostics {
  /** The browser can enumerate and select input devices (false in jsdom / locked-down runtimes). */
  available: boolean
  /** Audio inputs from the most recent enumeration. Labels are blank until a mic grant exists. */
  devices: AudioInputDevice[]
  /** The persisted choice: automatic, or a specific device. */
  selection: AudioInputSelection
  /** A VB-CABLE capture endpoint is currently present. */
  vbCablePresent: boolean
  /** What the shared mic is actually bound to right now (null before the first stream). */
  boundLabel: string | null
}

const NO_DEVICES: AudioInputDevice[] = []

/**
 * Owns the microphone-device choice: enumerates inputs, keeps the list fresh as
 * devices come and go and as mic grants make labels readable, and pushes the
 * resolved device down to the one shared `MicSource` — the single path from this
 * choice to `getUserMedia`. Runs even when voice is disabled, since wake word may
 * still be listening on the shared stream (mirrors `useVoiceConfig`'s gain push).
 *
 * `choose` persists the selection per-browser (`AUDIO_INPUT_PREF_KEY`). The
 * default, `{ mode: 'auto' }`, prefers a VB-CABLE input when one is present.
 */
export function useAudioInput() {
  const [devices, setDevices] = useState<AudioInputDevice[]>(NO_DEVICES)
  const [selection, setSelection] = useState<AudioInputSelection>(readAudioInputSelection)
  const [boundLabel, setBoundLabel] = useState<string | null>(null)
  const aliveRef = useRef(true)

  const available =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function'

  const refresh = useCallback(async () => {
    if (!available) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (aliveRef.current) setDevices(toAudioInputDevices(all))
    } catch {
      // keep the previous list
    }
    if (aliveRef.current) setBoundLabel(micSource.boundInputLabel())
  }, [available])

  useEffect(() => {
    aliveRef.current = true
    void refresh()
    const unsubscribeStream = micSource.onStreamChange(() => void refresh())
    const onDeviceChange = () => void refresh()
    navigator.mediaDevices?.addEventListener?.('devicechange', onDeviceChange)
    return () => {
      aliveRef.current = false
      unsubscribeStream()
      navigator.mediaDevices?.removeEventListener?.('devicechange', onDeviceChange)
    }
  }, [refresh])

  // Push the resolved device to the shared mic. `setInputDeviceId` no-ops when
  // nothing changed, so re-running this on every enumeration is cheap.
  useEffect(() => {
    if (!available) return
    const resolved = resolveAudioInput(selection, devices)
    micSource.setInputDeviceId(resolved.deviceId, resolved.strict)
  }, [available, selection, devices])

  const choose = useCallback((next: AudioInputSelection) => {
    writeAudioInputSelection(next)
    setSelection(next)
  }, [])

  const diagnostics: AudioInputDiagnostics = {
    available,
    devices,
    selection,
    vbCablePresent: devices.some((device) => device.isVbCable),
    boundLabel,
  }

  return { diagnostics, choose, refresh }
}
