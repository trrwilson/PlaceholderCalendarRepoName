import { useCallback, useRef, useState } from 'react'

import { micSource } from '../voice/audio'
import { downsampleTo, floatToPcm16, floatToPcm16Base64 } from '../voice/pcm'
import { useNotesSttConfig } from './useNotesSttConfig'

// Straight push-to-talk, deliberately simpler than the conversational turn
// machinery in useVoiceSession: one utterance, no session/ticket/tool layer.
// Reuses the one shared `micSource` (never a second getUserMedia stack — see
// docs/audio-pipeline.md) but nothing else. Two wire strategies share this
// mic-capture/VAD shell: `gemini` and `local` are one blocking POST at the
// end (`recordBatch`); `azure` streams PCM16 over a WebSocket for real-time
// interim results (`recordStreaming`) — see backend/app/notes_stt_azure.py.
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
  /** Set alongside `status === 'error'` — a short, kiosk-presentable reason.
   * `null` once status leaves 'error' or on the generic "didn't catch that"
   * case (no server round-trip to explain). */
  error: string | null
  /** Live streaming text while `status === 'recording'`/`'transcribing'` —
   * only populated for a provider that reports interim results (`azure`
   * today); stays empty for `gemini`/`local`, which only ever produce a
   * single result at the end. */
  partialText: string
  /** Play the earcon, then record until ~900ms of silence or 5s, whichever
   * first — returns the transcript (empty string on failure or no speech). */
  record: () => Promise<string>
  /** Cancel a recording in progress with no transcription request. */
  cancel: () => void
}

/** The backend already curates a clean, kiosk-safe message for the failures
 * it can explain (see `app.voice.providers.gemini` retry/error handling and
 * `notes_stt.transcribe`'s `VoiceUnavailable` reasons) — surface it as-is
 * rather than re-deriving something from the HTTP status. */
async function detailFromResponse(response: Response): Promise<string | null> {
  try {
    const body = (await response.json()) as { detail?: unknown }
    return typeof body.detail === 'string' && body.detail ? body.detail : null
  } catch {
    return null
  }
}

export function useNoteDictation(apiBaseUrl: string): NoteDictationApi {
  // A cheap, stateless config read — independent of any Settings-panel
  // instance of the same hook, and refetched each time a note dialog opens
  // so a bake-off switch made moments ago takes effect immediately.
  const { config: sttConfig } = useNotesSttConfig(apiBaseUrl)
  const providerRef = useRef(sttConfig.provider)
  providerRef.current = sttConfig.provider

  const [status, setStatus] = useState<DictationStatus>('idle')
  const [error, setError] = useState<string | null>(null)
  const [partialText, setPartialText] = useState('')
  const statusRef = useRef<DictationStatus>('idle')
  const setBoth = (next: DictationStatus) => {
    statusRef.current = next
    setStatus(next)
  }

  const cancel = useCallback(() => {
    if (statusRef.current !== 'recording') return
    setBoth('idle')
  }, [])

  const recordBatch = useCallback((): Promise<string> => {
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
            setError((await detailFromResponse(response)) ?? 'Speech service had a problem — try again.')
            setBoth('error')
            resolve('')
            return
          }
          const { text } = (await response.json()) as { text: string }
          setBoth('idle')
          resolve(text)
        } catch {
          setError("Couldn't reach the server — check the connection.")
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
          setError("Couldn't access the microphone.")
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

  // Real-time counterpart of `recordBatch` for the `azure` provider: streams
  // PCM16 over `ws` as it's captured and resolves once the backend reports
  // `done`/`error` (see backend/app/notes_stt_azure.py's wire protocol). The
  // socket is already open (see `record` below) by the time this runs.
  const recordStreaming = useCallback((ws: WebSocket): Promise<string> => {
    const startedAt = performance.now()
    const finalSegments: string[] = []
    let finished = false
    let spoke = false
    let lastVoiceAt = 0

    return new Promise<string>((resolve) => {
      let subscription: { unsubscribe: () => void } | null = null

      const finishWith = (result: string, nextStatus: DictationStatus) => {
        if (finished) return
        finished = true
        subscription?.unsubscribe()
        subscription = null
        ws.onmessage = null
        ws.onerror = null
        ws.onclose = null
        if (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING) {
          try {
            ws.close()
          } catch {
            /* ignore */
          }
        }
        setBoth(nextStatus)
        resolve(result)
      }

      // Silence/max-duration hit, or an external cancel(): stop capturing and
      // either resolve immediately (cancelled) or hand off to the server —
      // the real resolution then happens in `onmessage` ('done'/'error') or
      // `onclose` below, once the tail of buffered audio is recognised.
      const stopAndAwaitFinal = () => {
        if (finished) return
        subscription?.unsubscribe()
        subscription = null
        if (statusRef.current !== 'recording') {
          finishWith('', 'idle')
          return
        }
        setBoth('transcribing')
        if (ws.readyState === WebSocket.OPEN) {
          try {
            ws.send(JSON.stringify({ type: 'stop' }))
            return
          } catch {
            /* fall through to resolve with whatever arrived already */
          }
        }
        finishWith(finalSegments.join(' ').trim(), 'idle')
      }

      ws.onmessage = (event) => {
        let msg: { type?: string; text?: string; message?: string }
        try {
          msg = JSON.parse(String(event.data))
        } catch {
          return
        }
        if (msg.type === 'partial') {
          setPartialText([...finalSegments, msg.text ?? ''].filter(Boolean).join(' '))
        } else if (msg.type === 'final') {
          if (msg.text) finalSegments.push(msg.text)
          setPartialText(finalSegments.join(' '))
        } else if (msg.type === 'error') {
          setError(msg.message ?? 'Speech service had a problem — try again.')
          finishWith('', 'error')
        } else if (msg.type === 'done') {
          finishWith(finalSegments.join(' ').trim(), 'idle')
        }
      }
      ws.onerror = () => {
        if (finished) return
        setError("Couldn't reach the speech service — try again.")
        finishWith('', 'error')
      }
      ws.onclose = () => {
        if (finished) return
        // Closed before 'done'/'error' arrived — nothing more is coming.
        if (finalSegments.length > 0) finishWith(finalSegments.join(' ').trim(), 'idle')
        else {
          setError('Lost connection to the speech service.')
          finishWith('', 'error')
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
          if (ws.readyState === WebSocket.OPEN) {
            try {
              ws.send(JSON.stringify({ type: 'audio', pcm: floatToPcm16Base64(down) }))
            } catch {
              /* best effort — a dropped frame just costs a little audio */
            }
          }
          if (now - startedAt > MAX_RECORD_MS) stopAndAwaitFinal()
          else if (spoke && now - lastVoiceAt > SILENCE_HOLD_MS) stopAndAwaitFinal()
        })
        .then((sub) => {
          subscription = sub
          if (statusRef.current !== 'recording') finishWith('', 'idle')
        })
        .catch(() => {
          setError("Couldn't access the microphone.")
          finishWith('', 'error')
        })

      // Watch for an external cancel() flipping status away from 'recording'
      // (normal completion moves to 'transcribing', which this leaves alone).
      const watchdog = window.setInterval(() => {
        if (finished) {
          window.clearInterval(watchdog)
          return
        }
        if (statusRef.current !== 'recording' && statusRef.current !== 'transcribing') {
          window.clearInterval(watchdog)
          finishWith('', 'idle')
        }
      }, 100)
    })
  }, [])

  const record = useCallback(async (): Promise<string> => {
    if (statusRef.current !== 'idle' && statusRef.current !== 'error') return ''
    setError(null)
    setPartialText('')

    if (providerRef.current === 'azure') {
      const base = apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
      const ws = new WebSocket(`${base}/api/notes/dictate/azure`)
      const opened = new Promise<boolean>((resolve) => {
        ws.onopen = () => resolve(true)
        ws.onerror = () => resolve(false)
      })
      const [ok] = await Promise.all([opened, playBloop()])
      if (!ok) {
        setError("Couldn't reach the speech service — try again.")
        setBoth('error')
        try {
          ws.close()
        } catch {
          /* ignore */
        }
        return ''
      }
      setBoth('recording')
      return recordStreaming(ws)
    }

    await playBloop()
    setBoth('recording')
    return recordBatch()
  }, [apiBaseUrl, recordBatch, recordStreaming])

  return { status, error, partialText, record, cancel }
}
