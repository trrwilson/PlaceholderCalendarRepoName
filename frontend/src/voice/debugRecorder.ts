// Retains the exact audio the kiosk streamed to the speech provider for the last
// N voice activations, so a wake-word / endpointing / misheard-command problem
// can be listened to after the fact instead of guessed at.
//
// What it captures is the *provider input* — every PCM16 chunk passed to
// `ConversationalVoiceProvider.sendAudio()` for a turn, in order, at the
// provider's own input rate (16 kHz Gemini, 24 kHz the Azure relay). For a
// push-to-talk turn that is the whole turn from the moment the mic opens; for a
// wake activation it starts with the pre-roll `useVoiceSession` flushes in right
// after connect (the run-up to and start of the command, from a bit before the
// keyword) and then continues with the live mic. So a capture is a faithful
// recording of what the model actually got to work with.
//
// Two ways out, no kiosk UI for either (AGENTS.md → Wake word: "no debugging
// console in the kiosk UI"):
//   - `window.__voiceDebug` in the browser console (`list` / `wav` / `wavBytes` /
//     `samples` / `save` / `clear`);
//   - each finished capture is also POSTed to `POST /api/voice/debug/capture`,
//     which writes a headered `.wav` + `.json` sidecar to disk
//     (`MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR`) for playback / reuse. That
//     upload is best-effort — the in-memory ring stands on its own.
//
// Enabled by default; turn it off with `localStorage['voice.debug.capture'] =
// 'off'` (and/or `MISSION_CONTROL_VOICE_DEBUG_CAPTURE_ENABLED=false` server-side).

import { base64ToPcm16, encodeWav } from './pcm'

/** Re-exported for the tests and `window.__voiceDebug`; the encoder lives in `./pcm`. */
export { encodeWav }

/** Turns kept by default; override with `localStorage['voice.debug.count']`. */
const DEFAULT_CAPACITY = 10
/** A single capture is capped so a stuck turn can't grow without bound. */
const MAX_CAPTURE_SECONDS = 60

interface CaptureMeta {
  /** Monotonic id, 1-based, newest highest. */
  id: number
  /** Wall-clock start of the turn. */
  startedAt: string
  provider: string | null
  model: string | null
  sampleRate: number
  /** True when a wake phrase opened the turn (capture leads with the pre-roll). */
  viaWake: boolean
  /** Pre-roll chunks flushed in ahead of the live mic (wake turns only). */
  prerollChunks: number
  /** Live-mic chunks streamed after the pre-roll. */
  micChunks: number
  seconds: number
  /** How the turn ended, once known. */
  outcome: 'ok' | 'failed' | 'abandoned' | 'pending'
  failureKind?: string
  transcript?: { user: string; assistant: string }
}

interface Capture extends CaptureMeta {
  /** PCM16 mono at {@link CaptureMeta.sampleRate}, in arrival order. */
  chunks: Int16Array[]
  /** Where to POST the finished WAV, if disk persistence is wanted this turn. */
  uploadUrl: string | null
}

function envInt(key: string, fallback: number): number {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const n = Number.parseInt(raw, 10)
    return Number.isFinite(n) && n > 0 ? n : fallback
  } catch {
    return fallback
  }
}

function captureEnabled(): boolean {
  try {
    return localStorage.getItem('voice.debug.capture') !== 'off'
  } catch {
    return true
  }
}

function concat(chunks: Int16Array[]): Int16Array {
  let total = 0
  for (const c of chunks) total += c.length
  const out = new Int16Array(total)
  let offset = 0
  for (const c of chunks) {
    out.set(c, offset)
    offset += c.length
  }
  return out
}

/** Bytes → base64, chunked so a multi-MB WAV doesn't overflow the argument list. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step) {
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  }
  return btoa(binary)
}

/**
 * The process-wide capture ring. `useVoiceSession` calls `beginTurn` when a turn
 * starts streaming, `appendChunk` beside every `sendAudio`, and `endTurn` when
 * the turn tears down.
 */
export class VoiceDebugRecorder {
  private captures: Capture[] = []
  private current: Capture | null = null
  private nextId = 1
  private capacity = DEFAULT_CAPACITY

  /**
   * Start a capture for a turn. Any unfinished previous capture is closed off.
   * `apiBaseUrl` (when given) is where the finished WAV is POSTed for on-disk
   * persistence — `POST /api/voice/debug/capture`.
   */
  beginTurn(meta: { sampleRate: number; viaWake: boolean; apiBaseUrl?: string | null }): void {
    this.capacity = envInt('voice.debug.count', DEFAULT_CAPACITY)
    if (this.current) this.endTurn()
    if (!captureEnabled()) {
      this.current = null
      return
    }
    this.current = {
      id: this.nextId++,
      startedAt: new Date().toISOString(),
      provider: null,
      model: null,
      sampleRate: meta.sampleRate,
      viaWake: meta.viaWake,
      prerollChunks: 0,
      micChunks: 0,
      seconds: 0,
      outcome: 'pending',
      chunks: [],
      uploadUrl: meta.apiBaseUrl ? `${meta.apiBaseUrl.replace(/\/$/, '')}/api/voice/debug/capture` : null,
    }
  }

  /** Attach provider/model (known once the grant is in) or the final transcript/outcome. */
  note(patch: Partial<Pick<CaptureMeta, 'provider' | 'model' | 'outcome' | 'failureKind' | 'transcript'>>): void {
    if (this.current) Object.assign(this.current, patch)
  }

  /** One PCM16 chunk that was handed to the provider. `kind` distinguishes the wake pre-roll. */
  appendChunk(base64: string, kind: 'preroll' | 'mic' = 'mic'): void {
    const capture = this.current
    if (!capture) return
    if (capture.seconds >= MAX_CAPTURE_SECONDS) return
    let samples: Int16Array
    try {
      samples = base64ToPcm16(base64)
    } catch {
      return
    }
    if (!samples.length) return
    capture.chunks.push(samples)
    capture.seconds += samples.length / capture.sampleRate
    if (kind === 'preroll') capture.prerollChunks += 1
    else capture.micChunks += 1
  }

  /** Close off the current capture and drop the oldest beyond the capacity. */
  endTurn(): void {
    const capture = this.current
    this.current = null
    if (!capture) return
    if (capture.outcome === 'pending') capture.outcome = capture.chunks.length ? 'ok' : 'abandoned'
    capture.seconds = Math.round(capture.seconds * 100) / 100
    this.captures.push(capture)
    while (this.captures.length > this.capacity) this.captures.shift()
    this.publish()
    console.info('[voice] debug capture stored', this.describe(capture))
    this.upload(capture)
  }

  /**
   * Best-effort POST of the finished WAV to the backend, which writes it to
   * disk (`MISSION_CONTROL_VOICE_DEBUG_CAPTURE_DIR`). Fire-and-forget: if the
   * backend is down, off, or rejects it, the in-memory ring still holds the
   * capture for `window.__voiceDebug`.
   */
  private upload(capture: Capture): void {
    if (!capture.uploadUrl || !capture.chunks.length) return
    if (typeof fetch !== 'function') return
    const bytes = encodeWav(concat(capture.chunks), capture.sampleRate)
    const body = JSON.stringify({
      wav_base64: bytesToBase64(bytes),
      sample_rate: capture.sampleRate,
      started_at: capture.startedAt,
      provider: capture.provider,
      model: capture.model,
      via_wake: capture.viaWake,
      preroll_chunks: capture.prerollChunks,
      mic_chunks: capture.micChunks,
      seconds: capture.seconds,
      outcome: capture.outcome,
      failure_kind: capture.failureKind ?? null,
      transcript: capture.transcript ?? null,
    })
    void fetch(capture.uploadUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body,
    })
      .then((r) => {
        if (!r.ok) console.debug('[voice] debug capture not persisted', r.status)
      })
      .catch(() => {
        /* backend unreachable — the in-memory capture is enough */
      })
  }

  /** Newest capture, or the one with `id`. */
  private pick(id?: number): Capture | undefined {
    if (id != null) return this.captures.find((c) => c.id === id)
    return this.captures.length ? this.captures[this.captures.length - 1] : undefined
  }

  private describe(capture: Capture): CaptureMeta {
    const meta: Record<string, unknown> = { ...capture }
    delete meta.chunks
    delete meta.uploadUrl
    return meta as unknown as CaptureMeta
  }

  /** Metadata for every retained capture, oldest first. */
  list(): CaptureMeta[] {
    return this.captures.map((c) => this.describe(c))
  }

  /** The captured audio for a capture id (or the most recent) as one PCM16 buffer. */
  samples(id?: number): Int16Array | null {
    const capture = this.pick(id)
    return capture ? concat(capture.chunks) : null
  }

  /** The captured audio as WAV bytes. */
  wavBytes(id?: number): Uint8Array | null {
    const capture = this.pick(id)
    return capture ? encodeWav(concat(capture.chunks), capture.sampleRate) : null
  }

  /** The captured audio as a WAV blob, for download. */
  wav(id?: number): Blob | null {
    const bytes = this.wavBytes(id)
    return bytes ? new Blob([bytes], { type: 'audio/wav' }) : null
  }

  /**
   * Download a capture (or the most recent) as a `.wav`. Console helper — a real
   * user gesture in the kiosk's own browser, not something the app does on its own.
   */
  save(id?: number): void {
    const capture = this.pick(id)
    const blob = this.wav(id)
    if (!capture || !blob) {
      console.warn('[voice] no such debug capture', id)
      return
    }
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = `voice-capture-${capture.id}-${capture.viaWake ? 'wake' : 'ptt'}.wav`
    a.click()
    setTimeout(() => URL.revokeObjectURL(url), 10_000)
  }

  clear(): void {
    this.captures = []
    this.current = null
    this.publish()
  }

  /** Test seam: full reset, including the id counter. */
  reset(): void {
    this.clear()
    this.nextId = 1
    this.capacity = DEFAULT_CAPACITY
  }

  private publish(): void {
    try {
      ;(window as unknown as { __voiceDebug?: unknown }).__voiceDebug = {
        list: () => this.list(),
        samples: (id?: number) => this.samples(id),
        wav: (id?: number) => this.wav(id),
        wavBytes: (id?: number) => this.wavBytes(id),
        save: (id?: number) => this.save(id),
        clear: () => this.clear(),
      }
    } catch {
      // non-browser context (tests) — the API is reachable via the instance
    }
  }
}

/** Process-wide singleton, mirrored onto `window.__voiceDebug`. */
export const voiceDebugRecorder = new VoiceDebugRecorder()
