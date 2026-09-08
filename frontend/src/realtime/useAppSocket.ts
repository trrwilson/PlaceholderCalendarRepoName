import { useEffect, useRef } from 'react'

import { appSocket, type SocketStatus } from './appSocket'

interface Handlers {
  onMessage?: (data: Record<string, unknown>) => void
  onStatus?: (status: SocketStatus) => void
  /** Fires whenever the socket reaches `live` — the moment to reconcile via REST. */
  onOpen?: () => void
}

/**
 * Subscribe a component to the shared `/api/ws` connection. Several callers can
 * use it at once; the socket opens on the first and closes after the last.
 */
export function useAppSocket(apiBaseUrl: string, handlers: Handlers): void {
  const ref = useRef(handlers)
  ref.current = handlers
  useEffect(() => {
    appSocket.connect(apiBaseUrl)
    const offMessage = appSocket.onMessage((data) => ref.current.onMessage?.(data))
    const offStatus = appSocket.onStatus((status) => {
      ref.current.onStatus?.(status)
      if (status === 'live') ref.current.onOpen?.()
    })
    return () => {
      offMessage()
      offStatus()
      appSocket.disconnect()
    }
  }, [apiBaseUrl])
}
