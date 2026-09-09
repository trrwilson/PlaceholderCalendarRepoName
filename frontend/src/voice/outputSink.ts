// The one place that knows which speaker the appliance's own sounds come out of.
//
// Everything the page plays — the assistant reply, the "I'm listening" cue, the
// timer chime — goes through `createEchoCancelledOutput` (`./aecPlayback`), which
// plays a loopback `RTCPeerConnection` stream through a bare `<audio>` element.
// Chromium routes a peer-connection `<audio>` with no explicit sink to the
// output endpoint *paired with the active capture device* (same `groupId`), not
// to the system default. On the kiosk the capture device is a VB-CABLE input, so
// without an explicit `setSinkId` the reply audio is played straight back into
// the virtual cable and is never heard. See docs/audio-pipeline.md → Output.
//
// This module holds the chosen sink id (`''` = system default) and notifies the
// live playout elements when it changes. `useAudioOutput` is the single writer;
// `aecPlayback` is the reader. It mirrors how `micSource` + `useAudioInput` own
// the *input* device — one owner, one path to the browser API.

type SinkListener = (sinkId: string) => void

let currentSinkId = ''
const listeners = new Set<SinkListener>()

/** The sink id to hand to `HTMLMediaElement.setSinkId`. `''` means system default. */
export function getOutputSinkId(): string {
  return currentSinkId
}

/**
 * Set the output sink id for every current and future playout element. `''`
 * (or a falsy value) restores the system default — passed to `setSinkId` as an
 * explicit `''`, which still overrides Chromium's capture-device pairing. No-ops
 * when nothing changed.
 */
export function setOutputSinkId(sinkId: string | null | undefined): void {
  const next = sinkId || ''
  if (next === currentSinkId) return
  currentSinkId = next
  for (const listener of listeners) {
    try {
      listener(next)
    } catch {
      // a stale playout element must never break the others
    }
  }
}

/** Subscribe to sink-id changes. Returns an unsubscribe function. */
export function onOutputSinkChange(listener: SinkListener): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Test seam: forget the selection and every subscriber. */
export function resetOutputSink(): void {
  currentSinkId = ''
  listeners.clear()
}
