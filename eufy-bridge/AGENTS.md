---
name: Mission Control eufy-bridge
description: Node sidecar wrapping eufy-security-client — process boundary, config, and testing conventions.
---

# eufy-bridge — Node sidecar

Read the repo-root `AGENTS.md` first, especially the eufy bullet under
"Architecture & boundaries". Full history, spikes, and wire-level findings live in
`docs/eufy-sdk-integration.md` (20+ sections) — this file carries only the conventions
that keep tripping agents up, not the investigation log.

## What this is, and isn't

A private, unpublished Node package (`"private": true`) — deployment infrastructure
for one feature, not a library. It is spawned and supervised by
`backend/app/eufy/bridge_process.py` as a child process; it is not a frontend or
backend dependency and must never be added to `frontend/package.json` or Python
`pyproject.toml`. CommonJS (`"type": "commonjs"`), not ESM — match existing `require()`
style. `eufy-security-client` (and the SDK below) are reverse-engineered/unofficial
against Anker's ToS: keep this package feature-flagged, isolated, and severable per the
root doc — a failure here must never degrade the core calendar experience.

## Two independent SDKs — never merge them

`eufyBridge.js` (primary client, `eufy-security-client`) and `megaEnumerator.js`
(`@mega-yfue/eufy-sdk`, gated by `megaEnumerationEnabled`, off by default) are separate
logins with separate session/persistence files (`EUFY_SESSION_FILE` vs
`EUFY_MEGA_SESSION_FILE`) and separate lifecycles — the mega client starts/stops on its
own timer rather than piggybacking on the primary client's connect/close. It exists
only to work around a documented staleness bug in the primary reconcile path
(`docs/eufy-sdk-integration.md` §16–§19); don't fold its logic into the primary client
or share its session file.

## Config is env-vars-only, and interval fields need bounds

`src/config.js` reads every setting from `process.env`, never `argv` — argv is visible
to any other process via `ps`/Task Manager, and this config carries a password. Any
**new** duration/interval env var must get an explicit min/max check at load time
(mirroring `pollingIntervalMinutes`'s `MAX_POLLING_INTERVAL_MINUTES`): Node's
`setTimeout` silently clamps a too-large delay instead of throwing, and this SDK's own
housekeeping reschedules itself on that same timer — an unbounded value hit production
as ~356 unwanted authenticated cloud calls in under two minutes (§5.6.1). The Python
side validates the same field independently in `app/config.py`; this is defence in
depth, not redundancy to remove.

Diagnostic-only flags (`debugRawEvents`, `debugMegaCall`, `megaEnumerationEnabled`'s
verbose paths) default off and stay off by default — they're for chasing a specific
live-hardware bug, not something to enable to "get more logs" in normal operation.

## Event names come from the SDK's own type defs, verbatim

`DEVICE_EVENT_NAMES` in `eufyBridge.js` must match `eufy-security-client`'s emitted
strings exactly (e.g. `"device motion detected"`, not `"motion detected"` — each is one
indivisible string, not a namespace + suffix). A previous mismatch here silently
dropped every real push event. Don't hand-derive this list from docs or examples;
verify against the installed SDK's own `interfaces.d.ts`, and when in doubt, confirm
live via `EUFY_DEBUG_RAW_EVENTS=1` rather than guessing.

## Testing: `node --test`, constructor injection, not module mocking

Run tests with `npm test` (`node --test test/`) — this package doesn't use
jest/vitest/mocha. The dev sandbox's Node version predates both the SDK's own
`engines: ">=24.0.0"` requirement and `node:test`'s `mock.module` (Node 22+), so tests
stub the SDK via constructor-injected factories (`initializeClient`, `createMegaClient`
params on `EufyBridge`), never via module-mocking the real SDK. Follow that pattern for
any new SDK-touching class.

## Control channel

`src/server.js` is a `ws` WebSocket server bound to `host`/`port` (loopback by
default) speaking one JSON object per message with `backend/app/eufy/client.py` — the
backend is the sole intended consumer. Never bind it beyond localhost/LAN or add a
second transport; extend the existing message shape instead.
