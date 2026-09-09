import { afterEach, describe, expect, it } from 'vitest'

import {
  AUDIO_OUTPUT_PREF_KEY,
  readAudioOutputSelection,
  writeAudioOutputSelection,
} from './audioOutput'

afterEach(() => localStorage.clear())

describe('audio output selection', () => {
  it('defaults to the local screen when unset', () => {
    expect(readAudioOutputSelection()).toBe('screen')
  })

  it('round-trips the Invoke choice through localStorage', () => {
    writeAudioOutputSelection('invoke')
    expect(localStorage.getItem(AUDIO_OUTPUT_PREF_KEY)).toBe('invoke')
    expect(readAudioOutputSelection()).toBe('invoke')
  })

  it('treats any unrecognised stored value as the screen', () => {
    localStorage.setItem(AUDIO_OUTPUT_PREF_KEY, 'bogus')
    expect(readAudioOutputSelection()).toBe('screen')
  })
})
