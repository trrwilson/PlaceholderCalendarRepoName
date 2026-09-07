// Sample-format and sample-rate conversion — the one home for every "turn audio
// from shape A into shape B" primitive in the kiosk.
//
// These used to be copy-pasted between `audio.ts` (provider capture/playback),
// `wake/ringBuffer.ts` (wake pre-roll) and `debugRecorder.ts` (WAV capture),
// which meant three copies of the anti-aliasing downsample and two of the PCM16
// packer. They are pure functions over sample buffers: no `AudioContext`, no
// device, no configuration, so every audio path can share them.
//
// Conventions used throughout the app:
//   - "float" audio is mono `Float32Array` in [-1, 1] (the WebAudio native form);
//   - "PCM16" audio is mono little-endian signed 16-bit, base64-encoded on the
//     wire (what every voice provider and our own relay speak);
//   - a sample rate is always carried explicitly beside the samples. Nothing here
//     assumes 16 kHz or 24 kHz — the rate is a property of the provider
//     (`ConversationalVoiceProvider.inputSampleRate` / `outputSampleRate`) or of
//     the wake model (`WAKE_SAMPLE_RATE`), never a hidden global.
//
// Gain is deliberately NOT applied here. There is exactly one software gain
// stage in the app and it lives upstream of all of this — see `gain.ts`.

/** Float32 [-1, 1] samples to a base64-encoded little-endian PCM16 string. */
export function floatToPcm16Base64(samples: Float32Array): string {
  const pcm = new Int16Array(samples.length)
  for (let i = 0; i < samples.length; i += 1) {
    const clamped = Math.max(-1, Math.min(1, samples[i]))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  const bytes = new Uint8Array(pcm.buffer)
  let binary = ''
  for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

/**
 * Base64 PCM16 to `Int16Array`. A trailing odd byte is dropped rather than
 * letting `new Int16Array` throw a RangeError on a chunk boundary — one lost
 * sample is inaudible.
 */
export function base64ToPcm16(data: string): Int16Array {
  const binary = atob(data)
  const usableBytes = binary.length - (binary.length % 2)
  const bytes = new Uint8Array(usableBytes)
  for (let i = 0; i < usableBytes; i += 1) bytes[i] = binary.charCodeAt(i)
  return new Int16Array(bytes.buffer)
}

/** Base64 PCM16 to Float32 [-1, 1] samples. */
export function pcm16Base64ToFloat(data: string): Float32Array {
  const pcm = base64ToPcm16(data)
  const out = new Float32Array(pcm.length)
  for (let i = 0; i < pcm.length; i += 1) out[i] = pcm[i] / 0x8000
  return out
}

/**
 * Downsample by averaging every source sample that maps to an output sample,
 * rather than picking one. This is a cheap low-pass: plain decimation aliases
 * high frequencies down into the speech band, which degrades the transcript, the
 * server-side voice-activity detector and keyword spotting alike.
 *
 * Upsampling is not this function's job — it returns the input unchanged when
 * `toRate >= fromRate`. Use {@link resampleLinear} for that direction.
 */
export function downsampleTo(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate <= toRate) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.floor(samples.length / ratio))
  for (let i = 0; i < out.length; i += 1) {
    const start = Math.floor(i * ratio)
    const end = Math.min(samples.length, Math.floor((i + 1) * ratio))
    let sum = 0
    for (let j = start; j < end; j += 1) sum += samples[j]
    out[i] = end > start ? sum / (end - start) : samples[start] ?? 0
  }
  return out
}

/**
 * Linear-interpolating resample in either direction. Used to move retained wake
 * pre-roll (held at the wake model's rate) onto a provider's input rate — a
 * mismatch there plays the lead-in ~1.5x fast and pitched up, which the model
 * cannot parse, so the *start* of a wake-word command is effectively lost.
 */
export function resampleLinear(samples: Float32Array, fromRate: number, toRate: number): Float32Array {
  if (fromRate === toRate || samples.length === 0) return samples
  const ratio = fromRate / toRate
  const out = new Float32Array(Math.round(samples.length / ratio))
  for (let i = 0; i < out.length; i += 1) {
    const src = i * ratio
    const lo = Math.floor(src)
    const hi = Math.min(samples.length - 1, lo + 1)
    const frac = src - lo
    out[i] = samples[lo] * (1 - frac) + samples[hi] * frac
  }
  return out
}

/** Wrap mono PCM16 samples in a 44-byte WAV header. */
export function encodeWav(samples: Int16Array, sampleRate: number): Uint8Array {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const writeAscii = (offset: number, text: string) => {
    for (let i = 0; i < text.length; i += 1) view.setUint8(offset + i, text.charCodeAt(i))
  }
  writeAscii(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  writeAscii(8, 'WAVE')
  writeAscii(12, 'fmt ')
  view.setUint32(16, 16, true) // PCM chunk size
  view.setUint16(20, 1, true) // PCM
  view.setUint16(22, 1, true) // mono
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true) // byte rate
  view.setUint16(32, 2, true) // block align
  view.setUint16(34, 16, true) // bits per sample
  writeAscii(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i += 1) view.setInt16(44 + i * 2, samples[i], true)
  return new Uint8Array(buffer)
}
