// AudioWorklet: collects mono microphone samples at the context's native rate
// and posts them to the main thread in ~2048-sample Float32 batches. Down-sampling
// to 16 kHz and PCM16 encoding happen on the main thread (see audio.ts).
class PcmCaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._batch = new Float32Array(2048)
    this._filled = 0
  }

  process(inputs) {
    const channel = inputs[0] && inputs[0][0]
    if (!channel) return true
    for (let i = 0; i < channel.length; i += 1) {
      this._batch[this._filled] = channel[i]
      this._filled += 1
      if (this._filled === this._batch.length) {
        this.port.postMessage(this._batch.slice(0))
        this._filled = 0
      }
    }
    return true
  }
}

registerProcessor('pcm-capture', PcmCaptureProcessor)
