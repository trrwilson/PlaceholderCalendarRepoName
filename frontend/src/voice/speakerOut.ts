// Streams the appliance's output bus to the Invoke over Wi-Fi, when Settings →
// Speaker output is set to "Invoke" (docs/audio-pipeline.md, "Output device
// selection").
//
// `createEchoCancelledOutput` (aecPlayback.ts) is the one choke point every
// sound the kiosk makes passes through — assistant replies and the listening
// cue via `AudioSink`, the timer chime via `AlarmChime`. Each of those two
// contexts attaches a tap here; `SpeakerOut` sums the taps (`SpeakerMixer`),
// packs the sum to PCM16, and sends it as binary frames on
// `WS /api/voice/speaker`. The backend widens and forwards to the on-device
// `invoke_speaker_daemon.sh` (ReInvoke2026). No OS virtual audio device.
//
// While the Invoke is carrying the audio *cleanly* (socket open, backend
// `link:"up"`, and no fresh sheds/reconnects) the taps also mute the *local*
// playout (via `onRouted`), so the assistant is not heard from both the screen
// and the Invoke half a second apart. A dropped or stuttering link un-mutes
// until it settles.

import { resampleLinear } from './pcm'
import { SPEAKER_RATE, SpeakerMixer } from './speakerMix'

/** Where the output bus is going: the local screen, or the Invoke over Wi-Fi. */
export type SpeakerRoute = 'screen' | 'invoke'

/** One output context's connection to the network speaker. */
export interface SpeakerTap {
  /** Feed native-rate mono frames from that context's output-bus worklet. */
  pushFrames(frames: Float32Array, sampleRate: number): void
  /** Subscribe to "is the local playout currently superseded by the Invoke?". */
  onRouted(listener: (routed: boolean) => void): () => void
  routed(): boolean
}

/** What Settings shows about the link. */
export interface SpeakerLinkStatus {
  selection: SpeakerRoute
  /** The socket is open and audio is flowing. */
  connected: boolean
  /** Last `link` the backend reported (`"up"` / `"down"`), or `""`. */
  link: string
  detail: string
  streamedSeconds: number
  sheds: number
  reconnects: number
}

const RECONNECT_BACKOFF_MS = [500, 1000, 2000, 4000, 8000]
/** Stop feeding the socket if the browser has this much unsent — a real stall,
 *  not jitter. The mixer then drops the oldest audio on its own. */
const MAX_BUFFERED_BYTES = SPEAKER_RATE * 2 * 0.4 // ~400 ms of PCM16
/** Cap one `send()` so a backlog leaves in bounded pieces. */
const MAX_SEND_SAMPLES = SPEAKER_RATE * 0.1 // 100 ms

class SpeakerOut {
  private selection: SpeakerRoute = 'screen'
  private apiBaseUrl = ''
  private ws: WebSocket | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private readonly mixer = new SpeakerMixer()
  private readonly routedListeners = new Set<(routed: boolean) => void>()
  private readonly statusListeners = new Set<(status: SpeakerLinkStatus) => void>()
  private backendLink = ''
  /** The backend's last-reported device link (`"up"` ⇒ the TCP socket to the
   *  daemon is connected). Necessary but not sufficient for muting local
   *  playout — see `streamHealthy`. */
  private deviceLinkUp = false
  /** The Invoke path is not just connected but carrying audio cleanly: the last
   *  status frame showed `link:"up"` and no new sheds / reconnects. Drives the
   *  local-playout mute, so a link that is "up" but dropping frames (the classic
   *  slow-and-choppy failure) keeps the assistant and the chime audible on the
   *  screen rather than replacing them with broken Invoke audio. */
  private streamHealthy = false
  private detail = ''
  private streamedSeconds = 0
  private sheds = 0
  private reconnects = 0
  /** The `sheds` / `reconnects` counters from the previous status frame, for
   *  spotting a link that is "up" but losing frames. Reset on every (re)open. */
  private prevFrameSheds = 0
  private prevFrameReconnects = 0

  /** Point the output bus at the screen or the Invoke. Idempotent. */
  setRoute(selection: SpeakerRoute, apiBaseUrl: string): void {
    this.apiBaseUrl = apiBaseUrl
    if (selection === this.selection) return
    this.selection = selection
    if (selection === 'invoke') this.connect()
    else this.disconnect()
    this.emitStatus()
  }

  /** Create a tap for one output context (`AudioSink`, `AlarmChime`). */
  createTap(label: string): SpeakerTap {
    return {
      pushFrames: (frames, sampleRate) => this.ingest(label, frames, sampleRate),
      onRouted: (listener) => {
        this.routedListeners.add(listener)
        listener(this.routed())
        return () => this.routedListeners.delete(listener)
      },
      routed: () => this.routed(),
    }
  }

  /** The socket to the backend bridge is open (audio can be streamed into it). */
  private socketOpen(): boolean {
    return this.ws?.readyState === WebSocket.OPEN
  }

  /** True while the Invoke is actually carrying the audio cleanly — the socket
   *  is open, the device link is up, *and* the stream is healthy (not shedding
   *  or reconnecting). Drives the local-playout mute, so a dropped, unhealthy,
   *  or never-established device link keeps the assistant audible on the screen. */
  routed(): boolean {
    return this.socketOpen() && this.deviceLinkUp && this.streamHealthy
  }

  onStatusChange(listener: (status: SpeakerLinkStatus) => void): () => void {
    this.statusListeners.add(listener)
    listener(this.status())
    return () => this.statusListeners.delete(listener)
  }

  status(): SpeakerLinkStatus {
    return {
      selection: this.selection,
      connected: this.routed(),
      link: this.backendLink,
      detail: this.detail,
      streamedSeconds: Math.round(this.streamedSeconds),
      sheds: this.sheds,
      reconnects: this.reconnects,
    }
  }

  private ingest(label: string, frames: Float32Array, sampleRate: number): void {
    // Stream as soon as the socket is open, before the device link is confirmed:
    // the backend primes and buffers, so audio is already flowing when the link
    // comes up. `routed()` (local mute) still waits for the confirmed link.
    if (this.selection !== 'invoke' || !this.socketOpen()) return
    const at48k =
      sampleRate === SPEAKER_RATE ? frames : resampleLinear(frames, sampleRate, SPEAKER_RATE)
    this.mixer.write(label, at48k)
    this.flush()
  }

  private flush(): void {
    const ws = this.ws
    if (!ws || ws.readyState !== WebSocket.OPEN) return
    if (ws.bufferedAmount > MAX_BUFFERED_BYTES) return // stalled — let the mixer shed
    let chunk: Int16Array | null
    while ((chunk = this.mixer.read(MAX_SEND_SAMPLES)) !== null) {
      ws.send(chunk.buffer)
      this.streamedSeconds += chunk.length / SPEAKER_RATE
      if (ws.bufferedAmount > MAX_BUFFERED_BYTES) break
    }
  }

  private connect(): void {
    if (typeof WebSocket === 'undefined' || !this.apiBaseUrl) return
    if (this.ws || this.reconnectTimer) return
    const base = this.apiBaseUrl.replace(/^http/, 'ws').replace(/\/$/, '')
    let ws: WebSocket
    try {
      ws = new WebSocket(`${base}/api/voice/speaker`)
    } catch {
      this.scheduleReconnect()
      return
    }
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.onopen = () => {
      this.reconnectAttempt = 0
      this.mixer.reset()
      this.prevFrameSheds = 0
      this.prevFrameReconnects = 0
      this.notifyRouted()
      this.emitStatus()
    }
    ws.onmessage = (event) => {
      if (typeof event.data !== 'string') return
      try {
        const frame = JSON.parse(event.data) as {
          t?: string
          link?: string
          detail?: string
          sheds?: number
          reconnects?: number
        }
        if (frame.t !== 'status') return
        this.backendLink = frame.link ?? this.backendLink
        this.detail = frame.detail || this.detail
        const sheds = typeof frame.sheds === 'number' ? frame.sheds : this.prevFrameSheds
        const reconnects =
          typeof frame.reconnects === 'number' ? frame.reconnects : this.prevFrameReconnects
        const losingFrames =
          sheds > this.prevFrameSheds || reconnects > this.prevFrameReconnects
        this.prevFrameSheds = sheds
        this.prevFrameReconnects = reconnects
        if (typeof frame.sheds === 'number') this.sheds = frame.sheds
        if (typeof frame.reconnects === 'number') this.reconnects = frame.reconnects

        const linkUp = this.backendLink === 'up'
        const healthy = linkUp && !losingFrames
        if (linkUp !== this.deviceLinkUp || healthy !== this.streamHealthy) {
          this.deviceLinkUp = linkUp
          this.streamHealthy = healthy
          this.notifyRouted() // un/re-mute the local playout as the link comes, goes, or degrades
        }
        this.emitStatus()
      } catch {
        // ignore a malformed status frame
      }
    }
    const onGone = () => {
      if (this.ws !== ws) return
      this.ws = null
      this.backendLink = 'down'
      this.deviceLinkUp = false
      this.streamHealthy = false
      this.notifyRouted()
      this.emitStatus()
      if (this.selection === 'invoke') this.scheduleReconnect()
    }
    ws.onclose = onGone
    ws.onerror = onGone
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer || this.selection !== 'invoke') return
    const delay = RECONNECT_BACKOFF_MS[Math.min(this.reconnectAttempt, RECONNECT_BACKOFF_MS.length - 1)]
    this.reconnectAttempt += 1
    this.reconnects += 1
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      this.connect()
    }, delay)
  }

  private disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
    this.reconnectAttempt = 0
    const ws = this.ws
    this.ws = null
    if (ws) {
      ws.onopen = ws.onmessage = ws.onclose = ws.onerror = null
      try {
        ws.close()
      } catch {
        // already closing
      }
    }
    this.mixer.reset()
    this.backendLink = ''
    this.deviceLinkUp = false
    this.streamHealthy = false
    this.prevFrameSheds = 0
    this.prevFrameReconnects = 0
    this.detail = ''
    this.notifyRouted()
  }

  private notifyRouted(): void {
    const routed = this.routed()
    for (const listener of this.routedListeners) {
      try {
        listener(routed)
      } catch {
        // a mute listener must never break playout
      }
    }
  }

  private emitStatus(): void {
    const status = this.status()
    for (const listener of this.statusListeners) {
      try {
        listener(status)
      } catch {
        // ignore a broken status subscriber
      }
    }
  }
}

/** Process-wide network speaker. */
export const speakerOut = new SpeakerOut()
