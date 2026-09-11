---
status: future
summary: Provider-neutral presence-signal contract (PresenceSignal, sources, aggregator) shared by the kiosk activity seam (camera-support-plan.md, display-dimming-plan.md) and ambient/remote signals (eufy-sdk-integration.md). Designed, not started.
---

# Mission Control: presence module — the general signal contract

`camera-support-plan.md` designs a local webcam feeding a kiosk display-wake/sleep
policy. `eufy-sdk-integration.md` designs an *outside* camera's events feeding
ambient household status. Both need "is someone here / did something just happen"
as an input, and both already gesture at sharing a policy (eufy-sdk-integration.md
§8; display-dimming-plan.md → "Relationship to presence work"). Neither has picked
a shape a third signal type — geofencing, a future indoor sensor — could join
without a rewrite.

This document is that shape: a small, provider-neutral **presence signal**
envelope and the minimal plumbing (`observe()`, an aggregator, one ingestion
endpoint) that any current or future source implements. It does not replace or
re-litigate the decisions already locked in the docs above — it is the contract
their sources and their consumers both target, so the kiosk activity seam and the
ambient camera-events pipeline stay two instances of one shape instead of two
unrelated ones.

**Not a general event bus.** `AGENTS.md` is explicit that real-time stays "one
small typed endpoint, not an event bus." This module does not change that: it
adds exactly one new ingestion function and (for the one class of signal that
cannot reach the backend in-process) exactly one new endpoint. Everything
downstream still rides the existing `/api/ws` / `ApplicationMessage` channel.

---

## Status

**Planning, with a first implementation slice.** Decisions below drafted
2026-09-10, alongside the camera and eufy plans they generalize. `app/models.py`
(`PresenceSignal`/`PresenceSignalKind`/`PresenceScope`/`PresenceState`) and
`app/presence/aggregator.py` (`PresenceAggregator`) are built and match this
doc's shape; the only producer wired to them so far is the `kiosk`-scope
local-camera **motion** source (`camera-support-plan.md`'s Phase 1 MVP, coarse
motion only — not the real presence/person detector that doc's own "Phase 1
build spec" describes). No `zone`-scope source, no `POST /api/presence/signal`,
and no consumer beyond the diagnostics endpoint exist yet. Treat the rest as the target
shape for `camera-support-plan.md`'s Phase 1 (see that doc's "Phase 1 build spec"
section, added alongside this one) and for whichever remote source ships next.

## Two scopes, two trust levels

Every signal belongs to exactly one scope, and scope is what decides whether a
signal is allowed to touch display power:

| Scope | Meaning | Example sources | Can drive display sleep/wake? |
| --- | --- | --- | --- |
| `kiosk` | This device — the kiosk PC and the panel physically attached to it. | Touch, voice, active timer, wake-word activation, the **local** webcam detector | **Yes — the only scope that can.** |
| `zone:<name>` | Anywhere else with semantic meaning to the household: a named place (`zone:front_door`) or a named person (`zone:household:alex`). | An outside camera's motion/person/doorbell events, a future geofence | No — advisory only, surfaced as ambient status. |

This formalizes what `eufy-sdk-integration.md` §8 already says in prose ("keep
local webcam presence detection independent and authoritative for sleep
decisions") as a structural rule instead of a convention someone could forget
when a third source is added.

## Decisions locked in

| Question | Decision |
| --- | --- |
| Envelope | One `PresenceSignal` model (below), in `app/models.py` alongside `CameraEvent` / `HouseholdException` — not a replacement for either, a common shape sources translate into at their own boundary, same rule calendar providers follow for SDK types. |
| Ingestion | Exactly one function every source ultimately calls: `PresenceAggregator.observe(signal)`. In-process sources (anything running inside the FastAPI process — the local camera thread, `app/eufy/service.py`) call it directly. The one out-of-process exception gets exactly one endpoint: `POST /api/presence/signal`. No second ingestion path is added later without amending this doc. |
| Trust boundary | `kiosk`-scope signals are LAN-only, `_require_local`-gated — same as every other mutating endpoint, including the planned `POST /api/presence/activity` (camera-support-plan.md). `zone`-scope signals over `POST /api/presence/signal` may legitimately originate off-LAN (a phone leaving Wi-Fi range for geofencing); that endpoint gets a narrow, explicit `presence_remote_token` shared-secret check instead of a blanket `_require_local` loosening — mirrors the existing `allow_remote_auth` escape hatch (`backend/AGENTS.md`), not a precedent for relaxing the gate elsewhere. |
| Aggregator | A pure, testable policy object per scope — injected clock, same house style as `MockCalendarProvider`'s injected `today` and the display-dimming policy. One aggregator process singleton; per-scope hysteresis/debounce config, not one global timeout. |
| Kiosk-scope output | Feeds the inactivity/display policy in-process (camera-support-plan.md, display-dimming-plan.md). No network hop, no serialization — same process. |
| Zone-scope output | Builds an `ApplicationMessage` / `HouseholdActivity` and calls `app/realtime.py`'s `broadcast()` — the channel eufy-sdk-integration.md already designs. Never reaches the display policy. |
| Persistence | None. Aggregator state is in-memory, per scope — consistent with "persistence is deliberately minimal" (`AGENTS.md`). A restart clears activity history; current scope state is cheap to re-derive from the next signal. |
| Module layout | `app/presence/` package: `aggregator.py` (the pure policy), `sources/` (thin adapters — a fixed, reviewed list, not a plugin registry). `PresenceSignal` and its enums live in `app/models.py` per the repo's "models.py is the contract" rule; `app/presence/` holds logic only. |
| Feature-flag posture | The aggregator is constructed and runs only if at least one concrete source's own flag is enabled (`presence_enabled`, `eufy_enabled`, a future `presence_geofence_enabled`, …). Zero source flags on ⇒ zero presence code imported or running, matching the "disabled ⇒ zero cost" rule both `camera-support-plan.md` and `eufy-sdk-integration.md` already commit to. |
| No registry | Sources are a fixed set of modules under `app/presence/sources/`, each wired explicitly in `app/main.py` lifespan startup behind its own flag — not a dynamic plugin/config-driven list. Consistent with `AGENTS.md`: "avoid an interface with no foreseeable second implementation" and camera-support-plan.md's "do not create a large pluggable framework merely to support hypothetical future detectors." |

---

## The signal envelope

```python
# app/models.py

class PresenceSignalKind(StrEnum):
    activity = "activity"      # discrete "someone just interacted" pulse — no
                                # standing presence claim (touch, voice, a timer
                                # pulse, wake-word activation)
    presence = "presence"      # continuous claim: someone is / isn't there now
    motion = "motion"          # transient pulse, weaker than `presence` — no
                                # standing state implied (e.g. a camera's raw
                                # motion event, before/without person detection)
    zone_entry = "zone_entry"  # a person/device entered a named zone
    zone_exit = "zone_exit"    # a person/device left a named zone


class PresenceScope(BaseModel):
    kind: Literal["kiosk", "zone"]
    id: str  # "kiosk" always for kind="kiosk"; "front_door", "household:alex", … for "zone"


class PresenceSignal(BaseModel):
    source_id: str                       # "touch" | "voice" | "wake_word" | "timer"
                                          # | "local_camera" | "eufy:<serial>" | "geofence:<id>"
    scope: PresenceScope
    kind: PresenceSignalKind
    value: bool | None = None            # presence: True=present; zone_entry/exit: always True
    confidence: float | None = None      # 0..1, when the source has one
    detail: str | None = None            # short human-readable extra (rarely shown)
    observed_at: datetime                # naive local time, converted at the source boundary
```

`activity` vs `presence` vs `motion` are deliberately distinct: an `activity`
pulse (touch, voice, a timer) is evidence someone is interacting *right now* but
implies nothing about the next moment; `presence` is a standing claim a detector
actively maintains (and retracts) over time; `motion` is a weaker transient than
`presence` for sources that see movement without confirming a person (raw camera
motion, a proximity sensor). The kiosk activity seam in `camera-support-plan.md`
uses `activity` (touch/voice/wake_word/timer pulses) and `presence` (the local
camera's PRESENT/ABSENT); `eufy-sdk-integration.md`'s events map mostly to
`motion` and `presence`, with `zone_entry`/`zone_exit` reserved for geofencing.

## Source contract

A source is any code that calls `aggregator.observe(signal)`. That is the entire
contract — there is no base class, no registration step, no discovery mechanism.
Two shapes cover every source this doc anticipates:

- **In-process** (the common case): the source runs inside the FastAPI process —
  a background thread (local camera), a long-lived service (`app/eufy/service.py`
  mapping its own `CameraEvent`s), or a request handler (a touch/voice activity
  ping) — and calls `observe()` directly, synchronously. No network hop, no new
  dependency.
- **Out-of-process** (the one deliberate exception): a source that cannot reach
  the backend process directly — today, only a future geofence webhook fits this.
  It calls `POST /api/presence/signal`, which does nothing but validate and call
  `observe()` on the caller's behalf. This is not a general webhook framework;
  it is one endpoint with one job.

| Source | Scope | Kind(s) | Calling shape | Status |
| --- | --- | --- | --- | --- |
| Touch / voice / wake-word / timer pulses | `kiosk` | `activity` | In-process, from `app/api.py` handlers | Planned — `camera-support-plan.md` Phase 1 |
| Local webcam detector | `kiosk` | `presence` | In-process, background thread | Planned — `camera-support-plan.md` Phase 1 |
| eufy camera events | `zone:<camera name>` | `motion`, `presence` | In-process, mapped from `CameraEvent` in `app/eufy/service.py` | Blocked on upstream SDK — `eufy-sdk-integration.md` |
| Geofencing | `zone:household:<member>` | `zone_entry`, `zone_exit` | Out-of-process, `POST /api/presence/signal` | Not designed; scope reserved only |

Note the eufy bridge process itself (`eufy-bridge/`, Node, talking to the eufy
cloud) is *not* the out-of-process presence source — `app/eufy/service.py`,
already inside the backend, is. The bridge is eufy-sdk-integration.md's own
concern and does not touch this contract directly.

## The aggregator

```python
# app/presence/aggregator.py

class PresenceState(BaseModel):
    scope: PresenceScope
    present: bool                 # current best-effort standing claim for this scope
    last_signal_at: datetime | None
    last_activity_at: datetime | None   # most recent `activity`-kind pulse, any kind

class PresenceAggregator:
    def __init__(self, *, now: Callable[[], datetime], on_change: Callable[[PresenceState], None]): ...
    def observe(self, signal: PresenceSignal) -> None: ...
    def state(self, scope: PresenceScope) -> PresenceState: ...
```

- One aggregator instance, many independently-configured scopes — per-scope
  hysteresis (a single missed `presence=False` doesn't flip `present`;
  `zone_entry`/`zone_exit` are edge-triggered, not debounced) lives inside
  `observe()`, keyed by `scope`.
- `on_change` fires only on an actual state transition, never on a repeated
  identical observation — the same "don't re-issue identical commands" rule
  `camera-support-plan.md` and `display-dimming-plan.md` already apply to
  `DisplayController`.
- The `kiosk` scope's `on_change` is wired, in-process, straight into the
  display/dim inactivity policy. Every other scope's `on_change` builds an
  `ApplicationMessage` and calls `broadcast()`.
- Pure and clock-injected so it is unit-testable with zero I/O, mirroring
  `MockCalendarProvider`.

## API shape

| Endpoint | Purpose | Gating | Notes |
| --- | --- | --- | --- |
| `POST /api/presence/activity` | Sugar for `observe()` with `scope=kiosk, kind=activity`. Body: `{"source": "touch" \| "voice" \| "wake_word" \| "timer"}`. | `_require_local`. **Not** `_require_unlocked` — a touch while privacy-locked must still count as activity, same documented exception `display-dimming-plan.md` already carves out. | Already planned by `camera-support-plan.md`; this doc fixes its exact shape. |
| `POST /api/presence/signal` | The one out-of-process ingestion path, `PresenceSignal` body. | `_require_local` **or** a valid `presence_remote_token` — the narrow off-LAN allowance for `zone`-scope sources like geofencing. Rejects any `scope.kind == "kiosk"` from a non-local caller: a remote source cannot claim to be the kiosk itself. | New. Unused until a real out-of-process source (geofencing) is built — added now so the contract has a stable home. |
| `GET /api/presence` | Diagnostics/config snapshot: effective `PresenceSettings`, `PresenceState` per known scope, which sources are enabled. | none (read-only, matches `/api/display`, `/api/household`) | Superset of `camera-support-plan.md`'s originally-sketched diagnostics endpoint. |

No new WebSocket, no new message type beyond the `ApplicationMessage` extension
`eufy-sdk-integration.md` already plans for zone-scope activity.

## Relationship to the existing docs

- **`camera-support-plan.md`** implements the `kiosk` scope end-to-end and owns
  the actual display/dim inactivity policy that consumes it. Its Phase 1 targets
  this contract from the start — see that doc's "Phase 1 build spec" section.
  Nothing in its already-locked decisions changes; `note_activity(source, at)` /
  `set_presence(state, at)` are the concrete `kiosk`-scope calls into
  `PresenceAggregator.observe()`.
- **`display-dimming-plan.md`** already states it shares "the activity seam"
  with the camera plan — that seam is this module's `kiosk` scope. Its built
  Stage 1 (`app/host.py`, `app/display.py`) is unaffected; only the not-yet-built
  inactivity policy and `POST /api/presence/activity` are in scope here, and
  their shape hasn't changed from what that doc already documents.
- **`eufy-sdk-integration.md`** §8 already anticipates feeding eufy events into
  "the same presence/inactivity policy as an extra activity input." That input
  is a `zone`-scope source under this contract. No change to its blocked status
  or its own `CameraEvent`/`HouseholdActivity` design — only the small mapping
  step (`CameraEvent` → `PresenceSignal`) is new, and it is not needed until that
  doc's Phase 2 unblocks.

## Non-goals

- A generalized event bus, plugin registry, or dynamically-configured source
  list — sources are a fixed, reviewed set of modules, each wired explicitly.
- Remote/`zone`-scope signals ever becoming authoritative for display sleep or
  wake. That stays `kiosk`-scope only, permanently.
- A new datastore for signal history — the aggregator holds only current
  per-scope state, not a persisted event log.
- Choosing a geofencing provider or protocol now. This doc only reserves the
  `zone:household:<member>` shape and the `POST /api/presence/signal` path a
  future geofence source would use.
- Changing anything already built (`app/host.py`, `app/display.py`,
  `HostCapabilities`, `GET /api/capabilities`) or already locked in
  `camera-support-plan.md` / `eufy-sdk-integration.md` beyond the small
  cross-references this doc adds to them.

## Open questions

- **`presence_remote_token` mechanism** — a single shared secret in `.env`, or
  per-source tokens? Deferred until a real out-of-process source (geofencing) is
  actually scheduled; `POST /api/presence/signal` should not be built before
  then either.
- **Zone naming** — `zone:front_door` vs a more structured `{location, device}`
  pair once a second physical zone source (a second eufy camera, an indoor
  sensor) exists. One eufy camera and no geofencing yet means there's nothing to
  generalize against; revisit when eufy unblocks.
- **Should `activity` and `presence` collapse into one kind for the kiosk
  scope?** Kept separate here because they have different hysteresis semantics
  (a pulse vs a standing claim); revisit only if `camera-support-plan.md`'s
  Phase 1 build finds the distinction awkward in practice.
