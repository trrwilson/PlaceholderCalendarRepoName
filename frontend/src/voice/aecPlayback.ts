// Echo-cancelled playout for the kiosk.
//
// Chromium's `getUserMedia({ echoCancellation: true })` only removes audio that
// it considers a *remote* stream — the render side of a WebRTC call. Anything the
// page plays through a plain `AudioContext` destination (our assistant reply, the
// listening cue) is never in the AEC reference, so the open microphone hears it
// at full level. On the kiosk, with the mic and speakers a foot apart, that means
// the assistant talks over itself and the "I'm listening" tone used to register
// as the user speaking (see docs/voice-support-plan.md, eighth run).
//
// The fix is the documented loopback trick: render into a
// `MediaStreamAudioDestinationNode`, pipe that stream through a local
// `RTCPeerConnection` pair, and play the *far* end through an `<audio>` element.
// Chromium now sees the playout as a peer-connection remote stream and folds it
// into the AEC3 render reference, so the capture side genuinely cancels it.
//
// This covers everything *this page* plays. Audio from other processes on the
// box (a debug capture opened in a media player, Windows sounds) needs the
// backend WASAPI-loopback path — see the AEC plan, phase 2.
//
// The far-end `<audio>` element is bound to the selected output device via
// `setSinkId` (see ./outputSink). Chromium otherwise routes a peer-connection
// `<audio>` to the endpoint paired with the active capture device — which on the
// kiosk is the VB-CABLE input, so the reply would play back into the cable and
// never be heard. An explicit `setSinkId`, `''` included, overrides that.
//
// Ref: https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium

import { getOutputSinkId, onOutputSinkChange } from './outputSink'

type MediaElementWithSink = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>
}

/** True when this runtime can pick the audio output device (`setSinkId`). */
export function canSelectAudioOutput(): boolean {
  return (
    typeof HTMLMediaElement !== 'undefined' &&
    typeof (HTMLMediaElement.prototype as MediaElementWithSink).setSinkId === 'function'
  )
}

/** Route one playout element to `sinkId` (`''` = system default). Best effort. */
function applySink(element: HTMLMediaElement, sinkId: string): void {
  const setSinkId = (element as MediaElementWithSink).setSinkId
  if (typeof setSinkId !== 'function') return
  void setSinkId.call(element, sinkId).catch((error: unknown) => {
    console.warn('[voice] could not route echo-cancelled playout to the selected output', {
      sinkId: sinkId || '(system default)',
      error,
    })
  })
}

export interface EchoCancelledOutput {
  /** Connect the playout graph into this instead of `context.destination`. */
  readonly node: AudioNode
  /** True when the loopback path is actually carrying audio (not the fallback). */
  readonly active: boolean
  dispose(): void
}

let warnedFallback = false

/**
 * Build an echo-cancelled sink on `context`. Callers connect their gain/output
 * node into `.node`. If `RTCPeerConnection` is unavailable (jsdom, a locked-down
 * runtime) this degrades to `context.destination` — playout still works, it just
 * is not in the AEC reference.
 */
export function createEchoCancelledOutput(context: AudioContext): EchoCancelledOutput {
  const RTCPeerConnectionCtor =
    typeof RTCPeerConnection === 'function' ? RTCPeerConnection : null
  const canLoopback =
    RTCPeerConnectionCtor !== null && typeof context.createMediaStreamDestination === 'function'

  if (!canLoopback) {
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('[voice] echo-cancelled playout unavailable — using the raw output')
    }
    return { node: context.destination, active: false, dispose: () => {} }
  }

  const dest = context.createMediaStreamDestination()
  const pcSend = new RTCPeerConnectionCtor()
  const pcRecv = new RTCPeerConnectionCtor()
  let element: HTMLAudioElement | null = null
  let unsubscribeSink: (() => void) | null = null
  let disposed = false
  let active = false

  pcSend.addEventListener('icecandidate', (event) => {
    if (event.candidate) void pcRecv.addIceCandidate(event.candidate).catch(() => {})
  })
  pcRecv.addEventListener('icecandidate', (event) => {
    if (event.candidate) void pcSend.addIceCandidate(event.candidate).catch(() => {})
  })
  pcRecv.addEventListener('track', (event) => {
    if (disposed) return
    const audio = new Audio()
    element = audio
    audio.autoplay = true
    audio.srcObject = new MediaStream([event.track])
    // Pin the sink before play() and keep it in step with later changes, so the
    // reply is never routed to the capture device's paired endpoint.
    applySink(audio, getOutputSinkId())
    unsubscribeSink?.()
    unsubscribeSink = onOutputSinkChange((sinkId) => applySink(audio, sinkId))
    void audio.play().catch((error) => {
      console.warn('[voice] echo-cancelled playout element could not start', error)
    })
    active = true
  })

  for (const track of dest.stream.getAudioTracks()) pcSend.addTrack(track, dest.stream)

  void (async () => {
    try {
      const offer = await pcSend.createOffer()
      await pcSend.setLocalDescription(offer)
      await pcRecv.setRemoteDescription(offer)
      const answer = await pcRecv.createAnswer()
      await pcRecv.setLocalDescription(answer)
      await pcSend.setRemoteDescription(answer)
      console.info('[voice] echo-cancelled playout loopback established')
    } catch (error) {
      console.warn('[voice] echo-cancelled playout loopback failed — using the raw output', error)
      if (!disposed) {
        try {
          dest.disconnect()
        } catch {
          // not connected yet
        }
        // Nothing routed the graph anywhere yet; fall back by wiring dest→destination.
        dest.connect(context.destination)
      }
    }
  })()

  return {
    node: dest,
    get active() {
      return active
    },
    dispose() {
      disposed = true
      active = false
      unsubscribeSink?.()
      unsubscribeSink = null
      if (element) {
        element.pause()
        element.srcObject = null
        element = null
      }
      try {
        pcSend.close()
      } catch {
        // already closed
      }
      try {
        pcRecv.close()
      } catch {
        // already closed
      }
      try {
        dest.disconnect()
      } catch {
        // not connected
      }
    },
  }
}
