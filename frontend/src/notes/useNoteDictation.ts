import { useCallback, useRef, useState } from 'react'

import { micSource } from '../voice/audio'
import { downsampleTo, floatToPcm16 } from '../voice/pcm'

// Straight push-to-talk, deliberately simpler than the conversational turn
// machinery in useVoiceSession: one utterance, one blocking POST, no
// session/ticket/WS/tool layer. Reuses the one shared `micSource` (never a
// second getUserMedia stack — see docs/audio-pipeline.md) but nothing else.
const TARGET_RATE = 16_000
const MAX_RECORD_MS = 5_000
const SILENCE_HOLD_MS = 900
// A linear-PCM RMS gate for "is this frame speech" — well above typical room
// noise floor, well below a spoken syllable. Same order of magnitude as
// useVoiceSession's speech gate; tuned independently since this runs on raw
// (non-gained) mic frames rather than the shared gain stage's output.
const SPEECH_RMS = 0.02

export type DictationStatus = 'idle' | 'recording' | 'transcribing' | 'error'

/** A short two-note chime — the PTT "go ahead" earcon. Plays on its own
 * throwaway `AudioContext`, independent of the voice pipeline's output graph
 * (this dialog explicitly suppresses that pipeline while it's open). */
function playBloop(): Promise<void> {
  return new Promise((resolve) => {
    try {
      const ctx = new AudioContext()
      const now = ctx.currentTime
      for (const [freq, at] of [
        [660, 0],
        [880, 0.09],
      ] as const) {
        const osc = ctx.createOscillator()
        const gain = ctx.createGain()
        osc.frequency.value = freq
        gain.gain.setValueAtTime(0.0001, now + at)
        gain.gain.exponentialRampToValueAtTime(0.2, now + at + 0.012)
        gain.gain.exponentialRampToValueAtTime(0.0001, now + at + 0.09)
        osc.connect(gain).connect(ctx.destination)
        osc.start(now + at)
        osc.stop(now + at + 0.1)
      }
      window.setTimeout(() => {
        void ctx.close()
        resolve()
      }, 230)
    } catch {
      resolve()
    }
  })
}

function concat(chunks: Int16Array[]): Int16Array {
  const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0)
  const out = new Int16Array(total)
  let offset = 0
  for (const chunk of chunks) {
    out.set(chunk, offset)
    offset += chunk.length
  }
  return out
}

export interface NoteDictationApi {
  status: DictationStatus
  /** Play the earcon, then record until ~900ms of silence or 5s, whichever
   * first — returns the transcript (empty string on failure or no speech). */
  record: () => Promise<string>
  /** Cancel a recording in progress with no transcription request. */
  cancel: () => void
}

export function useNoteDictation(apiBaseUrl: string): NoteDictationApi {
  const [status, setStatus] = useState<DictationStatus>('idle')
  const statusRef = useRef<DictationStatus>('idle')
  const setBoth = (next: DictationStatus) => {
    statusRef.current = next
    setStatus(next)
  }

  const cancel = useCallback(() => {
    if (statusRef.current !== 'recording') return
    setBoth('idle')
  }, [])

  const record = useCallback(async (): Promise<string> => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return ''
    await playBloop()
    setBoth('recording')
    const chunks: Int16Array[] = []
    let spoke = false
    let lastVoiceAt = 0
    let finished = false
    const startedAt = performance.now()

    return new Promise<string>((resolve) => {
      let subscription: { unsubscribe: () => void } | null = null
      const finish = async (cancelled: boolean) => {
        if (finished) return
        finished = true
        subscription?.unsubscribe()
        if (cancelled || statusRef.current !== 'recording') {
          setBoth('idle')
          resolve('')
          return
        }
        setBoth('transcribing')
        const pcm16 = concat(chunks)
        if (pcm16.length === 0) {
          setBoth('idle')
          resolve('')
          return
        }
        try {
          const response = await fetch(`${apiBaseUrl}/api/notes/transcribe`, {
            method: 'POST',
            headers: { 'content-type': 'application/octet-stream' },
            body: pcm16.buffer as ArrayBuffer,
          })
          if (!response.ok) {
            setBoth('error')
            resolve('')
            return
          }
          const { text } = (await response.json()) as { text: string }
          setBoth('idle')
          resolve(text)
        } catch {
          setBoth('error')
          resolve('')
        }
      }

      micSource
        .subscribe((frame, sampleRate) => {
          if (finished) return
          const down = downsampleTo(frame, sampleRate, TARGET_RATE)
          let sumSquares = 0
          for (let i = 0; i < down.length; i++) sumSquares += down[i] * down[i]
          const rms = Math.sqrt(sumSquares / Math.max(down.length, 1))
          const now = performance.now()
          if (rms > SPEECH_RMS) {
            spoke = true
            lastVoiceAt = now
          }
          chunks.push(floatToPcm16(down))
          if (now - startedAt > MAX_RECORD_MS) void finish(false)
          else if (spoke && now - lastVoiceAt > SILENCE_HOLD_MS) void finish(false)
        })
        .then((sub) => {
          subscription = sub
          if (statusRef.current !== 'recording') void finish(true) // cancelled before the mic came up
        })
        .catch(() => {
          setBoth('error')
          resolve('')
        })

      // Watch for an external cancel() flipping status away from 'recording'.
      const watchdog = window.setInterval(() => {
        if (statusRef.current !== 'recording') {
          window.clearInterval(watchdog)
          void finish(true)
        }
      }, 100)
    })
  }, [apiBaseUrl])

  return { status, record, cancel }
}
