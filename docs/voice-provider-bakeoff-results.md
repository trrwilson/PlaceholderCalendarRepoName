---
status: reference
summary: Write-up of the comparative voice-provider runs.
---

# Voice provider bake-off — results

Write-up of the comparative runs. Plan and architecture:
`docs/voice-provider-bakeoff-plan.md`. Gemini's own iteration history is in
`docs/voice-support-plan.md`.

Status: **not yet run.** The harness is in place (provider seam, Settings
picker, `VoiceTurnReport` instrumentation); the Azure contestants need live
Azure credentials + an on-Azure spike before a fair comparison, then on-kiosk
runs of the fixed script below.

## How to run

1. Configure the contestant(s) in `backend/.env` (see `.env.example`):
   Gemini needs `GEMINI_API_KEY_MISSION_CONTROL`; the Azure ones need their
   `*_ENDPOINT` + `*_API_KEY`. `MISSION_CONTROL_VOICE_ENABLED=true`.
2. On the kiosk, Settings → **Voice provider** → pick a contestant (this is a
   process-memory override; it applies to the next turn and reverts on restart).
3. Run the fixed script (below), tapping Ask for each line.
4. Pull the measurements: `window.__voiceTurns` in the kiosk console (last 20
   turns) or grep the console for `[voice] turn-report`. Each entry is a
   `VoiceTurnReport` — `provider`, `model`, `ok`, `milestones` (ms from tap),
   `audio` (realtime ratio / underruns / jitter depth), `lag` (main-thread lag).
5. Repeat for each contestant. Paste the numbers into the tables here.

## Fixed script

Same phrases, same order, several times per contestant (cold session each time —
one session per turn):

| # | Say | Expects |
|---|-----|---------|
| 1 | "What's on today?" | Home view; a spoken count + notable items |
| 2 | "What about tomorrow?" | Week view on tomorrow; spoken answer |
| 3 | "When's the next dentist appointment?" | `highlight_event`; detail sheet opens |
| 4 | "Is anything clashing on Saturday?" | `check_conflicts`; spoken yes/no |
| 5 | "Set a ten minute timer" | timer starts; Timer view; one-sentence confirm |
| 6 | "Add five minutes" | `extend_timer`; confirm |
| 7 | "Stop the timer" | `cancel_timer` |
| 8 | _(tap, say nothing)_ | quiet return to idle, no error |

## Milestones that matter (from `VoiceTurnReport.milestones`)

- `tap` → `mic-started` — activation cost
- `mic-first-chunk-sent` → `user-turn-end` — the person speaking
- `user-turn-end` → `input-transcript-first` — transcription latency
- `input-transcript-first` → `tool-call` — intent decision
- `tool-call` → `tool-response` — our own dispatch (should be tiny)
- `tool-response` → `audio-first-chunk` — provider "thinking" to first audio
- `audio` arrival: `audio.realtimeRatio` (≥1 is smooth; Gemini native-audio has
  run 0.26–0.46), `audio.underruns`, `audio.prebufferMs`
- `lag.maxLagMs` — if high, the kiosk render path is starving the socket, not the
  provider

## Per-contestant results

### Gemini Live (`gemini-3.1-flash-live-preview`)

_paste turn-reports / medians_

### Azure Voice Live (`gpt-realtime`)

_unverified — needs Azure spike_

### Azure OpenAI Realtime (`gpt-realtime-2.1`)

_unverified — needs Azure spike_

### Azure OpenAI Realtime mini (`gpt-realtime-2.1-mini`)

_unverified — needs Azure spike_

## Verdict

_TBD — the contestant chosen for the kiosk, and why._
