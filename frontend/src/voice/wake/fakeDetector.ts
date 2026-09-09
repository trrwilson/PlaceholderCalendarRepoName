// A microphone-free wake detector for tests and manual UI work.
//
// Enabled by `VITE_WAKE_FAKE=1`. It never loads a model or opens the mic; a
// detection is triggered explicitly through `window.__missionControlWake`, which
// the Playwright wake test uses and which is convenient for styling the armed /
// listening UI without a trained "Mission Control" model on disk.

import type { WakeDetector, WakeDetectorConfig, WakeEvent } from './detector'

declare global {
  interface Window {
    __missionControlWake?: {
      /** Simulate hearing the wake phrase. */
      fireWake: (score?: number) => void
      /** Current detector state, for assertions. */
      state: () => { running: boolean; suspended: boolean }
    }
  }
}

export class FakeWakeDetector implements WakeDetector {
  running = false
  suspended = false
  private onWake: ((event: WakeEvent) => void) | null = null
  private readonly config: WakeDetectorConfig

  constructor(config: WakeDetectorConfig) {
    this.config = config
  }

  start(handlers: { onWake: (event: WakeEvent) => void }): Promise<void> {
    this.onWake = handlers.onWake
    this.running = true
    window.__missionControlWake = {
      fireWake: (score = this.config.threshold + 0.2) => {
        if (!this.running || this.suspended) return
        this.onWake?.({ score, at: performance.now() })
      },
      state: () => ({ running: this.running, suspended: this.suspended }),
    }
    return Promise.resolve()
  }

  suspend(): void {
    this.suspended = true
  }

  resume(): void {
    this.suspended = false
  }

  takeRetainedAudio(): string[] {
    return []
  }

  // Invoke-gate seam — no-ops for the fake (Playwright drives `fireWake`).
  endActivation(): void {}
  sendControl(): void {}

  dispose(): void {
    this.running = false
    this.onWake = null
    delete window.__missionControlWake
  }
}
