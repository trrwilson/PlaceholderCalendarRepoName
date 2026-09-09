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
    // Advance the batch by one render quantum every call, filling with silence
    // when the bus is idle. Between assistant replies nothing upstream is
    // producing and Chrome hands `process` an empty input list — but the Wi-Fi
    // speaker daemon needs an unbroken 48 kHz stream or its device-side ALSA
    // ring underruns in the gap and the next reply starts choppy. `return true`
    // keeps this processor scheduled every quantum regardless of input.
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
