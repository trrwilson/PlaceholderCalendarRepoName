import { beforeAll, beforeEach, describe, expect, it } from 'vitest'

// The worklet registers itself against AudioWorklet globals jsdom lacks. Shim
// them, load the module once, capture the processor class, and drive `process()`.
type Processor = { process(inputs: Float32Array[][]): boolean }

let Processor: new () => Processor
const posted: Float32Array[] = []

beforeAll(async () => {
  ;(globalThis as Record<string, unknown>).AudioWorkletProcessor = class {
    port = { postMessage: (data: Float32Array) => posted.push(data) }
  }
  ;(globalThis as Record<string, unknown>).registerProcessor = (
    _name: string,
    cls: new () => Processor,
  ) => {
    Processor = cls
  }
  // @ts-expect-error - plain-JS AudioWorklet module, no type declarations
  await import('./pcm-speaker-tap-worklet.js')
})

beforeEach(() => {
  posted.length = 0
})

const quantum = (fill: number) => new Float32Array(128).fill(fill)
const QUANTA_PER_BATCH = 4800 / 128

describe('pcm-speaker-tap worklet', () => {
  it('posts a 4800-sample batch once enough audio has flowed', () => {
    const p = new Processor()
    for (let i = 0; i < QUANTA_PER_BATCH; i += 1) p.process([[quantum(0.5)]])
    expect(posted).toHaveLength(1)
    expect(posted[0]).toHaveLength(4800)
    expect(posted[0].every((s) => s === 0.5)).toBe(true)
  })

  it('advances the batch with silence when the bus is idle (empty input list)', () => {
    const p = new Processor()
    for (let i = 0; i < 20; i += 1) p.process([[quantum(0.5)]])
    for (let i = 0; i < QUANTA_PER_BATCH; i += 1) p.process([[]]) // upstream went silent
    expect(posted).toHaveLength(1)
    const batch = posted[0]
    // real audio sits at its own quantum position; the gap that follows is
    // zeros, not a stretch inserted later.
    expect(Array.from(batch.slice(0, 20 * 128)).every((s) => s === 0.5)).toBe(true)
    expect(Array.from(batch.slice(20 * 128)).every((s) => s === 0)).toBe(true)
  })

  it('never stalls: a fully idle bus still produces batches on schedule', () => {
    const p = new Processor()
    for (let i = 0; i < QUANTA_PER_BATCH; i += 1) expect(p.process([[]])).toBe(true)
    expect(posted).toHaveLength(1)
    expect(posted[0].every((s) => s === 0)).toBe(true)
  })
})
