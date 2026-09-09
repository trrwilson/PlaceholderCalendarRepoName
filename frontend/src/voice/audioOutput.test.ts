import { afterEach, describe, expect, it } from 'vitest'

import {
  AUDIO_OUTPUT_PREF_KEY,
  readAudioOutputSelection,
  resolveAudioOutput,
  toAudioOutputDevices,
  writeAudioOutputSelection,
  type AudioOutputDevice,
} from './audioOutput'

const device = (over: Partial<AudioOutputDevice>): AudioOutputDevice => ({
  deviceId: 'id',
  label: '',
  isVbCable: false,
  ...over,
})

describe('toAudioOutputDevices', () => {
  it('keeps audio outputs only, de-duplicates by id, and flags VB-CABLE render endpoints', () => {
    const raw = [
      { kind: 'audioinput', deviceId: 'mic', label: 'Microphone Array', groupId: 'g1' },
      { kind: 'audiooutput', deviceId: 'spk', label: 'Speakers / Headphones (Realtek Audio)', groupId: 'g1' },
      { kind: 'audiooutput', deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)', groupId: 'g2' },
      { kind: 'audiooutput', deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)', groupId: 'g2' },
      { kind: 'audiooutput', deviceId: '', label: '', groupId: '' },
    ] as unknown as MediaDeviceInfo[]

    expect(toAudioOutputDevices(raw)).toEqual([
      { deviceId: 'spk', label: 'Speakers / Headphones (Realtek Audio)', isVbCable: false },
      { deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)', isVbCable: true },
    ])
  })
})

describe('readAudioOutputSelection / writeAudioOutputSelection', () => {
  afterEach(() => localStorage.clear())

  it('defaults to auto when unset', () => {
    expect(readAudioOutputSelection()).toEqual({ mode: 'auto' })
  })

  it('round-trips an explicit device and auto', () => {
    writeAudioOutputSelection({ mode: 'device', deviceId: 'spk', label: 'Speakers' })
    expect(readAudioOutputSelection()).toEqual({ mode: 'device', deviceId: 'spk', label: 'Speakers' })
    writeAudioOutputSelection({ mode: 'auto' })
    expect(localStorage.getItem(AUDIO_OUTPUT_PREF_KEY)).toBe('auto')
    expect(readAudioOutputSelection()).toEqual({ mode: 'auto' })
  })

  it('round-trips the Invoke (Wi-Fi) choice', () => {
    writeAudioOutputSelection({ mode: 'invoke' })
    expect(localStorage.getItem(AUDIO_OUTPUT_PREF_KEY)).toBe('invoke')
    expect(readAudioOutputSelection()).toEqual({ mode: 'invoke' })
  })

  it('falls back to auto on malformed storage', () => {
    localStorage.setItem(AUDIO_OUTPUT_PREF_KEY, '{not json')
    expect(readAudioOutputSelection()).toEqual({ mode: 'auto' })
    localStorage.setItem(AUDIO_OUTPUT_PREF_KEY, '{"label":"no id"}')
    expect(readAudioOutputSelection()).toEqual({ mode: 'auto' })
  })
})

describe('resolveAudioOutput', () => {
  const spk = device({ deviceId: 'spk', label: 'Speakers / Headphones (Realtek Audio)' })
  const cable = device({ deviceId: 'cable', label: 'CABLE Input (VB-Audio Virtual Cable)', isVbCable: true })

  it('auto is the system default, stated explicitly', () => {
    expect(resolveAudioOutput({ mode: 'auto' }, [spk, cable])).toEqual({
      sinkId: '',
      label: 'System default',
      reason: 'auto-default',
    })
  })

  it('auto steps off a default that is itself a VB-CABLE endpoint', () => {
    const browserDefault = device({ deviceId: 'default', label: 'Default - CABLE Input (VB-Audio Virtual Cable)', isVbCable: true })
    expect(resolveAudioOutput({ mode: 'auto' }, [browserDefault, cable, spk])).toMatchObject({
      sinkId: 'spk',
      reason: 'auto-avoid-vb-cable',
    })
  })

  it('auto stays on the default when the only alternative is also VB-CABLE', () => {
    const browserDefault = device({ deviceId: 'default', label: 'Default - CABLE Input', isVbCable: true })
    expect(resolveAudioOutput({ mode: 'auto' }, [browserDefault, cable])).toMatchObject({ reason: 'auto-default' })
  })

  it('matches an explicit device by id', () => {
    expect(resolveAudioOutput({ mode: 'device', deviceId: 'spk', label: 'stale' }, [spk, cable])).toMatchObject({
      sinkId: 'spk',
      reason: 'selected',
    })
  })

  it('falls back to the remembered label when the id has rotated', () => {
    const rotated = device({ deviceId: 'spk-new', label: 'Speakers / Headphones (Realtek Audio)' })
    expect(
      resolveAudioOutput({ mode: 'device', deviceId: 'spk-old', label: 'Speakers / Headphones (Realtek Audio)' }, [rotated, cable]),
    ).toMatchObject({ sinkId: 'spk-new', reason: 'selected-by-label' })
  })

  it('still returns a genuinely absent device so the setSinkId rejection is visible', () => {
    expect(resolveAudioOutput({ mode: 'device', deviceId: 'gone', label: 'Unplugged' }, [spk])).toMatchObject({
      sinkId: 'gone',
      reason: 'selected-missing',
    })
  })

  it('leaves the local sink at the default for an Invoke choice (playout is muted anyway)', () => {
    expect(resolveAudioOutput({ mode: 'invoke' }, [spk, cable])).toEqual({
      sinkId: '',
      label: 'Invoke (Wi-Fi)',
      reason: 'invoke',
    })
  })
})
