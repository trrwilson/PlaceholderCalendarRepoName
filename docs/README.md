# docs/

Deep dives. The `AGENTS.md` files (repo root + `frontend/`, `backend/`,
`backend/app/voice/`) carry the durable rules; these files carry the detail and the
reasoning behind them. Every doc has YAML frontmatter with `status` and `summary` so
you can triage without opening it.

- **reference** — current and trustworthy; keep it updated when the area changes.
- **historical** — a record of a completed build. Good for *why* a thing is the way it
  is; may be stale on *how*. The code and the nearest `AGENTS.md` win on conflicts.
- **future** — a plan for work that is not built (or is parked upstream).

## Reference

| Doc | Summary |
|---|---|
| [audio-pipeline.md](audio-pipeline.md) | Sole authority on mic capture, the one gain stage, sample rates, echo cancellation, and playout. |
| [voice-commands.md](voice-commands.md) | What you can say to Mission Control today, what each does, and its limits. Keep current with tool/prompt changes. |
| [comparative-product-research.md](comparative-product-research.md) | Method + maintained catalogue for "has anyone else shipped this?" passes. |
| [controls-layout-design.md](controls-layout-design.md) | Design record for the header / dock / settings layout grammar. |
| [credits.md](credits.md) | Source + licence for every bundled media asset and trained model artifact. |
| [local-stt-evaluation.md](local-stt-evaluation.md) | Evidence behind the local STT engine choice and how to re-benchmark. |
| [wake-word-model-training.md](wake-word-model-training.md) | Training, licensing, and provenance of the "Mission Control" wake-word model. |
| [wake-word-model-training-notes.md](wake-word-model-training-notes.md) | Working notes for the WSL / GPU wake-word training environment. |
| [voice-provider-bakeoff-results.md](voice-provider-bakeoff-results.md) | Write-up of the comparative provider runs. |

## Historical (completed builds)

| Doc | Summary |
|---|---|
| [voice-support-plan.md](voice-support-plan.md) | The initial voice build (token endpoint + `app/voice/` + frontend session). |
| [voice-provider-bakeoff-plan.md](voice-provider-bakeoff-plan.md) | The multi-provider seam and end-of-speech-ownership design. |
| [local-voice-plan.md](local-voice-plan.md) | The local / hybrid pipeline build (experimental). |
| [voice-token-caching-notes.md](voice-token-caching-notes.md) | Token + snapshot caching and freshness rules. |
| [wake-word-plan.md](wake-word-plan.md) | The wake-word activation build. |
| [wake-word-provider-bakeoff.md](wake-word-provider-bakeoff.md) | openWakeWord vs Azure `.table`, the Invoke gate, and the recall-eval harness. |
| [voice-activation-ux-mvp.md](voice-activation-ux-mvp.md) | Keyword-activation UX MVP: content gate for leading silence, cue suppression, silent empty dismissal. Scoped to Azure Custom Keyword (basic) + Azure Voice Live. |
| [timer-plan.md](timer-plan.md) | The Timer tab build. |
| [timer-implementation-notes.md](timer-implementation-notes.md) | Timer build notes captured for review. |
| [lists-plan.md](lists-plan.md) | The grocery-list build. |
| [privacy-mode-plan.md](privacy-mode-plan.md) | The privacy-mode build and its ratified design resolutions. |
| [natural-names-notes.md](natural-names-notes.md) | How `display_name` is resolved per provider. |

## Future / parked

| Doc | Summary |
|---|---|
| [voice-activation-ux-plan.md](voice-activation-ux-plan.md) | Fixing staged + one-shot keyword activation: leading-silence tolerance, cue timing, keyword-free transcript, silent dismissal of empty queries. MVP slice built (see below); earcon classifier / shorter pre-roll lead / warm sessions still parked here. |
| [camera-support-plan.md](camera-support-plan.md) | Local webcam presence detection — designed, not started. |
| [display-dimming-plan.md](display-dimming-plan.md) | Backend-driven idle dimming of the physical panel (dim, not off); shares the presence-plan display seam. |
| [eufy-sdk-integration.md](eufy-sdk-integration.md) | Eufy camera events — blocked on an upstream SDK release. |
