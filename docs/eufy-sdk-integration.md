---
status: future
summary: Eufy camera events - blocked on an upstream SDK release.
---

# Eufy camera events — feasibility assessment + implementation plan

Status: **not implemented, and blocked on an upstream release.** This document is a
directed plan for a future task. It assesses whether Mission Control can ingest
camera events from a eufy HomeBase 3 (S380) and eufyCam S330 cameras via the
**`@mega-yfue/eufy-sdk`** project ("eufy-sdk" / the "eufy-mega" effort,
<https://mega-yfue.github.io/>), and lays out how to build it once that SDK ships
a usable release.

Scope of this capability: **events only** — motion, person, doorbell ring,
package, alarm, low battery, contact/lock state — surfaced as ambient household
status. No live video, no recordings, no two-way control, no arm/disarm, no face
recognition. See **Explicitly out of scope**.

> **Correction note.** An earlier draft of this file evaluated
> `bropat/eufy-security-client` / `eufy-security-ws`. That is the *wrong* project
> for this: it is built on eufy's **legacy** cloud API, which Anker is actively
> sunsetting. `@mega-yfue/eufy-sdk` is the successor, built on the **v6 "mega"
> backend that the current eufy app actually uses**, by several of the same
> community maintainers. This revision targets that SDK.

---

## 1. Feasibility verdict

**Strategically the right dependency. Architecturally a good fit. Not usable
today — the plan is gated on `@mega-yfue/eufy-sdk` reaching a real release.**

Why it is the right target:

- It speaks the **v6 "mega" cloud** that the current eufy app uses — not the
  legacy API that is being removed. This is the integration path with a future.
- **Apache-2.0 licensed.** Clean for Mission Control's current and any foreseeable
  use — much better than the GPL-adjacent risk in parts of the old ecosystem.
- Built by credible people: the docs-repo commit history shows co-authors
  `martijnpoppen` (Homey eufy app), `lenoxys` (eufy-security-client contributor),
  and `max246` (Home Assistant eufy) — i.e. the people who reverse-engineered the
  last generation are building this one.
- The **design is a strong fit** for what Mission Control needs: one `EufyMega`
  facade per account, a **single typed semantic event stream** normalised across
  push / MQTT / P2P / poll, a capability model that does not care about specific
  device models, and push + secure-MQTT channels that **come up automatically on
  login** while P2P only opens on demand. An events-only consumer can run the
  cheap channels and never touch P2P.
- Event coverage is exactly right: `motion`, `personDetected`, `strangerDetected`,
  `doorbellPress`, `soundDetected` / `cryingDetected` / `vehicleDetected` /
  `dogDetected`, `contactState`, `lockState`, `alarm`, `batteryAlert`,
  `propertyChanged`, plus roster events and `sessionExpired`.
- HomeBase 3 (S380 / T8030) and eufyCam S330 (T8160) are both in the device
  gallery with no support caveat; the capability model resolves them like any
  other device, and **reads/events are not model-gated** (only unverified *write*
  paths are held back — and this integration writes nothing).
- It still runs as a **local Node process** alongside the backend, same shape as
  the sidecar in the previous draft — no camera media leaves the LAN, nothing
  goes to Gemini. Consistent with `docs/camera-support-plan.md`.

Why it is blocked right now — **this is the gate, do not start Phase 2+ until it
clears**:

1. **The SDK is pre-release and, per its own README, "Not usable yet."** npm has
   only `0.0.1`–`0.0.5` (published 2026-08-05, ~21 KB unpacked — a scaffold to
   prove the release pipeline). The README says verbatim: *"`0.0.1` exists on npm
   only to prove the release pipeline works — it is an empty package. Wait for
   `0.1.0`."* The real source is on a **private** `beta-0.1.0` branch; only the
   generated docs + API reference are public.
2. **The API surface is still settling.** The published docs describe the intended
   design and a TypeDoc-generated reference, but at `0.0.x` the option names,
   event payloads and method signatures can still move. Treat every identifier in
   this document as *indicative*, to be re-checked against the real `0.1.0`.
3. **Node.js ≥ 24.5.0 is a hard requirement** (native APIs, OpenSSL 3.5.1 for E2E
   video). Newer than most LTS deployments; the sidecar host needs it.
4. **Full eufy account credentials, server-side**, plus captcha / 2FA on first
   login, plus a real **rate-limit / abuse-cooldown risk**: "rapid or repeated
   failed-password logins on one device fingerprint trip an abuse cooldown," and
   a second client on the same account with the same `openudid` gets the first
   one **evicted**. Requires a stable device fingerprint and a persistent session
   store. Recommend a **dedicated eufy account** invited to the HomeBase, never
   the household's primary account.
5. **Small, young project.** Org created 2026-06; single-digit stars; one docs
   rebuild since early August. Bus factor is low. It could stall before `0.1.0`.
6. **No WebSocket/HTTP wrapper exists yet.** The old ecosystem had
   `eufy-security-ws`; here there is only the Node library. Mission Control would
   have to **write its own ~100-line bridge** (EufyMega → newline-delimited JSON
   over a localhost socket) — see §5.

**Bottom line:** the design work in this document is worth doing now so we are
ready, but the build is a **"monitor `@mega-yfue/eufy-sdk`; when `0.1.x` lands and
survives a spike against the real S380/S330, execute Phases 2–4"** plan, not a
"start next sprint" plan.

---

## 2. What Mission Control would do with these events

Camera events are **ambient household status and exceptions — never calendar
data.** They map onto surfaces `AGENTS.md` already anticipates ("Prioritize NOW,
NEXT, and UNUSUAL"; "Actionable exceptions earn prominent space"):

| SDK event | Payload (per current docs) | Mission Control treatment |
| --- | --- | --- |
| `doorbellPress` | `{ deviceSn }` | Prominent transient alert: "Someone at the front door" — highest priority, auto-dismiss after a configurable window. Natural display-wake trigger (§8). |
| `personDetected` | `{ deviceSn }` (recognised faces only) | Low-key ambient line ("Front door · person · 2 min ago"). |
| `strangerDetected` | `{ deviceSn }` | Same, worded "someone". |
| `motion` | `{ deviceSn, thumbnailUrl? }` | Ambient activity line, most recent only, debounced. Not an exception on its own. `thumbnailUrl` retained but not shown in Phase 1. |
| `soundDetected` / `cryingDetected` / `vehicleDetected` / `dogDetected` | `{ deviceSn }` | Ambient activity line; `cryingDetected` may warrant an exception depending on household preference. |
| `alarm` | `{ phase: "triggered" \| "delayed" }` | Prominent alert, same tier as a doorbell ring. |
| `contactState` | `{ deviceSn, open, to? }` | Exception while a door/window is open past a threshold ("Garage door open 43 min" — this finally makes `MOCK_EXCEPTION` real). Edge-triggered / de-duped by the SDK. |
| `lockState` | settled state | Quiet status; exception only if unlocked unexpectedly (deferred). |
| `batteryAlert` | threshold push, no level | Quiet household exception: "Backyard cam battery low". |
| `propertyChanged` | `{ deviceSn, property, value? }` | Internal only — refresh the cached device state; do not surface directly (fires for any property movement). |
| `sessionExpired` | — | Not user-facing; the bridge re-drives `login()` and Mission Control shows "camera events reconnecting" in Settings. |

This reuses and extends the existing `HouseholdException` concept in
`frontend/src/App.tsx` (today only `MOCK_EXCEPTION`) and finally gives
`ApplicationMessage` in `backend/app/models.py` a real payload to carry — which is
the thing `AGENTS.md` says to do "when the first real push exists."

Push thumbnails (`motion` `thumbnailUrl`, "v6 AI enriched") are a **later-phase
nice-to-have**. If added, proxy them through the backend and keep them local;
never send them anywhere.

---

## 3. Decisions locked in

| Question | Decision |
| --- | --- |
| Capability scope | Ingest events only. Read-only. No video, no control, no arm/disarm, no writes of any kind. |
| SDK | `@mega-yfue/eufy-sdk` (`EufyMega` facade), consumed from a small local Node service. Not `eufy-security-client` (legacy backend), not a Python port (none targets v6). |
| Blocking gate | Do not begin Phase 2 until `@mega-yfue/eufy-sdk` publishes a non-scaffold release (`>= 0.1.0`) **and** a spike confirms the §2 events actually arrive for a real S380 + S330. |
| Where the SDK runs | A purpose-built **Node ≥ 24.5.0 sidecar** we write (~100–150 lines) that wraps `EufyMega` and exposes events as newline-delimited JSON on `127.0.0.1` only. |
| Backend ↔ sidecar | A small async client in the FastAPI backend reads the JSON stream and reconnects. No third-party dependency. |
| Backend → frontend | The existing `/api/ws` endpoint, now sending real `ApplicationMessage`s. No new socket, no generalized event bus. |
| Domain model | Provider-neutral `CameraEvent` / `HouseholdActivity` in `app/models.py`. SDK vocabulary never reaches React — same rule as calendar providers. |
| Credentials | eufy email/password + region + a persistent session-store dir, via env / `.env` only. Never entered on the kiosk. One-time captcha/2FA via a `python -m app.eufy login` helper that drives the sidecar. Dedicated household-member eufy account, stable `openudid`/`phoneModel`. |
| Realtime config | `autoRealtime: true` (push + MQTT only). **No P2P pre-warm** (`prewarmEvents: []`). `pollMs` kept at the default or higher (battery levels only). Events-only means the expensive P2P path never opens. |
| Feature flag | `MISSION_CONTROL_EUFY_ENABLED=false` by default. When false, zero eufy code imported, `/api/ws` behaves exactly as today. |
| Failure posture | Calendar function must be entirely unaffected by any eufy failure. Degrade to "camera events unavailable" in Settings; never block the dashboard. |
| Persistence | The sidecar owns a git-ignored session-store dir (`FileSessionStore`). Mission Control keeps only in-memory current activity state (consistent with "no datastore yet"). |

---

## 4. Architecture

```
┌───────────────────────── LAN / localhost only ──────────────────────────┐
│                                                                         │
│  eufy v6 "mega" cloud  ◀── login + FCM push + secure MQTT (auto) ──┐     │
│  HomeBase 3 S380       ◀── P2P (NOT opened — events-only) ─────────┐│     │
│  eufyCam S330                                                     ││     │
│                                            ┌─────────────────────┴┴──┐  │
│                                            │  eufy-bridge (Node 24)  │  │
│                                            │  @mega-yfue/eufy-sdk    │  │
│                                            │   • new EufyMega(opts)  │  │
│                                            │   • login (+captcha/2fa)│  │
│                                            │   • eufy.on("event",…)  │  │
│                                            │   • FileSessionStore    │  │
│                                            │  emits NDJSON on :3011  │  │
│                                            └───────────┬─────────────┘  │
│                                                        │ newline JSON   │
│                                            ┌───────────┴─────────────┐  │
│                                            │  FastAPI backend        │  │
│                                            │  app/eufy/service.py    │  │
│                                            │   • read + reconnect    │  │
│                                            │   • map → domain        │  │
│                                            │   • current-state store │  │
│                                            │   • expiry timers       │  │
│                                            │          │              │  │
│                                            │          ▼              │  │
│                                            │  ApplicationMessage     │  │
│                                            │  over /api/ws  ─────────┼──┼─▶ kiosk
│                                            │  GET /api/household     │  │  React
│                                            └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

Why this shape:

- **The bridge is a blast-radius boundary.** All the pre-release, Node-only,
  credential-holding code is one small process Mission Control supervises,
  restarts, or stops without touching FastAPI. When `@mega-yfue/eufy-sdk`'s API
  churns, the bridge is the only thing that changes.
- **The backend owns the semantic translation**, exactly like a calendar provider:
  raw SDK events in, provider-neutral `HouseholdActivity` out.
- **The frontend stays disposable** — it renders whatever activity snapshot the
  backend pushes and never learns what "eufy" is.

---

## 5. The Node bridge (`eufy-bridge/`, new — not part of the Python package)

A tiny, single-purpose Node service. Not published, not a Python dependency —
deployment infrastructure, checked into the repo under `eufy-bridge/`.

Responsibilities, and nothing more:

- `new EufyMega({ email, password, region, store: new FileSessionStore(dir),
  openudid, phoneModel, autoRealtime: true, prewarmEvents: [] })`.
- `await eufy.login()`; if the result is `captcha` or `2fa`, **do not fail** —
  expose it: write a `{"type":"auth","need":"captcha","image":"…"}` line and read
  the answer back on a control channel (stdin, or a second local socket) so
  `python -m app.eufy login` can drive it. On `Ok`, write `{"type":"ready", …}`
  with the device roster.
- Subscribe to the catch-all: `eufy.on("event", e => emit(e))` plus `error`,
  `sessionExpired`, `deviceAdded`, `deviceRemoved`. Serialise each to one JSON
  line on the localhost socket. Never open a live stream, snapshot, or any write.
- On `sessionExpired`: re-drive `login()` (no re-auth needed with a valid store);
  emit `{"type":"status","state":"reconnecting"}` / `"connected"`.
- Expose current state on connect (roster + last-known values) so a reconnecting
  backend re-syncs.
- Bind `127.0.0.1` only. Exit non-zero on unrecoverable auth failure so the
  supervisor/`app.eufy` surfaces "needs sign-in".

Target ~150 lines. Pin `@mega-yfue/eufy-sdk` to an exact version;
treat every SDK upgrade as a reviewed change with a re-run of the manual checklist.

If upstream later ships an official ws wrapper (à la `eufy-security-ws`), replace
the bridge with it and delete `eufy-bridge/`.

---

## 6. Backend work

### 6.1 Configuration (`app/config.py`)

Add to `Settings` (all `MISSION_CONTROL_`-prefixed):

| Setting | Default | Purpose |
| --- | --- | --- |
| `eufy_enabled` | `False` | Master flag. False ⇒ no eufy imports, `/api/ws` unchanged. |
| `eufy_bridge_url` | `ws://127.0.0.1:3011` (or a unix socket path) | Where the Node bridge listens. |
| `eufy_email` | `None` | eufy account. Passed to the bridge. |
| `eufy_password` | `None` | eufy account password. |
| `eufy_region` | `"us"` | Must match the eufy app's region. |
| `eufy_session_dir` | `.eufy_session` | Bridge `FileSessionStore` dir (git-ignored). Relative to CWD like `graph_token_cache`. |
| `eufy_openudid` | `None` (bridge generates + persists one) | Stable device fingerprint; changing it forces 2FA and risks eviction. |
| `eufy_camera_names` | `{}` | Optional `{serial: "Front door"}` map for friendly labels; falls back to the SDK device `name`. Reuse the `_split_csv` / `NoDecode` pattern in `config.py`. |
| `eufy_front_door_serial` | `None` | Which camera's `doorbellPress` / `personDetected` gets the prominent wake treatment. |
| `eufy_motion_reset_seconds` | `20` | How long a pulse event (`motion`, `personDetected`) stays "active" with no repeat. |
| `eufy_alert_seconds` | `60` | Auto-dismiss window for doorbell / alarm banners. |
| `eufy_contact_open_exception_seconds` | `600` | How long a `contactState.open` must persist before it becomes an exception. |

`eufy_enabled` is independent of `calendar_provider` — do not fold it into that
selector.

### 6.2 New package `app/eufy/`

Mirror the shape and conventions of `app/voice/` and `app/calendar/`.

- **`client.py`** — a minimal async reader for the bridge's NDJSON stream: connect,
  yield parsed event dicts, expose the control channel for captcha/2FA answers.
  No reconnect logic here.
- **`events.py`** — pure mapping functions, bridge event dict → `CameraEvent` /
  `CameraEventKind` (§6.3). Unit-tested in isolation with captured fixtures. The
  analogue of the calendar providers' event-mapping helpers. No I/O.
- **`service.py`** — `EufyEventService`, the long-lived owner:
  - `async run()`: connect → read → on drop, exponential backoff reconnect
    (cap ~60 s), forever, while `eufy_enabled`.
  - maintains the **current activity snapshot** in memory: active per-camera
    states + a bounded (~20) recent-activity ring buffer + current exceptions.
    Expires pulse states after `eufy_motion_reset_seconds`, banners after
    `eufy_alert_seconds`, via a lightweight timer task.
  - on every state change, builds an `ApplicationMessage` and fans it out to
    connected `/api/ws` clients (§6.4).
  - exposes `snapshot()` for `GET /api/household` and `status()` for diagnostics
    (`connected` / `connecting` / `needs_signin` / `disabled` / `error`, last
    event time, device count).
  - classifies failures the way `useVoiceSession` classifies voice errors:
    `disabled` / `auth` (needs `python -m app.eufy login`) / `bridge_unreachable`
    / `session_lost` / `unknown`.
- **`__init__.py`** — export `EufyEventService`, `EufyUnavailable`, and a
  `get_eufy_service()` singleton guarded by `eufy_enabled` (lazy import so the
  disabled path never imports the client).

### 6.3 Domain models (`app/models.py`)

Provider-neutral, `snake_case`, no eufy vocabulary leaking through:

```python
class CameraEventKind(StrEnum):
    motion = "motion"
    person = "person"
    stranger = "stranger"
    doorbell = "doorbell"
    package = "package"
    sound = "sound"
    crying = "crying"
    vehicle = "vehicle"
    animal = "animal"
    contact = "contact"          # door/window sensor open/close
    alarm = "alarm"
    device_health = "device_health"   # low battery, etc.


class CameraEvent(BaseModel):
    camera_id: str          # opaque; SDK serial number
    camera_name: str        # friendly label
    kind: CameraEventKind
    active: bool             # True = started/ongoing, False = cleared
    detail: str | None = None
    occurred_at: datetime   # naive local time — converted at the app/eufy boundary


class HouseholdActivity(BaseModel):
    """The ambient-status snapshot pushed over /api/ws."""
    events: list[CameraEvent]              # recent ring buffer, newest first
    active: list[CameraEvent]              # currently-ongoing states
    exceptions: list[HouseholdException]   # camera-derived exceptions
    cameras_online: bool
    source_status: Literal["connected", "connecting", "needs_signin", "disabled", "error"]
```

Extend `ApplicationMessage` with an optional `activity: HouseholdActivity | None`
(or generalise the envelope — decide during the spike). Keep `HouseholdException`
as the shared shape the frontend already implies.

**Time handling:** SDK timestamps are epoch ms / UTC — convert to naive local at
the `app/eufy/` boundary, the same rule the calendar providers follow.

### 6.4 Wiring into `/api/ws` (`app/api.py`, `app/main.py`)

Today `websocket_endpoint` sends one hello and then only drains. Change:

- Add a `lifespan` to `app/main.py` (there is none today). If `eufy_enabled`,
  create `EufyEventService` and launch `service.run()` as a background task;
  cancel on shutdown.
- Keep a set of connected `/api/ws` sockets. On connect, immediately send the
  current `ApplicationMessage` snapshot. On each service state change,
  `send_json` to all; drop sockets that raise.
- Add `GET /api/household` → the activity snapshot as JSON (same shape the WS
  pushes); return 409 when `eufy_enabled` is false, matching `/api/voice/token`.
- Do **not** build a generalized event bus or router — one service, one message
  type, direct fan-out. `AGENTS.md` is explicit about this.

### 6.5 First-login helper (`python -m app.eufy`)

Model it on `app/auth.py` (`login` / `status` / `logout`):

- `login` — ensure the bridge is running, connect to its control channel, and
  when it reports `captcha` / `2fa`, prompt on stdin and send the answer. The
  bridge persists the session in `eufy_session_dir`. Print final status.
- `status` — connect, print `connected` / roster / last event time.
- `logout` — clear `eufy_session_dir` (document that this forces a fresh 2FA and
  can briefly trip the abuse cooldown if repeated).

A kiosk-side sign-in UI (QR/device-code like the calendar connect sheet) is
**deferred** — eufy's captcha is an image challenge that does not fit that flow.
First login is a one-time headless operation.

### 6.6 Dependencies

- Backend: add `websockets>=13,<16` (or reuse `httpx`/`aiohttp`) to
  `pyproject.toml`, imported lazily inside `app/eufy/` only.
- `eufy-bridge/` has its own `package.json` pinning `@mega-yfue/eufy-sdk` exactly.

---

## 7. Frontend work

Keep it minimal — `AGENTS.md`: settings/diagnostics in Settings, not permanent
dashboard space.

### 7.1 Consume the real `/api/ws` payload (`App.tsx`)

- The existing `useEffect` that opens `/api/ws` currently only flips `connection`.
  Extend its `message` handler to parse `ApplicationMessage`; on an activity
  message set a new `activity` state (`HouseholdActivity` mirror type,
  hand-maintained like the others).
- On first message / reconnect, also `GET /api/household` once to seed.
- Feature-detect: if `source_status === 'disabled'` or `/api/household` 409s,
  render nothing camera-related. Zero visual change from today.

### 7.2 Ambient surfaces

- **Doorbell / alarm alert:** a transient high-priority card in the contextual
  right-rail region `AGENTS.md` reserves for exceptions and assistant proposals
  ("Someone at the front door", "Alarm — Backyard"), auto-dismissing after
  `eufy_alert_seconds`. The one camera event allowed to grab attention.
- **Household activity:** a small, low-contrast list ("Front door · person ·
  2 min ago") in an unobtrusive corner of Home view — rendered only when
  non-empty, collapses entirely when quiet (principle 4).
- **Exceptions:** camera-derived exceptions (`contactState` open too long,
  `batteryAlert`) flow into the same slot that renders `MOCK_EXCEPTION` today.
  Replace the mock with the real list; one code path for all exceptions.
- **No camera imagery** in the normal appliance UI (matches
  `camera-support-plan.md`). Any future thumbnail belongs only in a touch-expanded
  detail view.

### 7.3 Settings / diagnostics

New "Cameras" section in the existing Settings sheet:

- Camera events: enabled / disabled (reflects the backend flag).
- Source status: Connected / Connecting / Needs sign-in / Unavailable.
- Last event time, camera count, per-camera name / last event / battery alert.
- Developer detail (behind the same affordance as other dev diagnostics): bridge
  reconnect count, last error kind, SDK version.

No arm/disarm, no toggles that write back to eufy.

---

## 8. Tie-ins with other planned capabilities (do not build now)

- **Display wake** (`docs/camera-support-plan.md`): a `doorbellPress` or a
  front-door `personDetected` is an excellent wake trigger. If both ship, feed
  eufy events into the same presence/inactivity policy as an extra "activity"
  input — but keep local webcam presence detection independent and authoritative
  for sleep decisions. `docs/presence-module-plan.md` now formalizes this: eufy
  events become a `zone`-scope `PresenceSignal` source (mapped from `CameraEvent`
  in `app/eufy/service.py`), which by construction can never reach the
  `kiosk`-scope display policy. Do this mapping only once this doc's own gate
  clears — it is not a prerequisite for Phases 2–4 above.
- **Voice** (`docs/voice-support-plan.md`): a future read-only tool
  `get_recent_activity()` could answer "did anyone come to the door?" from the
  same `GET /api/household` snapshot. Additive, no new provider access.
- **Wake word** (`docs/wake-word-plan.md`): unrelated; no dependency.

None are prerequisites; none should block this work.

---

## 9. Testing

Deterministic, no network, no real eufy account — mirror `test_graph.py` /
`test_voice.py`.

- **`events.py` mapping** — feed captured bridge event lines (commit a
  `tests/fixtures/eufy/` set: motion, personDetected, strangerDetected,
  doorbellPress, contactState open/close, alarm triggered/delayed, batteryAlert,
  propertyChanged, sessionExpired). Assert each yields the right `CameraEvent` /
  clears the right state / converts the timestamp.
- **`EufyEventService` policy** — with a fake client yielding scripted lines:
  pulse events expire after `eufy_motion_reset_seconds`; a doorbell banner clears
  after `eufy_alert_seconds`; a `contactState.open` becomes an exception only
  after `eufy_contact_open_exception_seconds` and clears on close; a mid-stream
  disconnect reconnects and re-syncs without losing the snapshot;
  `eufy_enabled=false` ⇒ service never constructed, `/api/ws` sends only the
  hello, `GET /api/household` ⇒ 409; failure classification
  (`auth` vs `bridge_unreachable` vs `session_lost`).
- **API** — `GET /api/household` shape & 409-when-disabled; `/api/ws` pushes an
  `ApplicationMessage` when the faked service changes state and sends a snapshot
  on connect. Add to `test_api.py`.
- **Frontend** — mock the `/api/ws` stream: doorbell banner appears and
  auto-dismisses; activity list renders newest-first and hides when empty;
  camera-derived exception uses the `MOCK_EXCEPTION` card; everything
  camera-related absent when `source_status='disabled'`; Settings "Cameras"
  reflects status.
- **Playwright** — a `VITE_EUFY_FAKE=1` scripted stream (like `VITE_VOICE_FAKE`):
  banner + activity list + no document overflow at 3840×2160 / 1920×1080.
- **Bridge** — a Node test that runs it against a stubbed `EufyMega` (fake
  event emitter) and asserts the NDJSON output shape and the captcha/2FA control
  handshake. No real SDK, no network.
- **Manual, real hardware** (documented checklist): walk past the S330 →
  `motion` / `personDetected` within seconds; press the doorbell → banner; open a
  contact sensor → exception after the threshold; kill the bridge → Settings
  shows "Unavailable", calendar unaffected, restart recovers; `logout` then
  `login` → captcha/2FA handled once, session persists across a restart.

---

## 10. Rollout phases

**Phase 0 — watch and gate (now, cheap, recurring).**
Track `@mega-yfue/eufy-sdk` on npm and the docs site. The gate to proceed:
(a) a published release `>= 0.1.0` that is not a scaffold; (b) the source public
or otherwise buildable; (c) `personDetected` / `motion` / `doorbellPress` /
`contactState` documented with stable payloads. Re-open this doc when that
happens and reconcile every identifier here against the real API.

**Phase 1 — spike (throwaway).**
Provision a dedicated eufy account, invite it to the real S380 + add the S330.
Write a ~50-line throwaway `EufyMega` script; headless captcha/2FA; log every
`eufy.on("event")` for a day. **Confirm which §2 events actually arrive for this
hardware, their real payloads, latency, and channel stability.** Capture
fixtures. Decide the `ApplicationMessage` envelope shape. Explicit go/no-go.

**Phase 2 — the bridge + backend pipeline.**
`eufy-bridge/` (pinned SDK, NDJSON, captcha/2FA control channel); `config.py`;
`app/eufy/` (`client`, `events`, `service`); `models.py`; `lifespan` in
`main.py`; `/api/ws` fan-out; `GET /api/household`; `python -m app.eufy`;
`websockets` dep. Full test coverage with fakes. No frontend yet.

**Phase 3 — frontend ambient surfaces.**
`/api/ws` payload consumption; doorbell/alarm banner; activity list; real
exceptions replacing `MOCK_EXCEPTION`; Settings "Cameras" section. Frontend +
Playwright tests.

**Phase 4 — hardening + docs.**
Reconnect/backoff tuning; event-expiry edge cases; `.env.example` block;
`README.md` run notes (incl. the bridge + Node 24.5 requirement); `AGENTS.md`
updates (§12); a deployment doc for the bridge process. Manual hardware checklist
run and recorded.

---

## 11. Open questions (resolve with the user before Phase 2)

1. **Is the upstream gate acceptable, or is this shelved until `0.1.0` exists?**
   Nothing past Phase 1 can be built reliably before then.
2. **Bridge process management.** `AGENTS.md` lists Docker as a non-goal. The
   bridge is Node 24.5+ — run it under the same supervisor as uvicorn / the kiosk
   browser (Windows service / NSSM / Task Scheduler), or containerise it? Needs a
   call.
3. **Which eufy account?** Strongly recommend a **new** account, invited to the
   HomeBase as a member, used only by Mission Control — not the household's
   primary account (eviction + abuse-cooldown risk). Confirm who owns it.
4. **Region** for the account (must match the eufy app exactly).
5. **Which cameras + friendly names + roles?** Specifically which device is the
   front door (`eufy_front_door_serial`).
6. **HomeBase familiar faces:** if face recognition is on, `personDetected` fires
   for known faces. The current docs expose no name in the payload — but if a
   later version does, do we surface "Alex is at the front door" or deliberately
   not (privacy; it is not an auth mechanism, per `camera-support-plan.md`)?
7. **Attention budget:** may a doorbell ring interrupt the ambient calendar view
   with a banner, or stay confined to the right rail?
8. **Contact sensors:** are there any eufy entry sensors on this HomeBase, or is
   `contactState` moot for now? (Affects whether the "door open too long"
   exception ships in Phase 3.)
9. **ToS tolerance:** acknowledge this uses an unofficial API against Anker's ToS
   and can break, rate-limit, or lock the account, and that that is acceptable
   for a personal-use ambient feature.

---

## 12. `AGENTS.md` / `.github/copilot-instructions.md` updates this work requires

- Note the new subsystem under "Repository layout" (`app/eufy/`, `eufy-bridge/`)
  and "Architecture & boundaries": camera events are provider-neutral
  `HouseholdActivity`, mapped at the `app/eufy/` boundary; SDK JSON never reaches
  React — the same rule as calendar providers.
- Record the **deliberate deviations**: (a) a pre-1.0, unofficial third-party SDK
  is a soft dependency of an *optional, feature-flagged* capability, isolated in a
  Node sidecar, with the calendar function unaffected by its failure; (b) full
  eufy account credentials are held server-side (heavier than the repo's other
  read-only OAuth flows), justified by there being no official API; (c) a Node
  runtime (≥ 24.5.0) is now a deployment prerequisite when the feature is on.
- Update the "Real-time" note: `/api/ws` + `ApplicationMessage` are now wired for
  real (camera activity), still deliberately not a generalized event bus.
- Add a durable line (as `camera-support-plan.md` already does for ML/vision):
  unofficial-API integrations must stay feature-flagged, isolated, and severable,
  and must never degrade the core calendar experience; and any pinned third-party
  SDK/model must have its licence re-checked on upgrade.

---

## 13. Explicitly out of scope

Live video / RTSP / WebRTC streaming; recorded-clip playback or download;
talkback; PTZ or any camera/station control; arming / disarming / guard-mode
changes; **any `EufyMega` write path**; snapshot thumbnails in Phase 1; face
**recognition** / enrolment (the HomeBase's own output may be *displayed* if the
user opts in and a future SDK version exposes a name, but Mission Control does no
recognition itself); a kiosk-side eufy sign-in UI; non-eufy cameras; persisting
event history to disk; multi-HomeBase / multi-site; the SDK's vacuum / mower /
smart-light / lock capabilities.

---

## 14. Sources

- `@mega-yfue/eufy-sdk` documentation — <https://mega-yfue.github.io/>
  (getting-started, architecture, events, realtime transports, connectivity &
  battery, devices & capabilities, devices gallery, troubleshooting, API
  reference). Event names/payloads, `EufyMega` facade, config options
  (`autoRealtime`, `pollMs`, `p2pIdleMs`, `cacheTtlMs`, `prewarmEvents`, …),
  capability model, auth flow (`solveCaptcha` / `submitVerifyCode`),
  `FileSessionStore`, `openudid` / abuse-cooldown guidance.
- npm `@mega-yfue/eufy-sdk` — <https://www.npmjs.com/package/@mega-yfue/eufy-sdk>
  (0.0.1–0.0.5 published 2026-08-05, ~21 KB scaffold; README: *"Not usable yet …
  Wait for `0.1.0`"*; Apache-2.0; Node ≥ 24.5.0; deps `mqtt`, `protobufjs`,
  `werift`).
- `mega-yfue/mega-yfue.github.io` — <https://github.com/mega-yfue/mega-yfue.github.io>
  (docs build pipeline; SDK source is a private `beta-0.1.0` branch of
  `mega-yfue/eufy-sdk`; commit co-authors `martijnpoppen`, `lenoxys`, `max246`).
- Prior-generation context (why *not* to use it): `bropat/eufy-security-client`
  deprecation notice — <https://github.com/bropat/eufy-security-client> — legacy
  API being removed by eufy; superseded by the above.
