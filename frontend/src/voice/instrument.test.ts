import { afterEach, describe, expect, it, vi } from 'vitest'

import { VoiceTimeline, recordVoiceTurn } from './instrument'

afterEach(() => vi.unstubAllGlobals())

describe('VoiceTimeline.toReport', () => {
  it('collects milestones and lifts provider/model off the token-received mark', () => {
    const timeline = new VoiceTimeline()
    timeline.mark('tap')
    timeline.mark('token-received', { provider: 'azure_openai_realtime', model: 'gpt-realtime-2.1' })
    timeline.mark('tool-call', { name: 'get_agenda' })
    timeline.mark('tool-call', { name: 'start_timer' })

    const report = timeline.toReport()
    expect(report.provider).toBe('azure_openai_realtime')
    expect(report.model).toBe('gpt-realtime-2.1')
    // Last occurrence of a repeated label wins.
    expect(Object.keys(report.milestones)).toEqual(['tap', 'token-received', 'tool-call'])
  })
})

describe('recordVoiceTurn', () => {
  it('keeps the last 20 turns on window.__voiceTurns', () => {
    const store: Record<string, unknown> = {}
    vi.stubGlobal('window', store)
    for (let i = 0; i < 25; i += 1) {
      recordVoiceTurn({ ok: true, milestones: { tap: i } })
    }
    const turns = (store as { __voiceTurns: { milestones: { tap: number } }[] }).__voiceTurns
    expect(turns).toHaveLength(20)
    expect(turns[0].milestones.tap).toBe(5)
    expect(turns[19].milestones.tap).toBe(24)
  })
})
