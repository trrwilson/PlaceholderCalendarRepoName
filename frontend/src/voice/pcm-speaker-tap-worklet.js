// AudioWorklet: taps the echo-cancelled output bus. It reads the mixed output
// (mono — the bus is mono) at the context's native rate, posts it to the main
// thread in ~100 ms Float32 batches (matching pcm-capture-worklet.js), and
// passes nothing through — it is a silent leaf connected to `destination` only
// so the graph keeps pulling it. Resampling to 48 kHz and PCM16 packing happen
// on the main thread (see speakerOut.ts / speakerMix.ts).
class PcmSpeakerTapProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._batch = new Float32Array(4800)
    this._filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (channel) {
      for (let i = 0; i < channel.length; i += 1) {
        this._batch[this._filled] = channel[i]
        this._filled += 1
        if (this._filled === this._batch.length) {
          this.port.postMessage(this._batch.slice(0))
          this._filled = 0
        }
      }
    }
    // Keep the processor alive even while the bus is silent, so the stream to
    // the Invoke stays continuous (silence included) between replies.
    return true
  }
}

registerProcessor('pcm-speaker-tap', PcmSpeakerTapProcessor)
