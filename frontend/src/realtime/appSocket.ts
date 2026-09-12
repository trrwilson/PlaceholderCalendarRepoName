// One `/api/ws` connection for the whole kiosk. `useTimers` and `useLists` both
// subscribe here rather than each opening a socket. A small typed push channel,
// not an event bus — it matches the server side (`app/realtime.py`). See
// docs/lists-plan.md (O3).
//
// Reconnects on its own with capped exponential backoff when the socket drops
// (a backend restart, a network blip): the kiosk is an always-on wall panel
// with nobody around to refresh the tab, so recovering without a manual reload
// is the point, not an extra. Every subscriber's `onOpen` fires again on
// reconnect, which is what drives the `GET /api/household`-style reconcile
// fetch each of them already does on (re)open — no separate resync path
// needed here.

export type SocketStatus = 'connecting' | 'live' | 'offline'
type MessageListener = (data: Record<string, unknown>) => void
type StatusListener = (status: SocketStatus) => void

const INITIAL_RECONNECT_DELAY_MS = 1_000
const MAX_RECONNECT_DELAY_MS = 15_000

class AppSocket {
  private ws: WebSocket | null = null
  private baseUrl = ''
  private refs = 0
  private status: SocketStatus = 'connecting'
  private readonly messageListeners = new Set<MessageListener>()
  private readonly statusListeners = new Set<StatusListener>()
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS

  /** Register interest in the connection; (re)opens it for the first caller. */
  connect(apiBaseUrl: string): void {
    this.refs += 1
    this.baseUrl = apiBaseUrl
    if (this.refs === 1) {
      if (this.ws) {
        try {
          this.ws.close()
        } catch {
          // already gone
        }
        this.ws = null
      }
      this.clearReconnectTimer()
      this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
      this.open()
    }
  }

  /** Drop interest; closes the socket when the last caller leaves. */
  disconnect(): void {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs === 0) {
      this.clearReconnectTimer()
      if (this.ws) {
        const ws = this.ws
        this.ws = null
        ws.close()
      }
    }
  }

  onMessage(listener: MessageListener): () => void {
    this.messageListeners.add(listener)
    return () => this.messageListeners.delete(listener)
  }

  onStatus(listener: StatusListener): () => void {
    this.statusListeners.add(listener)
    listener(this.status)
    return () => this.statusListeners.delete(listener)
  }

  /** Force a fresh reconcile fetch on every subscriber (used on (re)open). */
  get connected(): boolean {
    return this.status === 'live'
  }

  private open(): void {
    this.setStatus('connecting')
    try {
      const ws = new WebSocket(`${this.baseUrl.replace(/^http/, 'ws')}/api/ws`)
      this.ws = ws
      ws.addEventListener('open', () => {
        if (this.ws !== ws) return
        this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
        this.setStatus('live')
      })
      ws.addEventListener('close', () => {
        // A superseded socket (replaced by a newer connect(), e.g. React
        // StrictMode's dev-only double-invoke of the connect/disconnect
        // effect) can still fire `close` after the current one is already
        // live — without this guard that spuriously flips the shared status
        // back to 'offline' and queues a redundant reconnect.
        if (this.ws !== ws) return
        this.ws = null
        this.setStatus('offline')
        this.scheduleReconnect()
      })
      ws.addEventListener('message', (event: MessageEvent) => {
        let data: Record<string, unknown>
        try {
          data = JSON.parse(String(event.data)) as Record<string, unknown>
        } catch {
          return
        }
        this.messageListeners.forEach((listener) => listener(data))
      })
    } catch {
      this.ws = null
      this.setStatus('offline')
      this.scheduleReconnect()
    }
  }

  /** Schedule the next `open()` with capped exponential backoff, unless
   * nobody is listening any more or a reconnect is already queued. */
  private scheduleReconnect(): void {
    if (this.refs === 0 || this.reconnectTimer) return
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null
      if (this.refs === 0) return
      this.reconnectDelayMs = Math.min(this.reconnectDelayMs * 2, MAX_RECONNECT_DELAY_MS)
      this.open()
    }, this.reconnectDelayMs)
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer)
      this.reconnectTimer = null
    }
  }

  private setStatus(status: SocketStatus): void {
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
  }

  /** Test-only: drop all state so a stubbed WebSocket doesn't leak between tests. */
  __resetForTests(): void {
    this.clearReconnectTimer()
    this.reconnectDelayMs = INITIAL_RECONNECT_DELAY_MS
    this.ws = null
    this.refs = 0
    this.status = 'connecting'
    this.messageListeners.clear()
    this.statusListeners.clear()
  }
}

export const appSocket = new AppSocket()
