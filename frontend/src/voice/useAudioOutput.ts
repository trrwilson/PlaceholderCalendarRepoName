import { useCallback, useEffect, useRef, useState } from 'react'

import { micSource } from './audio'
import { canSelectAudioOutput } from './aecPlayback'
import {
  type AudioOutputDevice,
  type AudioOutputSelection,
  readAudioOutputSelection,
  resolveAudioOutput,
  toAudioOutputDevices,
  writeAudioOutputSelection,
} from './audioOutput'
import { setOutputSinkId } from './outputSink'

export interface AudioOutputDiagnostics {
  /** The browser can enumerate outputs and `setSinkId` (false in jsdom / Safari). */
  available: boolean
  /** Audio outputs from the most recent enumeration. Labels are blank until a mic grant exists. */
  devices: AudioOutputDevice[]
  /** The persisted choice: automatic, or a specific device. */
  selection: AudioOutputSelection
  /** A VB-CABLE render endpoint is currently present in the list. */
  vbCablePresent: boolean
  /** Human-readable summary of what playout is routed to right now. */
  routedLabel: string
}

const NO_DEVICES: AudioOutputDevice[] = []

/**
 * Owns the speaker choice: enumerates outputs, keeps the list fresh as devices
 * come and go and as a mic grant makes labels readable, and pushes the resolved
 * sink id to the shared output bus (`./outputSink`), which every playout element
 * built by `createEchoCancelledOutput` follows. The mirror of `useAudioInput`.
 *
 * `choose` persists the selection per-browser (`AUDIO_OUTPUT_PREF_KEY`). The
 * default, `{ mode: 'auto' }`, is the system default output stated explicitly so
 * it overrides Chromium's capture-device pairing.
 */
export function useAudioOutput() {
  const [devices, setDevices] = useState<AudioOutputDevice[]>(NO_DEVICES)
  const [selection, setSelection] = useState<AudioOutputSelection>(readAudioOutputSelection)
  const [routedLabel, setRoutedLabel] = useState('System default')
  const aliveRef = useRef(true)

  const available =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function' &&
    canSelectAudioOutput()

  const refresh = useCallback(async () => {
    if (!available) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (aliveRef.current) setDevices(toAudioOutputDevices(all))
    } catch {
      // keep the previous list
    }
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

  // Push the resolved sink to the shared output bus. `setOutputSinkId` no-ops
  // when nothing changed, so re-running this on every enumeration is cheap.
  useEffect(() => {
    if (!available) return
    const resolved = resolveAudioOutput(selection, devices)
    setOutputSinkId(resolved.sinkId)
    setRoutedLabel(resolved.label)
    console.info('[voice] speaker output', { sinkId: resolved.sinkId || '(system default)', reason: resolved.reason })
  }, [available, selection, devices])

  const choose = useCallback((next: AudioOutputSelection) => {
    writeAudioOutputSelection(next)
    setSelection(next)
  }, [])

  const diagnostics: AudioOutputDiagnostics = {
    available,
    devices,
    selection,
    vbCablePresent: devices.some((device) => device.isVbCable),
    routedLabel,
  }

  return { diagnostics, choose, refresh }
}
