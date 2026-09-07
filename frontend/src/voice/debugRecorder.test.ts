import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { VoiceDebugRecorder, encodeWav } from './debugRecorder'

/** An Int16 PCM buffer of `samples` ascending values → base64, as `sendAudio` gets it. */
function pcmChunk(samples: number, start = 0): string {
  const pcm = new Int16Array(samples)
  for (let i = 0; i < samples; i += 1) pcm[i] = start + i
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function readWav(bytes: Uint8Array): { sampleRate: number; channels: number; dataBytes: number } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  return {
    channels: view.getUint16(22, true),
    sampleRate: view.getUint32(24, true),
    dataBytes: view.getUint32(40, true),
  }
}

describe('encodeWav', () => {
  it('writes a 44-byte mono PCM16 header for the given rate', () => {
    const bytes = encodeWav(new Int16Array([1, -2, 3, -4]), 16_000)
    expect(bytes).toHaveLength(44 + 8)
    expect(readWav(bytes)).toEqual({ channels: 1, sampleRate: 16_000, dataBytes: 8 })
  })
})

describe('VoiceDebugRecorder', () => {
  let recorder: VoiceDebugRecorder

  beforeEach(() => {
    localStorage.clear()
    recorder = new VoiceDebugRecorder()
  })
  afterEach(() => localStorage.clear())

  it('retains the provider audio for a turn and exports it as a WAV', () => {
    recorder.beginTurn({ sampleRate: 24_000, viaWake: true })
    recorder.note({ provider: 'azure_openai_realtime', model: 'gpt-realtime-2.1' })
    recorder.appendChunk(pcmChunk(6_000), 'preroll') // 0.25 s
    recorder.appendChunk(pcmChunk(12_000), 'mic') // 0.5 s
    recorder.appendChunk(pcmChunk(12_000), 'mic') // 0.5 s
    recorder.note({ outcome: 'ok', transcript: { user: "what's on today", assistant: 'Two things.' } })
    recorder.endTurn()

    const [meta] = recorder.list()
    expect(meta).toMatchObject({
      provider: 'azure_openai_realtime',
      model: 'gpt-realtime-2.1',
      sampleRate: 24_000,
      viaWake: true,
      prerollChunks: 1,
      micChunks: 2,
      outcome: 'ok',
      seconds: 1.25,
    })
    expect(meta.transcript?.user).toBe("what's on today")

    const samples = recorder.samples(meta.id)
    expect(samples).toHaveLength(30_000)
    expect(readWav(recorder.wavBytes(meta.id)!)).toEqual({
      channels: 1,
      sampleRate: 24_000,
      dataBytes: 60_000,
    })
  })

  it('begins a push-to-talk capture from the first mic chunk', () => {
    recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
    recorder.appendChunk(pcmChunk(4_000), 'mic')
    recorder.endTurn()

    expect(recorder.list()[0]).toMatchObject({ viaWake: false, prerollChunks: 0, micChunks: 1 })
  })

  it('keeps only the last N captures, default ten', () => {
    for (let i = 0; i < 14; i += 1) {
      recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
      recorder.appendChunk(pcmChunk(1_600), 'mic')
      recorder.endTurn()
    }
    const ids = recorder.list().map((c) => c.id)
    expect(ids).toEqual([5, 6, 7, 8, 9, 10, 11, 12, 13, 14])
  })

  it('honours localStorage["voice.debug.count"]', () => {
    localStorage.setItem('voice.debug.count', '3')
    for (let i = 0; i < 6; i += 1) {
      recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
      recorder.appendChunk(pcmChunk(1_600), 'mic')
      recorder.endTurn()
    }
    expect(recorder.list().map((c) => c.id)).toEqual([4, 5, 6])
  })

  it('captures nothing when disabled by localStorage', () => {
    localStorage.setItem('voice.debug.capture', 'off')
    recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
    recorder.appendChunk(pcmChunk(1_600), 'mic')
    recorder.endTurn()
    expect(recorder.list()).toHaveLength(0)
  })

  it('closes an abandoned turn that never sent audio', () => {
    recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
    recorder.endTurn()
    expect(recorder.list()[0]).toMatchObject({ outcome: 'abandoned', seconds: 0 })
  })

  it('publishes a console API on window.__voiceDebug', () => {
    recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
    recorder.appendChunk(pcmChunk(1_600), 'mic')
    recorder.endTurn()
    const api = (window as unknown as { __voiceDebug: { list: () => unknown[] } }).__voiceDebug
    expect(api.list()).toHaveLength(1)
  })

  it('POSTs the finished WAV to the backend when an apiBaseUrl is given', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true, status: 200 }) as Response)
    vi.stubGlobal('fetch', fetchMock as unknown as typeof fetch)
    try {
      recorder.beginTurn({ sampleRate: 24_000, viaWake: true, apiBaseUrl: 'http://kiosk.local/' })
      recorder.note({ provider: 'gemini', model: 'gemini-live' })
      recorder.appendChunk(pcmChunk(6_000), 'preroll')
      recorder.appendChunk(pcmChunk(6_000), 'mic')
      recorder.endTurn()
      await Promise.resolve()

      expect(fetchMock).toHaveBeenCalledTimes(1)
      const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
      expect(url).toBe('http://kiosk.local/api/voice/debug/capture')
      const payload = JSON.parse(String(init.body))
      expect(payload).toMatchObject({
        sample_rate: 24_000,
        via_wake: true,
        provider: 'gemini',
        preroll_chunks: 1,
        mic_chunks: 1,
        outcome: 'ok',
      })
      // A real, decodable WAV header.
      const wav = atob(payload.wav_base64)
      expect(wav.slice(0, 4)).toBe('RIFF')
      expect(wav.slice(8, 12)).toBe('WAVE')
    } finally {
      vi.unstubAllGlobals()
    }
  })

  it('does not POST when no apiBaseUrl is configured', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    try {
      recorder.beginTurn({ sampleRate: 16_000, viaWake: false })
      recorder.appendChunk(pcmChunk(1_600), 'mic')
      recorder.endTurn()
      await Promise.resolve()
      expect(fetchMock).not.toHaveBeenCalled()
    } finally {
      vi.unstubAllGlobals()
    }
  })
})
