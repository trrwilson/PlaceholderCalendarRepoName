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
// An optional `SpeakerTap` (speakerOut.ts) forks the same bus to the Wi-Fi
// speaker path: the caller's audio is tapped *before* the local mute, so it can
// stream to the Invoke while the local playout is silenced (`onRouted`). See
// docs/audio-pipeline.md, "Output device selection".
//
// Ref: https://focused.io/lab/echo-cancellation-with-web-audio-api-and-chromium

import { getOutputSinkId, onOutputSinkChange } from './outputSink'
import type { SpeakerTap } from './speakerOut'

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
 *
 * When `tap` is given the same audio is also forwarded to the network speaker
 * (and the local playout muted whenever that link is live).
 */
export function createEchoCancelledOutput(
  context: AudioContext,
  tap?: SpeakerTap,
): EchoCancelledOutput {
  let disposed = false

  // Callers connect here. `entry` fans to the local playout (through `localMute`)
  // and, when tapped, to the network speaker (pre-mute).
  const entry = context.createGain()
  const localMute = context.createGain()
  entry.connect(localMute)

  let tapNode: AudioWorkletNode | null = null
  let unsubscribeRouted: (() => void) | null = null
  const canTap = !!tap && !!context.audioWorklet && typeof AudioWorkletNode === 'function'
  if (tap && canTap) {
    unsubscribeRouted = tap.onRouted((routed) => {
      localMute.gain.value = routed ? 0 : 1
    })
    void context.audioWorklet
      .addModule(new URL('./pcm-speaker-tap-worklet.js', import.meta.url))
      .then(() => {
        if (disposed) return
        tapNode = new AudioWorkletNode(context, 'pcm-speaker-tap')
        tapNode.port.onmessage = (event: MessageEvent<Float32Array>) => {
          tap.pushFrames(event.data, context.sampleRate)
        }
        entry.connect(tapNode)
        // Silent leaf, connected only so the render graph keeps pulling it.
        tapNode.connect(context.destination)
      })
      .catch((error) => {
        console.warn('[voice] network speaker tap unavailable — local playout only', error)
      })
  }

  const RTCPeerConnectionCtor =
    typeof RTCPeerConnection === 'function' ? RTCPeerConnection : null
  const canLoopback =
    RTCPeerConnectionCtor !== null && typeof context.createMediaStreamDestination === 'function'

  if (!canLoopback) {
    if (!warnedFallback) {
      warnedFallback = true
      console.warn('[voice] echo-cancelled playout unavailable — using the raw output')
    }
    localMute.connect(context.destination)
    return {
      node: entry,
      active: false,
      dispose() {
        disposed = true
        unsubscribeRouted?.()
        try {
          entry.disconnect()
          localMute.disconnect()
          tapNode?.disconnect()
        } catch {
          // not connected
        }
      },
    }
  }

  const dest = context.createMediaStreamDestination()
  const pcSend = new RTCPeerConnectionCtor()
  const pcRecv = new RTCPeerConnectionCtor()
  let element: HTMLAudioElement | null = null
  let unsubscribeSink: (() => void) | null = null
  let active = false

  localMute.connect(dest)

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
          localMute.disconnect()
        } catch {
          // not connected yet
        }
        localMute.connect(context.destination)
      }
    }
  })()

  return {
    node: entry,
    get active() {
      return active
    },
    dispose() {
      disposed = true
      active = false
      unsubscribeRouted?.()
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
        entry.disconnect()
        localMute.disconnect()
        tapNode?.disconnect()
      } catch {
        // not connected
      }
    },
  }
}
