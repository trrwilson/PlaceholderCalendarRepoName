// Where the appliance's output bus plays: the local screen, or the Invoke over
// Wi-Fi. Everything the kiosk renders — assistant replies, the listening cue,
// the timer chime — goes through `createEchoCancelledOutput` (docs/audio-
// pipeline.md, "Output"); this module only decides whether that audio is *also*
// streamed to `WS /api/voice/speaker` (and the local playout muted).
//
// The choice is per-browser, like the microphone choice — it is a property of
// the machine, not a household setting, so there is no backend setting for it
// (the backend only reports whether an Invoke host is configured at all). Stored
// under `AUDIO_OUTPUT_PREF_KEY`. "screen" is the default and the value for a
// kiosk that has never been touched.

/** localStorage key holding the speaker-output choice: `"screen"` or `"invoke"`. */
export const AUDIO_OUTPUT_PREF_KEY = 'mission-control.audio-output'

/** The persisted speaker-output choice. */
export type AudioOutputSelection = 'screen' | 'invoke'

/** Read the choice from localStorage; `screen` when unset or unreadable. */
export function readAudioOutputSelection(): AudioOutputSelection {
  try {
    return localStorage.getItem(AUDIO_OUTPUT_PREF_KEY) === 'invoke' ? 'invoke' : 'screen'
  } catch {
    return 'screen'
  }
}

/** Persist the choice. Best effort — the in-memory choice still applies. */
export function writeAudioOutputSelection(selection: AudioOutputSelection): void {
  try {
    localStorage.setItem(AUDIO_OUTPUT_PREF_KEY, selection)
  } catch {
    // best effort
  }
}
