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
import { speakerOut, type SpeakerLinkStatus } from './speakerOut'

export interface AudioOutputDiagnostics {
  /** The browser can enumerate outputs and `setSinkId` (false in jsdom / Safari). */
  available: boolean
  /** An Invoke host is configured, so "Invoke (Wi-Fi)" is a real choice. */
  invokeAvailable: boolean
  /** Audio outputs from the most recent enumeration. Labels are blank until a mic grant exists. */
  devices: AudioOutputDevice[]
  /** The persisted choice: automatic, a specific device, or the Invoke. */
  selection: AudioOutputSelection
  /** A VB-CABLE render endpoint is currently present in the list. */
  vbCablePresent: boolean
  /** Human-readable summary of what playout is routed to right now. */
  routedLabel: string
  /** Live link state from `speakerOut` while routed to the Invoke. */
  invokeStatus: SpeakerLinkStatus
}

const NO_DEVICES: AudioOutputDevice[] = []

/**
 * Owns the speaker choice: enumerates outputs, keeps the list fresh, and routes
 * the appliance's output bus. A local pick drives `setSinkId` on the loopback
 * `<audio>` (`./outputSink`); `{ mode: 'invoke' }` streams the whole bus to the
 * Invoke over Wi-Fi (`./speakerOut`) and mutes the local playout. The mirror of
 * `useAudioInput`.
 *
 * `choose` persists the selection per-browser (`AUDIO_OUTPUT_PREF_KEY`). The
 * default, `{ mode: 'auto' }`, is the system default output stated explicitly so
 * it overrides Chromium's capture-device pairing.
 */
export function useAudioOutput({
  apiBaseUrl,
  invokeAvailable,
}: {
  apiBaseUrl: string
  invokeAvailable: boolean
}) {
  const [devices, setDevices] = useState<AudioOutputDevice[]>(NO_DEVICES)
  const [selection, setSelection] = useState<AudioOutputSelection>(readAudioOutputSelection)
  const [routedLabel, setRoutedLabel] = useState('System default')
  const [invokeStatus, setInvokeStatus] = useState<SpeakerLinkStatus>(() => speakerOut.status())
  const aliveRef = useRef(true)

  const canPickDevice =
    typeof navigator !== 'undefined' &&
    !!navigator.mediaDevices &&
    typeof navigator.mediaDevices.enumerateDevices === 'function' &&
    canSelectAudioOutput()

  // An `invoke` choice only holds while the backend still reports a host.
  const effective: AudioOutputSelection =
    selection.mode === 'invoke' && !invokeAvailable ? { mode: 'auto' } : selection

  const refresh = useCallback(async () => {
    if (!canPickDevice) return
    try {
      const all = await navigator.mediaDevices.enumerateDevices()
      if (aliveRef.current) setDevices(toAudioOutputDevices(all))
    } catch {
      // keep the previous list
    }
  }, [canPickDevice])

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

  useEffect(() => speakerOut.onStatusChange(setInvokeStatus), [])

  // Resolve the selection: route the bus to the Invoke or the screen, and (for a
  // screen pick) push the sink id to the shared output bus. `setOutputSinkId` /
  // `setRoute` no-op when nothing changed, so re-running this is cheap.
  useEffect(() => {
    const target = selection.mode === 'invoke' && !invokeAvailable ? { mode: 'auto' as const } : selection
    speakerOut.setRoute(target.mode === 'invoke' ? 'invoke' : 'screen', apiBaseUrl)
    const resolved = resolveAudioOutput(target, devices)
    if (canPickDevice && target.mode !== 'invoke') setOutputSinkId(resolved.sinkId)
    setRoutedLabel(resolved.label)
    console.info('[voice] speaker output', {
      sinkId: resolved.sinkId || '(system default)',
      reason: resolved.reason,
    })
  }, [canPickDevice, selection, invokeAvailable, devices, apiBaseUrl])

  const choose = useCallback((next: AudioOutputSelection) => {
    writeAudioOutputSelection(next)
    setSelection(next)
  }, [])

  const diagnostics: AudioOutputDiagnostics = {
    available: canPickDevice,
    invokeAvailable,
    devices,
    selection: effective,
    vbCablePresent: devices.some((device) => device.isVbCable),
    routedLabel,
    invokeStatus,
  }

  return { diagnostics, choose, refresh }
}
