// AudioWorklet: taps the echo-cancelled output bus. It reads the mixed output
// (mono — the bus is mono) at the context's native rate, posts it to the main
// thread in ~100 ms Float32 batches (matching pcm-capture-worklet.js), and
// passes nothing through — it is a silent leaf connected to `destination` only
// so the graph keeps pulling it. Resampling to 48 kHz and PCM16 packing happen
// on the main thread (see speakerOut.ts / speakerMix.ts).
//
// `process()` is invoked once per 128-sample render quantum at exactly real
// time, whether or not anything upstream is producing — Chrome hands an empty
// input list between replies. This worklet advances its batch by one quantum
// EVERY call, filling with zeros when the bus is idle, so the stream it feeds
// downstream is an unbroken 48 kHz timeline: a gap in the reply audio lands as
// real silence *at the quantum it occupies*, not as a stretch inserted later.
// The device daemon needs that continuity or its ALSA ring underruns into the
// first word of the next reply.
//
// This is the right layer for the silence fill: the render thread is the one
// clock that is synchronous with the audio. `SpeakerMixer.available()` must sum
// on the *furthest* writer (not the slowest) so a second idle tap on its own
// AudioContext cannot gate the stream — see speakerMix.ts.
class PcmSpeakerTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._batch = new Float32Array(4800)
    this._filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    const frames = channel ? channel.length : 128
    for (let i = 0; i < frames; i += 1) {
      this._batch[this._filled] = channel ? channel[i] : 0
      this._filled += 1
      if (this._filled === this._batch.length) {
        this.port.postMessage(this._batch.slice(0))
        this._filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-speaker-tap', PcmSpeakerTapProcessor)
