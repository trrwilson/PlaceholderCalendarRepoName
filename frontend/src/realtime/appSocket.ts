// One `/api/ws` connection for the whole kiosk. `useTimers` and `useLists` both
// subscribe here rather than each opening a socket. Deliberately tiny and with
// no reconnect — it matches the server side (`app/realtime.py`), which is a
// small typed push channel, not an event bus. See docs/lists-plan.md (O3).

export type SocketStatus = 'connecting' | 'live' | 'offline'
type MessageListener = (data: Record<string, unknown>) => void
type StatusListener = (status: SocketStatus) => void

class AppSocket {
  private ws: WebSocket | null = null
  private baseUrl = ''
  private refs = 0
  private status: SocketStatus = 'connecting'
  private readonly messageListeners = new Set<MessageListener>()
  private readonly statusListeners = new Set<StatusListener>()

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
      this.open()
    }
  }

  /** Drop interest; closes the socket when the last caller leaves. */
  disconnect(): void {
    this.refs = Math.max(0, this.refs - 1)
    if (this.refs === 0 && this.ws) {
      const ws = this.ws
      this.ws = null
      ws.close()
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
      ws.addEventListener('open', () => this.setStatus('live'))
      ws.addEventListener('close', () => {
        if (this.ws === ws) this.ws = null
        this.setStatus('offline')
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
    }
  }

  private setStatus(status: SocketStatus): void {
    this.status = status
    this.statusListeners.forEach((listener) => listener(status))
  }

  /** Test-only: drop all state so a stubbed WebSocket doesn't leak between tests. */
  __resetForTests(): void {
    this.ws = null
    this.refs = 0
    this.status = 'connecting'
    this.messageListeners.clear()
    this.statusListeners.clear()
  }
}

export const appSocket = new AppSocket()
