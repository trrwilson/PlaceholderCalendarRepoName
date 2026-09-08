// Wake-word detection via an Azure custom keyword, spotted on the backend.
//
// The JavaScript Speech SDK cannot load a `.table` keyword model (its
// `KeywordRecognitionModel` factories are unimplemented stubs), so — unlike
// `OpenWakeWordDetector` — this detector does no spotting in the browser. It
// streams 16 kHz mono mic audio to `WS /api/voice/wake/azure` and the backend
// runs the native SDK's `KeywordRecognizer` against the `.table` offline
// (`backend/app/voice/wake_azure.py`). No Azure key, no cloud — but the mic
// audio does reach the backend (localhost / LAN, the same trust boundary as the
// Azure voice relay).
//
// Everything else — the pre-roll ring buffer, suspend/resume semantics, the
// post-fire cooldown — matches `openWakeWord.ts` so `useWakeWord` and
// `useVoiceSession` drive both detectors identically.

import type { MicSource, MicSubscription } from '../audio'
import type { WakeDetector, WakeDetectorConfig, WakeEvent } from './detector'
import { WakeUnavailableError } from './detector'
import { WakePreroll } from './preroll'
import { downsampleTo16k, floatToPcm16Base64 } from './ringBuffer'

/** How long to wait for the backend socket to open before giving up. */
const CONNECT_TIMEOUT_MS = 5_000

export class AzureKeywordDetector implements WakeDetector {
  running = false
  suspended = false

  private ws: WebSocket | null = null
  private sub: MicSubscription | null = null
  private handlers: Parameters<WakeDetector['start']>[0] | null = null
  private readonly preroll = new WakePreroll()
  // `-Infinity` so the very first detection is never inside the cooldown window
  // (`performance.now()` can still be small right after the detector arms).
  private lastFireAt = -Infinity

  private readonly url: string
  private readonly config: WakeDetectorConfig
  private readonly micSource: MicSource

  constructor(config: WakeDetectorConfig, micSource: MicSource) {
    this.config = config
    this.micSource = micSource
    const base = config.apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    this.url = `${base}/api/voice/wake/azure`
  }

  async start(handlers: Parameters<WakeDetector['start']>[0]): Promise<void> {
    this.handlers = handlers

    await new Promise<void>((resolve, reject) => {
      let settled = false
      const ws = new WebSocket(this.url)
      this.ws = ws
      const timer = setTimeout(() => {
        if (!settled) {
          settled = true
          ws.close()
          reject(new WakeUnavailableError('azure wake socket did not open'))
        }
      }, CONNECT_TIMEOUT_MS)

      ws.onopen = () => {
        if (settled) return
        settled = true
        clearTimeout(timer)
        resolve()
      }
      ws.onclose = (event) => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          // Closed before it ever opened — the LAN gate (4403), wake/voice off
          // or the backend SDK missing (4404). Fall back to push-to-talk, the
          // same as a missing ONNX asset.
          reject(
            new WakeUnavailableError(
              event.reason || `azure wake socket refused the connection (${event.code})`,
            ),
          )
          return
        }
        this.handlers?.onError?.(new Error(`azure wake socket closed (${event.code})`))
      }
      ws.onerror = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          reject(new WakeUnavailableError('azure wake socket failed'))
        }
      }
      ws.onmessage = (event) => this.onServerMessage(event)
    })

    try {
      this.sub = await this.micSource.subscribe((frame, sampleRate) => {
        this.onAudio(frame, sampleRate)
      })
    } catch (cause) {
      this.dispose()
      throw new WakeUnavailableError(`microphone unavailable for wake word: ${String(cause)}`)
    }
    this.running = true
    this.preroll.arm()
  }

  suspend(): void {
    // Keep filling the pre-roll (a turn opens seconds before the live mic
    // starts; a single-shot "Mission Control, what's on today" is only here),
    // but stop feeding the recogniser so the assistant's audio can't self-trigger.
    this.suspended = true
    this.send({ type: 'suspend' })
  }

  resume(): void {
    this.suspended = false
    this.preroll.arm()
    // A fresh cooldown after every turn — the assistant's tail can still echo.
    this.lastFireAt = performance.now()
    this.send({ type: 'resume' })
  }

  takeRetainedAudio(targetRate?: number): string[] {
    return this.preroll.take(targetRate)
  }

  dispose(): void {
    this.running = false
    this.suspended = false
    this.sub?.unsubscribe()
    this.sub = null
    this.handlers = null
    this.preroll.clear()
    if (this.ws) {
      this.ws.onclose = null
      this.ws.onerror = null
      this.ws.onmessage = null
      try {
        this.ws.close()
      } catch {
        /* already closing */
      }
      this.ws = null
    }
  }

  private onAudio(frame: Float32Array, sampleRate: number): void {
    if (!this.running) return
    const down = downsampleTo16k(frame, sampleRate)
    this.preroll.write(down)
    if (this.suspended) return
    this.send({ type: 'audio', pcm: floatToPcm16Base64(down) })
  }

  private onServerMessage(event: MessageEvent): void {
    let message: { type?: string; score?: number }
    try {
      message = JSON.parse(String(event.data))
    } catch {
      return
    }
    if (message.type !== 'wake') return
    const now = performance.now()
    if (now - this.lastFireAt < this.config.cooldownMs) return
    this.lastFireAt = now
    this.preroll.markFired(now)
    const wake: WakeEvent = { score: message.score ?? 1, at: now }
    this.handlers?.onScore?.(wake.score)
    this.handlers?.onWake(wake)
  }

  private send(payload: Record<string, unknown>): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(payload))
    }
  }
}
