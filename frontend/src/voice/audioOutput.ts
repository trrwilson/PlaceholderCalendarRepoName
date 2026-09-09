// Which speaker the appliance's own sounds come out of.
//
// The mirror of `./audioInput`: that module picks the capture device, this one
// picks the render device for everything `createEchoCancelledOutput` plays. The
// choice matters on the kiosk because the capture device is a VB-CABLE input and
// Chromium, left to itself, plays the loopback reply stream back into that same
// cable (the paired endpoint) instead of a real speaker — see
// docs/audio-pipeline.md → Output, and `./outputSink`.
//
// The choice is per-browser, stored under `AUDIO_OUTPUT_PREF_KEY`. "auto" — the
// default — is the system default output, but explicitly (an empty `sinkId`
// still overrides the capture-device pairing), and it steps off a default that
// is itself a VB-CABLE endpoint.

import { isVbCableLabel } from './audioInput'

/** localStorage key holding the speaker choice: `"auto"` or a JSON `{deviceId,label}`. */
export const AUDIO_OUTPUT_PREF_KEY = 'mission-control.audio-output'

/** One selectable speaker, distilled from `MediaDeviceInfo`. */
export interface AudioOutputDevice {
  deviceId: string
  /** Empty until the page has held a `getUserMedia` grant at least once. */
  label: string
  /** A VB-CABLE render endpoint ("CABLE Input …") — never a good output. */
  isVbCable: boolean
}

/** The persisted speaker choice. */
export type AudioOutputSelection =
  | { mode: 'auto' }
  | { mode: 'device'; deviceId: string; label: string }

/** How `useAudioOutput` should resolve the current selection into a `setSinkId`. */
export interface ResolvedAudioOutput {
  /** Value for `HTMLMediaElement.setSinkId`; `''` is the system default. */
  sinkId: string
  /** Human-readable summary, for diagnostics and logs. */
  label: string
  reason: 'auto-default' | 'auto-avoid-vb-cable' | 'selected' | 'selected-by-label' | 'selected-missing'
}

/** Read the speaker choice from localStorage; `auto` when unset or unreadable. */
export function readAudioOutputSelection(): AudioOutputSelection {
  try {
    const raw = localStorage.getItem(AUDIO_OUTPUT_PREF_KEY)
    if (!raw || raw === 'auto') return { mode: 'auto' }
    const parsed = JSON.parse(raw) as { deviceId?: unknown; label?: unknown }
    if (parsed && typeof parsed.deviceId === 'string' && parsed.deviceId) {
      return {
        mode: 'device',
        deviceId: parsed.deviceId,
        label: typeof parsed.label === 'string' ? parsed.label : '',
      }
    }
  } catch {
    // fall through to auto
  }
  return { mode: 'auto' }
}

/** Persist the speaker choice. Best effort — the in-memory choice still applies. */
export function writeAudioOutputSelection(selection: AudioOutputSelection): void {
  try {
    localStorage.setItem(
      AUDIO_OUTPUT_PREF_KEY,
      selection.mode === 'auto'
        ? 'auto'
        : JSON.stringify({ deviceId: selection.deviceId, label: selection.label }),
    )
  } catch {
    // best effort
  }
}

/** Audio outputs only, de-duplicated by id, from a raw `enumerateDevices()` result. */
export function toAudioOutputDevices(devices: MediaDeviceInfo[]): AudioOutputDevice[] {
  const seen = new Set<string>()
  const outputs: AudioOutputDevice[] = []
  for (const device of devices) {
    if (device.kind !== 'audiooutput' || !device.deviceId || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    const label = device.label || ''
    outputs.push({ deviceId: device.deviceId, label, isVbCable: isVbCableLabel(label) })
  }
  return outputs
}

/**
 * Turn the persisted selection plus the current device list into a concrete
 * `setSinkId` value.
 *
 * `auto` is the system default (`sinkId: ''`) — but if the browser's own
 * "default" entry is a VB-CABLE endpoint (which would send every appliance sound
 * into the cable), it steps to the first real output instead. An explicit device
 * is matched by id first, then by remembered label (ids rotate when the mic
 * permission is reset); a genuinely absent device is still returned so the
 * `setSinkId` rejection surfaces in the log rather than silently doing nothing.
 */
export function resolveAudioOutput(
  selection: AudioOutputSelection,
  devices: AudioOutputDevice[],
): ResolvedAudioOutput {
  if (selection.mode === 'auto') {
    const fallbackDefault: ResolvedAudioOutput = { sinkId: '', label: 'System default', reason: 'auto-default' }
    const browserDefault = devices.find((device) => device.deviceId === 'default')
    if (browserDefault?.isVbCable) {
      const real = devices.find((device) => !device.isVbCable && device.deviceId !== 'default')
      if (real) {
        return { sinkId: real.deviceId, label: real.label || 'Speaker', reason: 'auto-avoid-vb-cable' }
      }
    }
    return fallbackDefault
  }

  const byId = devices.find((device) => device.deviceId === selection.deviceId)
  if (byId) {
    return { sinkId: byId.deviceId, label: byId.label || selection.label || 'Selected speaker', reason: 'selected' }
  }

  if (selection.label) {
    const byLabel = devices.find((device) => device.label && device.label === selection.label)
    if (byLabel) {
      return { sinkId: byLabel.deviceId, label: byLabel.label, reason: 'selected-by-label' }
    }
  }

  return {
    sinkId: selection.deviceId,
    label: selection.label || 'Selected speaker',
    reason: 'selected-missing',
  }
}
