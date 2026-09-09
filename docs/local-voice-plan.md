---
status: historical
summary: The local / hybrid voice pipeline build (experimental).
---

# Local / Hybrid voice pipeline

Status: **implemented, experimental.** A fifth voice provider
(`MISSION_CONTROL_VOICE_PROVIDER=local`) that runs speech recognition and
intent/entity interpretation on the kiosk host and escalates to the cloud only
for requests that genuinely need general language reasoning. It is fully
selectable in Settings alongside the four cloud contestants and changes nothing
about them.

Companion docs: `docs/local-stt-evaluation.md` (the STT technology evidence),
`docs/voice-commands.md` (what voice understands), `docs/voice-provider-bakeoff-plan.md`
(the cloud bake-off this joins), `AGENTS.md` → "Voice assistant → Local / Hybrid
pipeline" (the durable principles).

## Why

Mission Control is an always-on household appliance. The ordinary voice
interaction — "show me tomorrow", "what's on this weekend", "set a timer for ten
minutes", "show Alex's calendar" — is a small, bounded command against live
in-app state. Routing every one of those through a full cloud speech-to-speech
session is slow, costs money on every utterance, and makes the kiosk useless when
the network is down. The goal:

> **Can the kiosk understand and act on this ordinary household request
> immediately and locally?** — with cloud reasoning as an *escalation capability*,
> not a mandatory hop.

## The pipeline

```
 wake word ("Mission Control")          ── existing, browser-resident, unchanged
      │                                     (docs/wake-word-plan.md)
      ▼
 audio capture  ── existing shared MicSource (frontend/src/voice/audio.ts)
      │
      ▼  16 kHz PCM16 over WS /api/voice/local  (single-use ticket, LAN-gated)
      │
 ┌────┴─────────────────────────  backend: app/voice/local/  ──────────────────┐
 │                                                                             │
 │  local streaming STT      recognizer.py + engines/  (faster-whisper today)  │
 │      │  transcript + confidence + timing                                    │
 │      ▼                                                                      │
 │  intent recognition       intents.py   → weighted-regex IntentMatch         │
 │      │                                                                      │
 │  date/time resolution     dates.py     → DateResolution (scope + narrowing) │
 │      │                                                                      │
 │  entity resolution        entities.py  → EntityMatch (fuzzy, vs live state) │
 │      │                                                                      │
 │  confidence + tiering     interpreter.py → Interpretation.disposition       │
 │      │                                                                      │
 │      ├── handled_locally ──► emit tool-call VoiceEvents ───┐                │
 │      ├── needs_clarification ──► assistant-transcript      │                │
 │      ├── rejected ──► assistant-transcript ("can't yet")   │                │
 │      └── escalate_to_cloud ──► escalation event + payload  │                │
 │                                                            │                │
 └────────────────────────────────────────────────────────────┼────────────────┘
                                                              ▼
   the kiosk executes the tools through the SAME dispatcher the cloud
   providers use  (frontend/src/voice/tools.ts `dispatchToolCall`)
                                                              │
                                                              ▼
   the display updates immediately; a spoken acknowledgement, if any, is
   independent  (cloud TTS is out of scope for this work — see Phase 7)
```

Every layer is a separate module and is **text-testable without a microphone or a
model**: `interpret(text, now=…, snapshot=…)` returns the whole decision.
`POST /api/voice/local/interpret` exposes exactly that over HTTP.

## Boundaries (what must stay separable)

| Concern | Module | Depends on |
| --- | --- | --- |
| raw transcription | `recognizer.py` + `engines/` | audio only — **no app knowledge** |
| intent classification | `intents.py` | text only |
| temporal expressions | `dates.py` | text + a clock |
| entity resolution | `entities.py` | text + a `CalendarSnapshot` |
| confidence + tier + plan | `interpreter.py` | all of the above |
| transport / turn loop | `session.py` | a `SpeechRecognizer`, a snapshot fn |
| grant | `adapter.py` | `Settings` |

Mission Control **never imports faster-whisper / sherpa-onnx directly** — only
`SpeechRecognizer`. The interpreter never touches an STT engine. The intent layer
never touches a calendar provider (it gets a snapshot). This is the "raw
transcription, semantic parsing, entity resolution, and execution logically
separable" requirement.

## The STT seam

```python
class SpeechRecognizer(Protocol):
    name: str
    streaming: bool
    def reset(self) -> None: ...
    def accept_audio(self, pcm16: bytes, *, sample_rate=16_000) -> list[RecognitionEvent]: ...
    def finalize(self) -> list[RecognitionEvent]: ...
    def close(self) -> None: ...
    @property
    def timings(self) -> RecognizerTimings: ...

# RecognitionEvent.type ∈ {"partial", "final", "endpoint", "error"}
```

Engines (`app/voice/local/engines/`), all lazily imported:

- **`faster_whisper_engine.py`** — the shipped default. Buffered, but a single
  greedy `int8` decode of a 1–3 s command is fast (see evaluation doc). Optional
  throttled mid-utterance partials.
- **`sherpa_onnx_engine.py`** — a genuinely streaming zipformer transducer with
  built-in endpointing. Written to the sherpa-onnx API; **unvalidated on this
  hardware** (same posture as the wake-word ONNX). Needs a model directory.
- **`scripted.py`** — dependency-free. Backs the tests and the `text` bypass
  frame; used automatically when no real engine is installed.

`MISSION_CONTROL_LOCAL_STT_ENGINE=auto` picks the first installed real engine,
else scripted. Model choice / device / compute type are all config
(`MISSION_CONTROL_LOCAL_STT_*`).

## Intent + entity layer

**Intents** are a small explicit catalogue (`intents.py`), each with weighted
regex *evidence* patterns, a tier, and `mutating` / `supported` flags. Matching
is `score = strongest trigger + small corroboration bonus`; never exact-string.
The catalogue covers calendar navigation/queries, person filtering, opening an
event, conflicts, the timer verbs (start / cancel / extend / pause / resume /
restart / query), and — deliberately as **recognised but `supported=False`** —
calendar writes, display power, and shopping lists.

**Entities** are resolved per turn against the live `CalendarSnapshot`
(`entities.py`), never a baked-in list:

- `resolve_person("mom")` → alias hint + fuzzy match over `display_name` / `name`
  / first-name of every household calendar, with an explicit score and the
  runner-up, so ambiguity is *reported* not guessed.
- `resolve_event("dentist", start, end)` → fuzzy title/category match within the
  date scope; "cost co" → "Costco" when one candidate is clearly best.
- `resolve_list(...)` → **always unresolved** (Mission Control has no list store),
  which is what turns "add milk to the Costco list" into a clean escalation.

**Dates** (`dates.py`): "tomorrow", "this weekend" (a *range*), "next Tuesday",
"the 14th", "June", "in 3 days", plus time-of-day narrowing ("Tuesday evening",
"after lunch", "after school"). Unknown phrasings return `kind == "none"` and the
interpreter escalates or asks.

## Tiers and the escalation decision

`Interpretation.disposition` is the explicit representation the task asks for:

| disposition | meaning | what the pipeline emits |
| --- | --- | --- |
| `handled_locally` | high confidence, entities resolved | `tool-call` events → `generation-complete` |
| `needs_clarification` | recognised, but an entity is missing/ambiguous, **or a mutation isn't safe to guess** | `assistant-transcript` (the question) |
| `rejected` | recognised, but Mission Control can't do it (calendar writes, display, lists) | `assistant-transcript` ("I can't … yet") |
| `escalate_to_cloud` | Tier 2 reasoning, or unknown | `escalation` event + bounded structured `payload` |

Tiers (`AGENTS.md` has the canonical list):

- **Tier 0** — `show tomorrow`, `open groceries`… deterministic, local.
- **Tier 1** — `what's Mom doing after school Wednesday`, `show Sarah's calendar`…
  local STT + parse + **live entity resolution**, still no cloud.
- **Tier 2** — `when can I have dinner with Sarah this week without conflicts`,
  `which day looks least busy`… local STT, then the *text* + only the necessary
  structured context escalates. **The cloud text call itself is an extension
  point (`CloudEscalator`), not wired in this task** — the pipeline emits the
  `escalation` event with the payload and says so out loud.
- **Tier 3** — genuinely conversational; use the richer cloud interface. Not
  built here.

**Safety:** a mutating request (move an event, add to an ambiguous list, cancel
an ambiguously-identified timer) below the mutation-confidence threshold is
**never executed** — it becomes `needs_clarification`. Calendar writes are
`rejected` unconditionally (voice is read-only, per `AGENTS.md`).

## UI responsiveness

The kiosk executes view-changing tools (`show_view`, `focus_date`,
`highlight_event`, `set_people_filter`) the instant the `tool-call` event
arrives — the display updates before any acknowledgement. For the two intents
whose answer is *spoken* not shown (`timer.query`, `calendar.conflicts`) the
pipeline waits for the tool result and templates a short reply into
`assistant-transcript` (the `VoiceOverlay` shows it). There is no local TTS; a
spoken acknowledgement would be an independent, non-blocking step.
`request received → TTS completed` is never a transaction boundary.

## Observability

Every turn emits a `diagnostic` VoiceEvent carrying the full `Interpretation`:
transcript, normalized text, intent scores (`candidates`), date resolution,
entity candidates + what resolved, confidence, disposition, `reason`, the planned
tool calls, and per-stage `timings_ms`. The frontend `LocalHybridVoiceProvider`
logs it (`[voice] local interpretation`) and stashes the latest on
`window.__voiceLocal`. `MISSION_CONTROL_LOCAL_VOICE_DIAGNOSTICS=false` mutes the
event. Raw audio is never persisted by this path.

`POST /api/voice/local/interpret {text}` returns the same object for any utterance
with no audio at all.

## Bypassing voice / testing without a microphone

- **Semantic layer, HTTP:** `POST /api/voice/local/interpret` with `{"text": "…"}`
  (LAN-gated, works even when `voice_enabled` is false).
- **Semantic layer, in the WS turn:** send `{"type": "text", "text": "…"}` instead
  of audio frames — the pipeline interprets it as if it had been transcribed.
- **Corpus sweep:** `python -m scripts.benchmark_local_stt intent` runs the whole
  `tests/data/voice_commands.jsonl` corpus and prints an intent/disposition
  accuracy table (currently 35/35).
- **Wake word** is already bypassable — push-to-talk (the Ask button) is always
  independent of it.

## Install & run

```bash
# backend
pip install faster-whisper          # pulls ctranslate2; onnxruntime already present
#   models download from Hugging Face on first use to the HF cache (or
#   MISSION_CONTROL_LOCAL_STT_MODELS_DIR). ~75 MB for base.en.

# backend/.env
MISSION_CONTROL_VOICE_ENABLED=true
MISSION_CONTROL_VOICE_PROVIDER=local          # or switch in Settings at runtime
MISSION_CONTROL_LOCAL_STT_ENGINE=auto         # faster_whisper when installed
MISSION_CONTROL_LOCAL_STT_MODEL=base.en       # tiny.en / base.en / small.en
MISSION_CONTROL_LOCAL_STT_DEVICE=auto         # cpu by default; =cuda to opt in
```

Then reload the kiosk, tap **Ask** (or say "Mission Control" if wake word is on),
and speak a command. Settings → "Voice provider" → "Local / Hybrid (on-device
STT)" switches to it live.

### GPU

`MISSION_CONTROL_LOCAL_STT_DEVICE=cuda` uses an NVIDIA GPU (float16) — requires
the CUDA 12 + cuDNN 9 runtime on `PATH`. `auto` is CPU: a discrete GPU is an
optional accelerator, never a requirement, and CPU int8 already meets the
interactive target (evaluation doc). A load failure on `cuda` falls back to CPU.

### Benchmarks

```bash
cd backend
python -m scripts.benchmark_local_stt stt --synthesize          # SAPI/espeak WAVs
python -m scripts.benchmark_local_stt stt --audio-dir ./voice-samples --engines faster_whisper
python -m scripts.benchmark_local_stt intent                    # no audio
```

`--synthesize` makes throwaway WAVs from the corpus text. Record real commands
into `backend/voice-samples/` (git-ignored) for a truer accuracy read.

## Known limitations

- **Cloud escalation is a stub.** Tier 2 emits the `escalation` event and payload
  and says so; it does not call a cloud text model yet. `CloudEscalator` is the
  seam.
- **No local TTS.** Spoken answers are limited to the templated
  `assistant-transcript` for timer/conflict queries; everything else relies on the
  display. Cloud TTS wiring is explicitly out of scope (Phase 7 of the task).
- **sherpa-onnx engine unvalidated on hardware.** The faster-whisper path is the
  proven one.
- **Time-of-day narrowing isn't applied to results.** "after lunch tomorrow"
  resolves the window and notes it, but the `get_agenda` tool returns the whole
  day — the display carries it.
- **Intent matching is regex evidence, not a model.** Novel phrasings that don't
  hit a trigger escalate (correct) but a very oblique in-scope request may
  escalate when it could have been handled. The corpus + tests guard the common
  space; widen the triggers as real misses show up.
- **The interpreter's clock** comes from the kiosk (`client_time` query param on
  the WS, `client_time` in the interpret body), like the cloud token path — the
  backend may run in UTC.
- **One STT model in memory per process**, reset between turns; concurrent turns
  are not supported (one kiosk, one turn — matches the rest of voice).

## Recommended next increment

1. Wire `CloudEscalator` to a Gemini/Azure **text** completion for Tier 2, passing
   only `Interpretation.escalation`. Keep it behind
   `local_cloud_escalation_enabled`.
2. Record a real local command corpus on the actual kiosk host and re-run the
   benchmark; tune `local_stt_model` and the confidence thresholds from it.
3. Validate the sherpa-onnx streaming engine on the target CPU; if its partials
   are good, switch the default for the perceived-latency win.
4. A tiny Settings sub-panel under "Local / Hybrid" for STT model + escalation
   toggle (the picker is already structured to grow — bake-off plan).
