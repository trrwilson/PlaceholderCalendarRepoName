---
status: historical
summary: The multi-provider voice seam and end-of-speech-ownership design.
---

# Voice provider bake-off — plan

Status: **all stages implemented; all four contestants connectivity-verified against the
live `mc-foundry-eastus2` Foundry resource** (2026-09-06) with
`backend/scripts/verify_voice_providers.py`:

- **Gemini Live** — verified end to end on the kiosk (`docs/voice-support-plan.md`).
- **Azure OpenAI Realtime** (`gpt-realtime-2.1`) and **mini** (`gpt-realtime-2.1-mini`)
  — full turn round-trip confirmed: `session.created` → committed audio →
  `response.output_audio.delta`. The GA `/openai/v1/realtime?model=` path + `api-key`
  header + GA session shape all accepted.
- **Azure Voice Live** — `session.created` + `session.updated` (URL,
  `api-version=2026-07-15`, `voice: {name, type}`, `azure_semantic_vad`, echo
  cancellation + noise reduction all accepted); audio stream accepted. Not yet driven
  with real speech.

Kiosk runs (2026-09-06) surfaced and fixed:
- the token cache re-served the **single-use relay ticket** to the next turn
  (`reusable_grant = False` → relay grants are never cached);
- a **stale backend** dropped GA-named events (restart fixes);
- **tool-call rounds aborted the turn** — the relay sent one `response.create` per tool
  output, racing the still-generating response ("let me check the calendar" cut off).
  Now `_RelayTurn` withholds `generation-complete` for a call-making response and sends
  exactly one follow-up `response.create` once all outputs are in;
- **no user transcript** — it's opt-in; `MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT`
  now defaults to `gpt-4o-transcribe` (verified deployed; `gpt-4o-mini-transcribe` is
  not). With manual turn control it transcribes after the commit, not word-by-word;
- the prompt now tells the model to call tools immediately without a "let me check".

The full round-trip (transcript → tools → single spoken answer) is verified live for all
three Azure contestants with `scripts/verify_voice_providers.py --relay`.

Voice Live specifically (2026-09-06): the first kiosk run hung — `azure_semantic_vad`
alone never endpointed. Fixed by making the kiosk drive the turn (commit +
`response.create` on `activity-end`) for Voice Live too, keeping `azure_semantic_vad`
only in the session (with `create_response: false`) because Voice Live requires
`turn_detection` set for its echo cancellation.

Still to do: the comparative on-kiosk runs with real speech, and the pick.
Supersedes nothing in `docs/voice-support-plan.md`.

## Goal

Run the same Mission Control voice experience against four integrated cloud
speech-to-speech providers and measure the **complete user-perceived interaction** for
each, so we can pick one for the kiosk:

| Contestant | `voice_provider` | Model / deployment |
| --- | --- | --- |
| Gemini Live | `gemini` | `gemini-3.1-flash-live-preview` (already shipped) |
| Azure Voice Live | `azure_voice_live` | `gpt-realtime` via the Voice Live wrapper |
| Azure OpenAI Realtime | `azure_openai_realtime` | `gpt-realtime-2.1` |
| Azure OpenAI Realtime (mini) | `azure_openai_realtime_mini` | `gpt-realtime-2.1-mini` |
| _Local / Hybrid_ | _(future)_ | _not built; not selectable; see `AGENTS.md`_ |

Non-goal for this task: the local/hybrid pipeline. We only **preserve the seams** for it
(`AGENTS.md` → "Voice assistant → Provider architecture"). No STT / intent-router /
escalation / TTS interfaces are built now.

## What already generalises, and what doesn't

The current code is Gemini-specific at the edges but the **middle is already
provider-neutral**, which is why this is a refactor and not a rewrite:

Already neutral (keep as-is):
- `app/voice/prompt.py` — plain-text system instruction. Every provider takes a system
  prompt.
- `app/voice/cache.py` — caches the minted grant + the calendar snapshot and invalidates
  on the next event boundary / local midnight / staleness cap / timezone change. Every
  provider stamps "it is now …" into a prompt, so this freshness logic is shared
  conversational semantics, not a Gemini detail.
- `frontend/src/voice/tools.ts` `dispatchToolCall` — takes `(name, args)` and returns a
  result object. Provider-independent.
- `frontend/src/voice/useVoiceSession.ts` — the state machine, mic RMS endpointing,
  adaptive jitter buffer, response watchdog, wake-word wiring. It already talks to the
  session object through a **narrow six-method interface** plus a `VoiceEvent` callback.
- `frontend/src/voice/audio.ts` — shared `MicSource`, `MicCapture`, `AudioSink`. Base64
  PCM16 both directions.
- `frontend/src/voice/instrument.ts` — `VoiceTimeline` / `MainThreadLagProbe`. The
  milestone names are mostly already neutral.

Gemini-specific (needs a seam):
- `app/voice/tokens.py` — builds a Gemini `LiveConnectConstraints` and calls
  `auth_tokens.create`.
- `app/voice/tools.py` `TOOL_DECLARATIONS` — Gemini function-declaration JSON
  (`"type": "OBJECT"`, uppercase).
- `app/models.py` `VoiceToken` — `token` / `api_version` / `manual_activity` are Gemini
  fields.
- `frontend/src/voice/session.ts` `GeminiVoiceSession` — `@google/genai`,
  `ai.live.connect`, `LiveServerMessage` → `VoiceEvent` translation.

## The seam

### Frontend: `ConversationalVoiceProvider`

`useVoiceSession` already depends only on this shape (extracted, not invented):

```ts
export interface ConversationalVoiceProvider {
  readonly timeline: VoiceTimeline
  readonly inputSampleRate: number
  readonly outputSampleRate: number
  readonly endpointing: EndpointingMode    // 'client' | 'hybrid' | 'provider' — see below
  connect(): Promise<void>                 // fetch grant, open transport, emit 'open'
  startActivity(): void                    // open the user's turn — client mode only, no-op otherwise
  endActivity(): void                      // finalise the user's turn (client/hybrid); no-op in provider
  sendAudio(base64Pcm16: string): void
  respondTool(id: string, name: string, response: Record<string, unknown>): void
  close(): void
}
```

`VoiceEvent`, `VoiceUnavailableError`, `VoiceSessionError` move to
`frontend/src/voice/providers/types.ts`. The `VoiceEvent` union stays the canonical
cross-provider conversation protocol — a future local/hybrid path emits the same events
without speaking any cloud wire protocol:

```
open | user-transcript{final} | assistant-transcript | audio | tool-call
| turn-complete | generation-complete | waiting-for-input | interrupted | closing | error
```

Layout:

```
frontend/src/voice/providers/
  types.ts        ConversationalVoiceProvider, VoiceEvent, error classes
  index.ts        createVoiceProvider(grant, onEvent, surface, timeline) → switch on grant.provider
  gemini.ts       (today's session.ts, unchanged behaviour)
  azureOpenAIRealtime.ts
  azureVoiceLive.ts
```

Each provider owns its transport internally. Two transport styles, one interface:
- **Direct** — browser holds the upstream session with a backend-minted short-lived
  credential (Gemini today; Azure OpenAI Realtime via WebSocket + ephemeral
  `client_secret`).
- **Relay** — browser connects to `wss://<our-backend>/api/voice/live` and the backend
  proxies to the provider, translating that provider's events to our `VoiceEvent`
  protocol on the way back (Azure Voice Live — see rationale below).

The mic sample rate becomes provider-driven: `MicCapture.start()` takes a target rate
(16 kHz Gemini, 24 kHz the Azure/OpenAI realtime protocol). `AudioSink` already resamples
output to the device rate; its `OUTPUT_RATE` constant becomes a per-stream value carried
on the first `audio` event's mime type.

### Backend: `VoiceProviderAdapter`

```
app/voice/providers/
  base.py     VoiceProviderAdapter protocol + VoiceGrant assembly helpers
  gemini.py   (today's tokens.py logic)
  azure_openai_realtime.py
  azure_voice_live.py
  __init__.py get_adapter(settings) → VoiceProviderAdapter
```

```python
class VoiceProviderAdapter(Protocol):
    id: VoiceProviderId
    def missing_config(self, s: Settings) -> str | None: ...        # None ⇒ ready
    async def create_grant(
        self, s: Settings, *, calendar_names: list[str], surface: str | None,
        now_local: datetime, timezone: str | None, client_time: str | None,
    ) -> VoiceGrant: ...
```

`cache.py` keeps ownership of freshness and calls `adapter.create_grant` where it now
calls `mint_token`. The cache key gains the provider id.

`app/models.py`:

```python
class VoiceGrant(BaseModel):
    provider: VoiceProviderId                      # "gemini" | "azure_openai_realtime" | ...
    model: str
    expires_at: datetime
    surface: str | None = None
    gemini: GeminiConnection | None = None         # exactly one connection block is set
    azure_realtime: AzureRealtimeConnection | None = None
    relay: RelayConnection | None = None
```

Each connection block is a small typed model (`GeminiConnection { token, api_version,
manual_activity }`, `AzureRealtimeConnection { url, client_secret, deployment,
api_version, expires_at }`, `RelayConnection { url, ticket }`). The matching frontend
provider reads only its own block. `VoiceToken` is renamed to `VoiceGrant`; the endpoint
stays `POST /api/voice/token` (rename the response model, not the route).

### Tools: one neutral spec, per-provider serialisation

`app/voice/tools.py`:
- `TOOL_SPECS` — neutral list: `{name, description, parameters}` with JSON-Schema
  lowercase types. Single source of truth; `TOOL_NAMES` stays the locked-set assertion
  anchor.
- `as_gemini_declarations()` — uppercase `"type": "OBJECT"` function declarations.
- `as_openai_tools()` — `{type: "function", name, description, parameters}` (used by both
  Azure OpenAI Realtime and Azure Voice Live).

`frontend/src/voice/tools.ts` is unaffected — it dispatches by name.

## End-of-speech ownership

**Legitimised 2026-09-07.** The original design made voice-activity / end-of-speech
detection the responsibility of the shared provider layer, full stop: `useVoiceSession`
ran a mic-RMS silence detector as *the* endpointer and the relay forced manual turn
control. That broke down — the OpenAI-realtime relay was hand-edited to `semantic_vad`
(which endpoints an incomplete phrase like "set a timer for…" correctly, where a
raw-energy detector cuts it off), and it "greatly improved the experience". This section
makes that a first-class, negotiated property.

`grant.endpointing` (`app.models.Endpointing`; `ConversationalVoiceProvider.endpointing`
on the frontend) is one of:

| mode | provider VAD | ends the user's turn | client activity brackets | mic-RMS endpointer |
| --- | --- | --- | --- | --- |
| `client` *(default / fallback)* | off | mic-RMS silence (`SILENCE_HOLD_MS`), `MAX_LISTEN_MS`, or Stop tap | yes — `activityStart`/`activityEnd` (Gemini), `activity-start`/`activity-end` (relay) | **primary** |
| `hybrid` | on, `create_response: false` | provider `speech-stopped` (**primary**); client finalises with `audioStreamEnd` / `activity-end` | finalise only | **backstop**, `SERVER_VAD_BACKSTOP_MS` |
| `provider` | on, `create_response: true` | provider entirely (VAD + auto response) | none | disabled — `MAX_LISTEN_MS` + Stop tap only |

`client` is the documented default applied whenever a provider declares nothing suitable.
`hybrid` unifies Gemini's "hybrid VAD" and the Azure `semantic_vad` path. `provider` is a
declared seam — no contestant uses it today.

Per-contestant mapping and knobs:

| contestant | default | knob | notes |
| --- | --- | --- | --- |
| Gemini | `hybrid` | `MISSION_CONTROL_VOICE_MANUAL_ACTIVITY=true` → `client` | the operator escape hatch adopted in 2026-09 for the silent-turn failure |
| Azure OpenAI Realtime (+ mini) | `hybrid` | `MISSION_CONTROL_AZURE_OPENAI_REALTIME_ENDPOINTING` (`client` \| `hybrid` \| `provider`) | `openai_turn_detection(mode)` builds `turn_detection` |
| Azure Voice Live | `hybrid` | `MISSION_CONTROL_AZURE_VOICE_LIVE_ENDPOINTING` (`hybrid` \| `provider`) | `azure_semantic_vad` must stay on for its echo canceller, so `client` is unavailable |
| Local / Hybrid | `client` | — | a streaming STT engine may still self-endpoint early by emitting its final transcript mid-turn — an optimization within `client` |

Wiring: each adapter has a `default_endpointing` class attribute and writes the effective
mode onto the grant in `create_grant`. `relay.py` carries it on `UpstreamConfig` and
`_RelayTurn`; `translate_client` omits `response.create` from `activity-end` in `provider`
mode. `useVoiceSession` captures `session.endpointing` at turn start into `endpointingRef`
and switches its `handleLevel` / `speech-stopped` strategy on it — it no longer infers
ownership from whether a `speech-stopped` event happened to arrive. `VoiceTurnReport`
records the mode.

## Provider connection details

### Gemini (`gemini`) — unchanged
Browser-direct. `auth_tokens.create` with `LiveConnectConstraints`; `v1beta`; the grant
carries `token` / `api_version` / `endpointing` (see "End-of-speech ownership").

### Azure OpenAI Realtime (`azure_openai_realtime`, `azure_openai_realtime_mini`)
Browser-direct over WebSocket.
- Backend `POST {azure_openai_endpoint}/openai/realtimeapi/sessions?api-version=…` with
  the session config (`instructions`, `tools`, `voice`, `turn_detection`,
  `input_audio_format: pcm16`, `input_audio_transcription`, `modalities: ["audio","text"]`).
  Response `client_secret.value` (~60 s TTL) → `AzureRealtimeConnection`.
- Browser opens `wss://{endpoint}/openai/realtime?api-version=…&deployment={deployment}`
  with `Authorization: Bearer {client_secret}` via the WebSocket subprotocol header trick
  the SDK uses, or the `?access_token=` query param if header injection isn't possible
  from the browser (decide in the spike; query-param tokens are short-lived and LAN-only).
- The two contestants differ only by `deployment`
  (`azure_openai_realtime_deployment` vs `…_mini_deployment`) and `model` label.
- Event mapping: `input_audio_buffer.append` ← `sendAudio`; `.commit` ← `endActivity`
  (manual) or rely on `server_vad`; `conversation.item.input_audio_transcription.delta/
  completed` → `user-transcript`; `response.audio.delta` → `audio`;
  `response.audio_transcript.delta` → `assistant-transcript`;
  `response.function_call_arguments.done` → `tool-call`; `response.done` →
  `generation-complete` + `turn-complete`; `error` → `error`.
- Tool result: `conversation.item.create {type: function_call_output}` then
  `response.create`.

### Azure Voice Live (`azure_voice_live`) — backend relay
Voice Live's value-add (input noise reduction, server-side acoustic echo cancellation,
Azure semantic VAD, HD voices) is server-side, and browser-direct auth to
`…/voice-live/realtime` is awkward (the browser `WebSocket` API can't set `Authorization`
and Voice Live expects `api-key`/AAD in a header). So:
- New endpoint `WS /api/voice/live` (LAN-gated, ticket from the grant). The backend opens
  the upstream Voice Live socket with the resource key, forwards mic audio up, and
  translates Voice Live server events down to our `VoiceEvent` JSON protocol.
- Adds one audio-path hop through FastAPI — a **legitimate bake-off result**, measured,
  not a disqualifier. This is exactly the "integrated realtime provider, don't
  artificially decompose it" case from `AGENTS.md`; the relay is transport, not a
  decomposition of the conversation.
- Session config mirrors the OpenAI realtime shape plus `input_audio_noise_reduction`,
  `input_audio_echo_cancellation`, `turn_detection: {type: azure_semantic_vad}`.

The relay's downlink protocol **is** our `VoiceEvent` union serialised as JSON frames
(audio as base64) — so `frontend/src/voice/providers/azureVoiceLive.ts` is thin, and any
future local/hybrid backend can reuse the same relay contract.

## Config (`app/config.py`)

```python
voice_provider: Literal[
    "gemini", "azure_voice_live", "azure_openai_realtime", "azure_openai_realtime_mini"
] = "gemini"

# Azure — shared
azure_openai_endpoint: str | None = None
azure_openai_api_key: str | None = None
azure_openai_api_version: str = "2025-04-01-preview"
azure_openai_realtime_deployment: str = "gpt-realtime-2.1"
azure_openai_realtime_mini_deployment: str = "gpt-realtime-2.1-mini"
azure_openai_realtime_voice: str = "marin"

azure_voice_live_endpoint: str | None = None      # {region}.api.cognitive.microsoft.com
azure_voice_live_api_key: str | None = None
azure_voice_live_model: str = "gpt-realtime"
azure_voice_live_voice: str = "en-US-Ava:DragonHDLatestNeural"
```

`voice_enabled` stays the master switch. The 409 "not configured" check becomes
provider-aware via `adapter.missing_config()`.

### Runtime provider override (bake-off affordance)

Comparing providers means switching between them without an `.env` edit + restart per
turn. Add:
- `GET /api/voice/config` → `{ enabled, provider, available: [ids the backend can serve] }`
- `PUT /api/voice/config { provider }` — LAN-gated, sets a **process-memory override**
  (like the timer store; a restart reverts to the `.env` value). Not persisted, not a
  per-viewer preference.

The token/grant path reads the effective provider (override ?? `settings.voice_provider`).
The provider cache is cleared on override change.

## Settings UI

New "Voice" section in the settings popover (above "Wake word"), shown only when
`GET /api/voice/config` reports `enabled`:
- A provider picker (`<select>` / segmented control) listing `available` providers by
  friendly name. Changing it `PUT`s the override and clears the current session.
- A one-line status note (active provider + model).

This section is **structured to grow**: when Local / Hybrid ships it becomes another
option here, and its sub-controls (speech recognition, intent router, escalation model,
speech output) nest beneath it. None of that is built now, and Local / Hybrid does not
appear in the list until it exists.

Wake-word selection stays its own separate control — orthogonal, as `AGENTS.md` requires.

## Bake-off measurement

`VoiceTimeline` milestone names are canonicalised so every provider emits the same set
(the list in `AGENTS.md` point 10):

| Milestone | mark |
| --- | --- |
| activation / input start | `tap` / `wake-detected` → `mic-started` |
| end of user speech | `user-turn-end` |
| transcription available | `input-transcript-first` (and `interim-transcript-first`) |
| intent / tool decision | `tool-call` |
| tool invocation / completion | `tool-call` → `tool-response` |
| cloud escalation | _(n/a for the cloud contestants; mark reserved)_ |
| first response audio | `audio-first-chunk` |
| interruption / cancellation | `interrupted` / `tool-call-cancelled` |
| errors and recovery | `failed` / `response-watchdog-fired` |

Add a single end-of-turn structured emit: `useVoiceSession` assembles a `VoiceTurnReport`
`{ provider, model, ok, milestones: {…deltas}, audio: arrivalStats, lag: lagSummary }`
and (a) logs it as one line `[voice] turn-report {json}` for grep, (b) retains the last
~20 on `window.__voiceTurns` for extraction during a bake-off session. Results are
written up by hand in `docs/voice-provider-bakeoff-results.md` (no datastore).

## Testing

Backend:
- `tests/test_voice.py` splits: shared endpoint/cache tests (provider-parametrised where
  they assert grant freshness), plus `test_voice_gemini.py` / `test_voice_azure_*.py` for
  each adapter's `create_grant` (HTTP faked with `respx`; assert the locked session
  config — tools, prompt, voice, VAD — and the short credential TTL).
- Locked-tool-set assertion runs per provider (each adapter serialises `TOOL_SPECS`).
- `PUT /api/voice/config` override: switches the effective adapter, clears the cache,
  LAN-gated.
- Azure Voice Live relay: unit-test the event translation both directions with a fake
  upstream socket; LAN gate on `WS /api/voice/live`.

Frontend:
- `providers/gemini.test.ts` — the existing `session.ts` coverage, moved.
- `providers/azureOpenAIRealtime.test.ts`, `providers/azureVoiceLive.test.ts` — feed
  canned server frames, assert the `VoiceEvent` stream and the uplink calls.
- `useVoiceSession.test.ts` — unchanged; it already mocks the provider seam. Add one test
  that `createVoiceProvider` picks the implementation from `grant.provider`.
- e2e `voice.spec.ts` — `VITE_VOICE_FAKE` scripted provider stays provider-agnostic.

## Rollout

1. **Seam + Gemini refactor (behaviour-preserving). — DONE.** Backend:
   `app/voice/base.py` (`VoiceProviderAdapter` protocol, `VoiceUnavailable`, `local_now`),
   `app/voice/providers/{__init__,gemini}.py` (`get_adapter`, `GeminiAdapter` — the old
   `tokens.py` logic), `tools.py` gains a neutral serialiser pair
   (`as_gemini_tools` / `as_openai_tools`), `cache.py` calls `adapter.create_grant` and
   keys the cache by provider id, `VoiceToken` gains `provider`, `config.py` gains
   `voice_provider` (only `gemini` implemented — others 409). Frontend:
   `voice/providers/{types,gemini,index}.ts` (`ConversationalVoiceProvider`,
   `GeminiVoiceProvider`, `createVoiceProvider`); `session.ts` removed; `useVoiceSession`
   and the two state-machine test suites use the factory. `VoiceToken` was **not** yet
   renamed to `VoiceGrant` / given nested connection blocks — deferred to stage 3 when a
   second grant shape actually exists (avoid speculative churn). Backend 88 tests + ruff,
   frontend 90 tests + lint + tsc + build + voice e2e all green.
2. **`GET/PUT /api/voice/config` + Settings picker. — DONE.** `VoiceConfig` /
   `VoiceConfigUpdate` / `VoiceProviderInfo`; process-memory provider override in
   `app/voice/providers/__init__.py` (`effective_provider` / `set_provider_override`,
   `PROVIDER_LABELS`, `provider_configured`); `PUT` clears the token cache. Frontend
   `useVoiceConfig` hook + "Voice provider" picker in the Settings popover
   (unimplemented / unconfigured contestants disabled).
3. **Azure OpenAI Realtime + Azure Voice Live via a backend relay. — DONE.** Both Azure
   contestants relay through `WS /api/voice/live` (`app/voice/relay.py`) — the browser
   `WebSocket` API can't set the `api-key` header. The relay translates realtime events ↔
   `VoiceEvent` JSON; end-of-speech follows `grant.endpointing` (default `hybrid` —
   `semantic_vad` with `create_response: false` + the kiosk's `speech-stopped` endpoint;
   see "End-of-speech ownership"). Grant carries a single-use ticket.

   **Verified against current Microsoft/OpenAI docs (2026-09) — the two Azure products
   are not one protocol:**
   - **Azure OpenAI Realtime** — the GA `/openai/v1/realtime` surface: OpenAI-parity,
     **no `api-version`**, `?model=<deployment>` (not `deployment=`; mixing GA/preview is
     a 404), the GA event model — `session.type: "realtime"`, `output_modalities`, nested
     `audio.input`/`audio.output`, `response.output_audio.delta` /
     `response.output_audio_transcript.delta`. `audio.input.transcription.model` is a
     *deployment name* (optional). Auth: `api-key` header (server-side, our relay) or
     `Authorization: Bearer`. `build_openai_ga_session`.
   - **Azure Voice Live** — a separate product, still
     `?api-version=2026-07-15&model=…`, host `<resource>.services.ai.azure.com`, the
     flat/beta session (`modalities`, `voice` as an **object** `{name, type}`).
     `build_voice_live_session`. `turn_detection` **must** be set — the live resource
     rejects echo cancellation "when turn detection is disabled" and then kills the
     session — so `client` end-of-speech is unavailable here; the default is `hybrid`
     (`azure_semantic_vad` with `create_response: false`, the kiosk endpoints on the
     forwarded `speech-stopped` and asks for the reply on `activity-end`). Verified live:
     the VAD alone never endpoints a tone and can stall a hesitant speaker — hence the
     kiosk backstop; a benign `input_audio_buffer_commit_empty` (the commit racing the
     VAD) is logged and swallowed and the reply still comes back.

   `translate_upstream` accepts both event-name sets. Unit-tested
   (`test_voice_relay.py`, `providers/relay.test.ts`) incl. one end-to-end relay run
   against a fake upstream, and connectivity-verified against the live resource
   (`scripts/verify_voice_providers.py`).
4. _(folded into 3)_
5. **Measurement pass. — DONE (instrumentation).** `VoiceTurnReport` +
   `recordVoiceTurn` (`instrument.ts`): every turn logs `[voice] turn-report {json}` and
   the last 20 land on `window.__voiceTurns`, grouped by `provider` / `model` /
   `endpointing` lifted off the `token-received` mark.
   `docs/voice-provider-bakeoff-results.md` is the write-up
   template. The on-kiosk runs of a fixed script across all four contestants — and the
   pick — still need real hardware + Azure credentials.

## What's missing

Resolved: URLs / event models / auth / session shapes (from docs, then
**confirmed live** against `mc-foundry-eastus2` — see Status). The deployments
`gpt-realtime-2.1` / `-mini` exist and complete a full turn. Voice Live accepts
the `2026-07-15` config with `azure_semantic_vad`.

Left to do:

1. **The comparative on-kiosk runs with real speech** — the whole point. Run the fixed
   script in `voice-provider-bakeoff-results.md` per contestant, pull `window.__voiceTurns`,
   fill in the tables, pick one.
2. **Voice Live under real speech** — the connectivity check can't trip its VAD. Confirm
   `hybrid` end-of-speech timing on the kiosk (`speech-stopped` → `activity-end` →
   reply), and whether `provider` mode (`create_response: true`, no client finalise) is
   the better trade for this product.
3. **User transcript on the Azure OpenAI path** — optional; set
   `MISSION_CONTROL_AZURE_OPENAI_TRANSCRIBE_DEPLOYMENT` to a transcribe-model deployment.
4. **Tool-call streaming shape** — we only handle `response.function_call_arguments.done`
   (full args). Add `.delta` accumulation if a run shows partial args.
5. **End-of-speech mode for Azure OpenAI Realtime** — resolved: negotiated via
   `MISSION_CONTROL_AZURE_OPENAI_REALTIME_ENDPOINTING`, default `hybrid` (`semantic_vad`
   + `create_response: false` + the kiosk's `speech-stopped` endpoint and mic-RMS
   backstop). The measurement pass can compare `client` / `hybrid` / `provider` per turn
   from the `endpointing` field on `VoiceTurnReport`.
