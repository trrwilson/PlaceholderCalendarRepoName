// Which microphone the shared capture pipeline opens.
//
// `MicSource` (`./audio`) still owns exactly one `getUserMedia` stream — this
// module only decides which input device that stream asks for. The kiosk box has
// more than one: the physical far-field mic, and — when a recovered HK Invoke
// speaker is bridged in over VB-CABLE — a virtual "CABLE Output" device carrying
// that feed. See docs/audio-pipeline.md.
//
// The choice is per-browser (it is a property of the machine, like the wake-word
// on/off switch — docs/audio-pipeline.md, "Per-browser localStorage switches"),
// stored under `AUDIO_INPUT_PREF_KEY`. "auto" — the default, and the value for a
// kiosk that has never been touched — prefers a VB-CABLE input when one is
// present and otherwise lets the OS pick.

/** localStorage key holding the microphone choice: `"auto"` or a JSON `{deviceId,label}`. */
export const AUDIO_INPUT_PREF_KEY = 'mission-control.audio-input'

// VB-Audio's virtual cable presents its capture endpoint under a handful of
// names depending on driver version and which cable ("CABLE Output", "CABLE-A
// Output", "VB-Audio Virtual Cable", "VB-CABLE"). Match any of them.
const VB_CABLE_PATTERN = /vb[-\s]?cable|vb-audio|cable[-\s]?[a-d]?\s*output/i

/** True when a device label looks like a VB-CABLE capture endpoint. */
export function isVbCableLabel(label: string): boolean {
  return VB_CABLE_PATTERN.test(label)
}

/** One selectable microphone, distilled from `MediaDeviceInfo`. */
export interface AudioInputDevice {
  deviceId: string
  /** Empty until the page has held a `getUserMedia` grant at least once. */
  label: string
  isVbCable: boolean
}

/** The persisted microphone choice. */
export type AudioInputSelection =
  | { mode: 'auto' }
  | { mode: 'device'; deviceId: string; label: string }

/** How `MicSource` should resolve the current selection into a `getUserMedia` request. */
export interface ResolvedAudioInput {
  /** deviceId to request, or `null` for the OS default. */
  deviceId: string | null
  /** `true` → request it as `{exact}` so a missing device fails visibly rather than
   *  silently recording the wrong microphone; `false` → `{ideal}`, best effort. */
  strict: boolean
  /** Human-readable summary, for diagnostics and logs. */
  label: string
  reason: 'auto-vb-cable' | 'auto-default' | 'selected' | 'selected-by-label' | 'selected-missing'
}

/** Read the microphone choice from localStorage; `auto` when unset or unreadable. */
export function readAudioInputSelection(): AudioInputSelection {
  try {
    const raw = localStorage.getItem(AUDIO_INPUT_PREF_KEY)
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

/** Persist the microphone choice. Best effort — the in-memory choice still applies. */
export function writeAudioInputSelection(selection: AudioInputSelection): void {
  try {
    localStorage.setItem(
      AUDIO_INPUT_PREF_KEY,
      selection.mode === 'auto'
        ? 'auto'
        : JSON.stringify({ deviceId: selection.deviceId, label: selection.label }),
    )
  } catch {
    // best effort
  }
}

/** Audio inputs only, de-duplicated by id, from a raw `enumerateDevices()` result. */
export function toAudioInputDevices(devices: MediaDeviceInfo[]): AudioInputDevice[] {
  const seen = new Set<string>()
  const inputs: AudioInputDevice[] = []
  for (const device of devices) {
    if (device.kind !== 'audioinput' || !device.deviceId || seen.has(device.deviceId)) continue
    seen.add(device.deviceId)
    const label = device.label || ''
    inputs.push({ deviceId: device.deviceId, label, isVbCable: isVbCableLabel(label) })
  }
  return inputs
}

/**
 * Turn the persisted selection plus the current device list into a concrete
 * `getUserMedia` request.
 *
 * `auto` prefers a VB-CABLE input (by label — so it only takes effect once the
 * page has held a mic grant and labels are readable) and otherwise defers to the
 * OS. An explicit device is matched by id first, then by remembered label
 * (deviceIds rotate when the mic permission is reset or the device is replugged);
 * if it is genuinely absent the request is still made strictly, so a
 * misconfiguration surfaces as a mic error rather than a silently wrong capture.
 */
export function resolveAudioInput(
  selection: AudioInputSelection,
  devices: AudioInputDevice[],
): ResolvedAudioInput {
  if (selection.mode === 'auto') {
    const cable = devices.find((device) => device.isVbCable)
    if (cable) {
      return {
        deviceId: cable.deviceId,
        strict: false,
        label: cable.label || 'VB-CABLE',
        reason: 'auto-vb-cable',
      }
    }
    return { deviceId: null, strict: false, label: 'System default', reason: 'auto-default' }
  }

  const byId = devices.find((device) => device.deviceId === selection.deviceId)
  if (byId) {
    return {
      deviceId: byId.deviceId,
      strict: true,
      label: byId.label || selection.label || 'Selected microphone',
      reason: 'selected',
    }
  }

  if (selection.label) {
    const byLabel = devices.find((device) => device.label && device.label === selection.label)
    if (byLabel) {
      return { deviceId: byLabel.deviceId, strict: true, label: byLabel.label, reason: 'selected-by-label' }
    }
  }

  return {
    deviceId: selection.deviceId,
    strict: true,
    label: selection.label || 'Selected microphone',
    reason: 'selected-missing',
  }
}
