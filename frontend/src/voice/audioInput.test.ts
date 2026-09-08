import { afterEach, describe, expect, it } from 'vitest'

import {
  AUDIO_INPUT_PREF_KEY,
  isVbCableLabel,
  readAudioInputSelection,
  resolveAudioInput,
  toAudioInputDevices,
  writeAudioInputSelection,
  type AudioInputDevice,
} from './audioInput'

const device = (over: Partial<AudioInputDevice>): AudioInputDevice => ({
  deviceId: 'id',
  label: '',
  isVbCable: false,
  ...over,
})

describe('isVbCableLabel', () => {
  it('matches the ways the VB-Audio driver names its capture endpoint', () => {
    for (const label of [
      'CABLE Output (VB-Audio Virtual Cable)',
      'CABLE-A Output (VB-Audio Cable A)',
      'VB-Audio Virtual Cable',
      'VB-CABLE',
      'vb cable',
    ]) {
      expect(isVbCableLabel(label)).toBe(true)
    }
  })

  it('does not match a real microphone', () => {
    for (const label of ['Microphone Array (Realtek)', 'Blue Yeti', 'Default - Headset', '']) {
      expect(isVbCableLabel(label)).toBe(false)
    }
  })
})

describe('toAudioInputDevices', () => {
  it('keeps audio inputs only, de-duplicates by id, and flags VB-CABLE', () => {
    const raw = [
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone Array', groupId: 'g1' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers', groupId: 'g1' },
      { kind: 'audioinput', deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)', groupId: 'g2' },
      { kind: 'audioinput', deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)', groupId: 'g2' },
      { kind: 'videoinput', deviceId: 'cam', label: 'Webcam', groupId: 'g3' },
      { kind: 'audioinput', deviceId: '', label: '', groupId: '' },
    ] as unknown as MediaDeviceInfo[]

    const inputs = toAudioInputDevices(raw)

    expect(inputs).toEqual([
      { deviceId: 'mic', label: 'Microphone Array', isVbCable: false },
      { deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)', isVbCable: true },
    ])
  })
})

describe('readAudioInputSelection / writeAudioInputSelection', () => {
  afterEach(() => localStorage.clear())

  it('defaults to auto when unset', () => {
    expect(readAudioInputSelection()).toEqual({ mode: 'auto' })
  })

  it('round-trips an explicit device', () => {
    writeAudioInputSelection({ mode: 'device', deviceId: 'cable', label: 'CABLE Output' })
    expect(readAudioInputSelection()).toEqual({ mode: 'device', deviceId: 'cable', label: 'CABLE Output' })
  })

  it('round-trips auto', () => {
    writeAudioInputSelection({ mode: 'device', deviceId: 'x', label: 'y' })
    writeAudioInputSelection({ mode: 'auto' })
    expect(localStorage.getItem(AUDIO_INPUT_PREF_KEY)).toBe('auto')
    expect(readAudioInputSelection()).toEqual({ mode: 'auto' })
  })

  it('falls back to auto on malformed storage', () => {
    localStorage.setItem(AUDIO_INPUT_PREF_KEY, '{not json')
    expect(readAudioInputSelection()).toEqual({ mode: 'auto' })
    localStorage.setItem(AUDIO_INPUT_PREF_KEY, '{"label":"no id"}')
    expect(readAudioInputSelection()).toEqual({ mode: 'auto' })
  })
})

describe('resolveAudioInput', () => {
  const mic = device({ deviceId: 'mic', label: 'Microphone Array' })
  const cable = device({ deviceId: 'cable', label: 'CABLE Output (VB-Audio Virtual Cable)', isVbCable: true })

  it('auto prefers a present VB-CABLE input, best-effort', () => {
    expect(resolveAudioInput({ mode: 'auto' }, [mic, cable])).toMatchObject({
      deviceId: 'cable',
      strict: false,
      reason: 'auto-vb-cable',
    })
  })

  it('auto defers to the OS when no VB-CABLE is present', () => {
    expect(resolveAudioInput({ mode: 'auto' }, [mic])).toMatchObject({
      deviceId: null,
      strict: false,
      reason: 'auto-default',
    })
  })

  it('matches an explicit device by id, strictly', () => {
    expect(resolveAudioInput({ mode: 'device', deviceId: 'cable', label: 'stale' }, [mic, cable])).toMatchObject({
      deviceId: 'cable',
      strict: true,
      reason: 'selected',
    })
  })

  it('falls back to the remembered label when the id has rotated', () => {
    const rotated = device({ deviceId: 'cable-new', label: 'CABLE Output (VB-Audio Virtual Cable)', isVbCable: true })
    expect(
      resolveAudioInput(
        { mode: 'device', deviceId: 'cable-old', label: 'CABLE Output (VB-Audio Virtual Cable)' },
        [mic, rotated],
      ),
    ).toMatchObject({ deviceId: 'cable-new', strict: true, reason: 'selected-by-label' })
  })

  it('still requests a genuinely absent device strictly, so the failure is visible', () => {
    expect(resolveAudioInput({ mode: 'device', deviceId: 'gone', label: 'Unplugged Mic' }, [mic])).toMatchObject({
      deviceId: 'gone',
      strict: true,
      reason: 'selected-missing',
    })
  })
})
