---
status: built (clip gallery); events pipeline not yet built
summary: The clip-review gallery (thumbnails + tap-to-play, replacing the old "garage door" placeholder) is built end-to-end — Node bridge, backend clip/thumbnail/retrieve pipeline, frontend gallery + modal player. Ambient events (motion/person/doorbell banners, contact-sensor exceptions, §2/§7.2) remain designed but unbuilt. SDK is `eufy-security-client`, verified against real HomeBase 3 / S380 hardware on 2026-09-10.
---

# Eufy camera integration — verified capability + implementation plan

> **2026-09-11 update.** The clip-review gallery this document's §5.7 proposed
> ("unbuilt — proposed") is now built end-to-end, on the primary household eufy
> account (an accepted, explicit risk — see the household's own note in §11 item
> 1's resolution below): `eufy-bridge/` (Node sidecar), `backend/app/eufy/`
> (service, client, event mapping), the `GET /api/household` /
> `GET /api/camera/clip/{id}/thumbnail` / `GET /api/camera/clip/{id}/video`
> endpoints, and the frontend gallery + centered modal player replacing the old
> `MOCK_EXCEPTION` "garage door" placeholder in `frontend/src/App.tsx`. See the
> new §15 for exactly what shipped, what's still best-effort/unverified, and
> what a future session should check first. The ambient-events pipeline (§2,
> §7.2 — motion/person/doorbell banners, contact-sensor exceptions) is
> unaffected by this and remains designed but unbuilt.

Status: **verified against real hardware; the clip gallery is built (§15).** A 2026-09-10 investigation
(login → local P2P → decrypted clip, end to end) proved out both capabilities below on
the actual HomeBase 3 (S380) and eufyCam S330 this household owns. This document is the
implementation plan plus everything that investigation learned, so a future
implementer does not need to re-derive any of it.

Two capabilities, both real, both using the same SDK and the same P2P session:

1. **Ambient events** — motion, person, doorbell ring, contact/lock state, battery —
   surfaced as household status. (Original scope of this doc.)
2. **On-demand clip retrieval** — list what's stored locally on the HomeBase, pull one
   event, get back a decrypted, playable video file. **Newly proven in scope** — the
   original draft of this doc listed this as explicitly out of scope, gated on an SDK
   that turned out to never support it. See §5.

> **Correction history.**
> - An earlier draft evaluated `bropat/eufy-security-client` and rejected it as
>   built on eufy's "legacy" cloud API, recommending `@mega-yfue/eufy-sdk` (the
>   "mega" successor) instead.
> - A later draft (this file, pre-2026-09-10) reversed course: `@mega-yfue/eufy-sdk`
>   was still an unreleased scaffold (`0.0.5`, "not usable yet" per its own README),
>   so everything was gated on it shipping `>= 0.1.0`.
> - **This revision reverses course again, based on direct verification, not more
>   reading.** `@mega-yfue/eufy-sdk` is *still* stuck at `0.0.5` as of 2026-09-10 —
>   but it turns out not to matter, because its own scope excludes video/download
>   entirely (events only, by design). `eufy-security-client` — the "legacy" library —
>   is not actually stuck on a legacy backend: its source already speaks the current
>   v6 device/image format (a `v2_eufysecurity:` thumbnail codec path was added
>   2026-06-10, three months before this investigation) and its docs/comments
>   explicitly handle HomeBase 3. It was live-tested against this household's real
>   S380 and worked on the first clean attempt. **Use `eufy-security-client` for both
>   capabilities in this document.** Do not gate further work on `@mega-yfue/eufy-sdk`.

---

## 1. Feasibility verdict

**Not blocked. Verified working, today, on this household's hardware.** No upstream
release to wait for.

What was directly confirmed against the real HomeBase 3 on 2026-09-10 (see §5 for the
full walkthrough):

- Cloud login with the household's eufy account succeeded cleanly — no captcha, no 2FA,
  first attempt.
- The account's real station and devices enumerated correctly: HomeBase named `Home`
  (serial `T8030P13232003FB`, device type `HB3`), with two cameras, `Front Door`
  (`T8160P11231428D3`) and `KittyCam` (`T8160P1123171396`).
- A local (LAN, not relayed through the cloud) P2P session connected to the station.
- The station's local event database was queried and returned real records — including
  a count of **2,642** stored events for the front-door camera alone.
- A real stored video clip (Front Door, 2026-09-07, 3840×2160, ~15fps) was downloaded
  over P2P, decrypted client-side, and successfully muxed into a normal playable MP4
  with zero decode errors. The output showed genuine footage (a delivery arriving),
  confirming the decrypt was correct, not garbage that merely "looked like" success.
- As a free side effect of normal connect-time behavior, the library also pulled and
  decrypted a current JPEG snapshot per camera — no extra command needed.

Why this is a good dependency, revised for `eufy-security-client`:

- **Actively maintained in 2026** — latest stable `4.1.1-1` (2026-07), dev channel
  active through `4.1.1-dev.39`. Not a young or stalled project.
- **Kept pace with the v6/"mega" migration on the client side**, even though it
  predates the still-unreleased official v6 SDK: `src/http/utils.ts`'s
  `decodeImage()`/`decodeImageAsync()` already handle both the legacy
  `eufysecurity:` header format and a newer `v2_eufysecurity:` format (added
  2026-06-10) used by current firmware.
- **Explicitly HB3-aware** — `Station` has a documented check for "HomeBase 3 or
  HomeBase mini," and `DeviceType.HB3` is a first-class enum value.
- Apache-2.0-style open source, large `node_modules` footprint but nothing exotic;
  installs cleanly with plain `npm install`.
- Same "runs as a local Node sidecar" shape already designed in §4 below — no change
  to the architecture, only to which package sits inside the bridge.

What's still true from the earlier caution, unchanged:

1. **`Node.js >= 24.0.0` is a hard requirement** (the package's own `engines` field).
   Verified working on Node `v24.21.0`. The repo's own Node install may be older
   (this investigation used a portable Node 24 extracted alongside the spike, not a
   system-wide install) — decide how the bridge process gets its Node 24 runtime
   before building this for real.
2. **Full eufy account credentials, server-side.** Same posture as always: a dedicated
   secondary account is strongly recommended over the household's primary one. See
   the "minimize cloud activity" principle in §5.6 — **the 2026-09-10 investigation
   used the primary account**, which was a live decision made for expediency during
   exploration, not a recommendation to carry into the real build.
3. **Real rate-limit / abuse-cooldown risk, and it is not hypothetical for this
   household anymore:** a config bug during the same investigation caused ~356 extra
   authenticated cloud API calls in under two minutes before it was caught (§5.6.1).
   No visible consequence resulted, but treat this as a live warning, not an
   abstract one.
4. `@mega-yfue/eufy-sdk` remains worth periodic watching for the *events* capability
   only, purely as a "does the official path ever arrive" curiosity — it is not a
   blocker for anything in this document anymore, and it will never cover clip
   retrieval (out of its own stated scope).

---

## 2. What Mission Control would do with these events

Camera events are **ambient household status and exceptions — never calendar
data.** They map onto surfaces `AGENTS.md` already anticipates ("Prioritize NOW,
NEXT, and UNUSUAL"; "Actionable exceptions earn prominent space"):

| SDK event | Payload (per current docs) | Mission Control treatment |
| --- | --- | --- |
| `doorbellPress` (event) / `CMD_DOORBELL` (P2P) | `{ deviceSn }` | Prominent transient alert: "Someone at the front door" — highest priority, auto-dismiss after a configurable window. Natural display-wake trigger (§8). |
| `personDetected` | `{ deviceSn }` (recognised faces only) | Low-key ambient line ("Front door · person · 2 min ago"). |
| `strangerDetected` | `{ deviceSn }` | Same, worded "someone". |
| `motion` | `{ deviceSn, thumbnailUrl? }` | Ambient activity line, most recent only, debounced. Not an exception on its own. |
| `soundDetected` / `cryingDetected` / `vehicleDetected` / `dogDetected` | `{ deviceSn }` | Ambient activity line; `cryingDetected` may warrant an exception depending on household preference. |
| `alarm` | `{ phase: "triggered" \| "delayed" }` | Prominent alert, same tier as a doorbell ring. |
| `contactState` | `{ deviceSn, open, to? }` | Exception while a door/window is open past a threshold ("Garage door open 43 min" — this finally makes `MOCK_EXCEPTION` real). Edge-triggered / de-duped by the library. |
| `lockState` | settled state | Quiet status; exception only if unlocked unexpectedly (deferred). |
| `batteryAlert` / low-battery device events | threshold push | Quiet household exception: "Backyard cam battery low". |
| `propertyChanged` / raw property events | `{ deviceSn, property, value? }` | Internal only — refresh the cached device state; do not surface directly. |
| session expiry / reconnect | — | Not user-facing; the bridge re-drives `connect()` (with the persisted session, see §5.5) and Mission Control shows "camera events reconnecting" in Settings. |

This reuses and extends the existing `HouseholdException` concept in
`frontend/src/App.tsx` (today only `MOCK_EXCEPTION`) and finally gives
`ApplicationMessage` in `backend/app/models.py` a real payload to carry.

**New, from §5:** a `get_recent_clip(camera_id, when)`-shaped capability now belongs on
this same list — see §5.7 for how it plugs into the voice/UI surfaces once built.

---

## 3. Decisions locked in

| Question | Decision |
| --- | --- |
| Capability scope | Events (read-only, ambient) **and** on-demand clip retrieval (read-only — list + download + decrypt a stored event). No live video, no control, no arm/disarm, no writes of any kind. |
| SDK | **`eufy-security-client`** (npm `eufy-security-client`, `EufySecurity` facade), consumed from a small local Node service. Verified `4.1.1-1`. Not `@mega-yfue/eufy-sdk` — it never gains video capability and remains an unreleased scaffold besides. |
| Blocking gate | None. Both capabilities are verified working today. |
| Where the SDK runs | A purpose-built **Node >= 24.0.0 sidecar** we write, wrapping `EufySecurity`. Same shape as previously planned; only the package name inside it changes. |
| Backend ↔ sidecar | A small async client in the FastAPI backend reads a small IPC protocol (NDJSON socket, or direct requires if collapsed into one process — decide during Phase 2) and reconnects. No third-party dependency. |
| Backend → frontend | The existing `/api/ws` endpoint, sending real `ApplicationMessage`s for events; a new small HTTP surface for on-demand clip listing/retrieval (§5.7). No generalized event bus. |
| Domain model | Provider-neutral `CameraEvent` / `HouseholdActivity` / (new) `StoredClip` in `app/models.py`. SDK vocabulary never reaches React — same rule as calendar providers. |
| Credentials | eufy email/password + region + a persisted session file (§5.5), via env / `.env` only. Never entered on the kiosk. **Strongly recommend switching to a dedicated household-member eufy account before building this for real** — the verification spike used the primary account, which is a known elevated risk, not a model to copy. |
| Realtime config | `p2pConnectionSetup: P2PConnectionType.ONLY_LOCAL` (verified) so P2P never relays through eufy's cloud. Pass `stationIPAddresses` once the station's LAN IP is known (§5.2 — local UDP-broadcast discovery was unreliable in testing without this hint). |
| Feature flag | `MISSION_CONTROL_EUFY_ENABLED=false` by default. When false, zero eufy code imported, `/api/ws` behaves exactly as today. |
| Failure posture | Calendar function must be entirely unaffected by any eufy failure. Degrade to "camera events unavailable" in Settings; never block the dashboard. |
| Persistence | The sidecar owns `backend/.eufy_persistent.json` (git-ignored, alongside `.msal_token_cache.json` — same convention). **This file may already exist and be valid** — always try loading and passing it before assuming a fresh login is required (§5.5). Mission Control keeps only in-memory current activity state beyond that. |

---

## 4. Architecture

```
┌───────────────────────── LAN / localhost only ──────────────────────────┐
│                                                                         │
│  eufy cloud (login, push, P2P signaling) ◀── login + push (auto) ──┐     │
│  HomeBase 3 S380       ◀── P2P, LAN-direct (ONLY_LOCAL) ────────────┐│     │
│  eufyCam S330                                                     ││     │
│                                            ┌─────────────────────┴┴──┐  │
│                                            │  eufy-bridge (Node 24+) │  │
│                                            │  eufy-security-client   │  │
│                                            │   • EufySecurity.initialize()│
│                                            │   • login (+captcha/2fa)│  │
│                                            │   • events + on-demand │  │
│                                            │     clip download      │  │
│                                            │   • .eufy_persistent.json│ │
│                                            │  emits NDJSON on :3011  │  │
│                                            └───────────┬─────────────┘  │
│                                                        │ newline JSON   │
│                                            ┌───────────┴─────────────┐  │
│                                            │  FastAPI backend        │  │
│                                            │  app/eufy/service.py    │  │
│                                            │   • read + reconnect    │  │
│                                            │   • map → domain        │  │
│                                            │   • current-state store │  │
│                                            │   • clip request proxy  │  │
│                                            │          │              │  │
│                                            │          ▼              │  │
│                                            │  ApplicationMessage     │  │
│                                            │  over /api/ws  ─────────┼──┼─▶ kiosk
│                                            │  GET /api/household     │  │  React
│                                            │  GET/POST /api/camera/… │  │
│                                            └─────────────────────────┘  │
└─────────────────────────────────────────────────────────────────────────┘
```

Why this shape (unchanged from the original plan):

- **The bridge is a blast-radius boundary.** All the credential-holding, Node-only
  code is one small process Mission Control supervises, restarts, or stops without
  touching FastAPI.
- **The backend owns the semantic translation**, exactly like a calendar provider.
- **The frontend stays disposable** — it renders whatever snapshot the backend pushes
  and never learns what "eufy" is.

---

## 5. Verified clip-retrieval implementation (2026-09-10 spike)

This section is the payoff of the investigation: everything needed to reproduce and
build on the verified pipeline, without re-discovering any of it.

### 5.1 Read this first — pitfalls that cost real time

- **`new EufySecurity(config)` does not work.** The plain constructor leaves an
  internal `megaTransition` field undefined; calling `.connect()` on the result
  throws `Cannot read properties of undefined (reading 'connect')`. **Use the static
  factory: `await EufySecurity.initialize(config, logger)`.**
- **A too-large `pollingIntervalMinutes` silently causes a runaway cloud-call loop,
  not an error.** The library does `setTimeout(refresh, minutes * 60 * 1000)`
  internally; Node's `setTimeout` silently clamps any delay over ~2,147,483,647ms
  (~24.85 days, i.e. ~35,791 minutes) to fire almost immediately instead of
  throwing, and each firing reschedules the same broken timeout. A value like
  `999999` (intended to mean "basically never") produced **~356 extra authenticated
  refresh calls to the eufy cloud in under two minutes** before it was caught. Keep
  this value sane (e.g. `1440` for once/day) and never pass anything intended to
  mean "infinite" or "disabled" as a huge number.
- **Local P2P discovery can silently stall without an IP hint.** The first attempt
  (no `stationIPAddresses` config) logged in and enumerated devices fine, but the
  P2P session to the station never came up within 90 seconds — no error, just
  nothing. Passing `stationIPAddresses: { [stationSerial]: knownLanIp }` (once the
  serial is known from a prior run, or from the eufy app) fixed it immediately.
  Don't rely on LAN broadcast discovery working from an arbitrary host on the
  network; give it the IP directly whenever you have it.
- **`station.databaseQueryLocal(...)` is not supported on this hardware/firmware.**
  It returned a clean protocol-level rejection: `ERROR_NO_SUPPORT` (`mIntRet:
  -6006`) for the `history_record_info` table query. **Use
  `station.databaseQueryByDate(...)` instead** — different P2P sub-command
  (`CMD_DATABASE_QUERY_BY_DATE`), and it worked on the first try, returning real
  records with `storage_path` and `cipher_id` per event.
- **Don't trust `StreamMetadata.videoCodec` at face value.** The verified download
  reported a numeric codec value that suggested H.264, but the actual bitstream was
  HEVC/H.265 (confirmed by NAL header inspection and by `ffmpeg -f hevc` decoding it
  cleanly with zero errors, vs. `-f h264` which would not have). If codec-specific
  handling matters, sniff the actual NAL unit types rather than trusting the
  metadata field.
- **The default logger swallows everything.** `EufySecurity.initialize(config)`
  with no second argument uses a no-op `dummyLogger`, so debugging a stuck P2P
  command (like the `databaseQueryLocal` rejection above) is impossible without
  passing a real logger object (`{trace, debug, info, warn, error}`) and calling
  `setLoggingLevel("all", LogLevel.Trace)` — imported from
  `eufy-security-client`'s internal `build/logging.js` path directly, since
  `setLoggingLevel` is **not** re-exported from the package's top-level `exports`
  map (only `LogLevel` and `dummyLogger` are).
- **Debug logs are extremely sensitive — never persist or commit them.** At trace
  level the library logs the full decrypted station record, including the P2P DID,
  push/cloud tokens, license strings, and the account's WAN IP. Treat any verbose
  log capture as a secret and delete it once you're done debugging.

### 5.2 Minimal config that works

```js
const { EufySecurity, DeviceType, LogLevel } = require("eufy-security-client");

const config = {
  username,                       // eufy account email
  password,                       // eufy account password
  country: "US",                  // must match the eufy app's account region
  language: "en",
  trustedDeviceName: "mission-control-bridge",
  persistentDir: SESSION_DIR,     // directory the library may also write into
  persistentData: loadPersistedSessionIfPresent(), // see §5.5 — skips login when valid
  p2pConnectionSetup: 1,          // P2PConnectionType.ONLY_LOCAL — stay on the LAN
  pollingIntervalMinutes: 1440,   // sane value — see the overflow pitfall above
  eventDurationSeconds: 10,
  stationIPAddresses: {
    [knownStationSerial]: knownStationLanIp, // see the discovery pitfall above
  },
};

const client = await EufySecurity.initialize(config); // NOT `new EufySecurity(config)`
await client.connect();
```

Login/auth events to handle (same shape as the original plan's captcha/2FA design):

- `"connect"` — logged in.
- `"tfa request"` — needs a human to supply a 2FA code; surface this rather than
  retrying automatically.
- `"captcha request"` — needs a human to solve an image challenge; surface it (e.g.
  write the challenge to a file/endpoint the `python -m app.eufy login` helper can
  read), never retry automatically.
- `"persistent data"` — fires with a JSON string; write it to
  `backend/.eufy_persistent.json` every time it fires (§5.5).

### 5.3 Listing what's stored: `databaseQueryByDate`, not `databaseQueryLocal`

```js
client.on("station database query by date", (station, returnCode, records) => {
  // records: Array<DatabaseQueryByDate> — device_sn, start_time, end_time,
  // storage_path, thumb_path, cipher_id, folder_size, storage_type, ...
});

station.databaseQueryByDate([station.getSerial()], startDate, endDate);
```

`records[].storage_path` and `records[].cipher_id` are exactly the two values
`startDownload` needs (§5.4). In verification, a 3-day window against the real
Front Door camera returned 2 records; the per-camera lifetime event count (visible
via the automatic `databaseQueryLatestInfo` the library issues on connect, see
`"station database query latest"`) was 2,642 for that one camera — the local index
is large, so scope queries by date range and/or device rather than pulling
everything.

### 5.4 Downloading + decrypting a clip: `startDownload`

```js
client.on("station download start", (station, device, metadata, videoStream, audioStream) => {
  videoStream.pipe(fs.createWriteStream(outFile)); // decrypted elementary stream
  audioStream.resume(); // or pipe it too — not exercised in this spike
});
client.on("station download finish", (station, device) => { /* done */ });

await station.startDownload(device, record.storage_path, record.cipher_id);
```

The output is a **raw H.264 or HEVC elementary stream**, not a container file. To get
something normally playable:

```bash
# probe which one it actually is if unsure — try both, one will decode cleanly
ffmpeg -f hevc -i clip.raw -c copy clip.mp4    # this is what worked in verification
ffmpeg -f h264 -i clip.raw -c copy clip.mp4    # fallback if the above errors
```

The verified clip was 3840×2160, decoded as 313 frames with zero errors. Audio muxing
was not exercised — `audioStream` was drained and discarded in the spike; combining it
with the video stream into one file is unbuilt.

### 5.5 Session persistence — check before you assume a login is needed

`.eufy_persistent.json` (git-ignored, lives at `backend/.eufy_persistent.json`
alongside `.msal_token_cache.json` — same convention, same reasoning) holds the
serialized session: cloud tokens + expiry, push credentials, `openudid`, login hash,
etc. **On startup, always attempt to read this file and pass its contents as
`config.persistentData` before doing anything else.** A valid persisted session lets
`connect()` succeed without hitting the login endpoint at all — no password round
trip, no captcha/2FA risk, and critically, far less traffic against the account (see
§5.6). Only fall back to a fresh username/password login when this file is absent or
the library reports the session as invalid/expired.

Write the file on every `"persistent data"` event, not just once — the library
re-emits it as tokens refresh.

### 5.6 Principle: minimize cloud-facing activity

Every call that reaches eufy's servers (not the local P2P session — that part is
just your LAN) is a call that counts against this account's standing with Anker.
There is no official rate-limit documentation; the only known consequences are the
project's long-standing cautions (abuse cooldown on repeated failed logins, a second
client on the same `openudid` evicting the first) plus this investigation's own
direct evidence that misconfiguration can generate large bursts of avoidable traffic.
Design and operate the bridge accordingly:

- **One login, reused, not one login per action.** Keep a single long-lived P2P
  session for the bridge's whole runtime; don't reconnect for every clip request.
- **Always try the persisted session before a password login** (§5.5).
- **Never loop a full reconnect/login cycle** on transient failure — back off
  generously (the original plan's "exponential backoff, cap ~60s" still applies),
  and stop retrying automatically after a captcha/2FA challenge rather than
  hammering the login endpoint.
- **Validate every config value that becomes a timer or interval before shipping**
  — the polling-interval overflow bug is exactly the kind of "looks harmless"
  mistake that turns into hundreds of avoidable cloud calls.
- **Prefer a dedicated eufy account over the household's primary one** for any
  always-on service, precisely so a mistake or a ToS-adjacent hiccup can't affect
  the primary account's access to the family's actual cameras. (The verification
  spike used the primary account as a live, one-time exception during exploration —
  not a pattern to carry into the real build.)

#### 5.6.1 What actually happened, for calibration

During verification, a `pollingIntervalMinutes: 999999` config value (intended to
mean "don't poll") overflowed Node's 32-bit timer limit and caused the library's
internal cloud-refresh call to fire roughly every millisecond instead of once a day,
for about 90–150 seconds before the process was killed — on the order of 300+ extra
authenticated calls. No visible account impact resulted, but it was purely luck of a
short window; treat it as a near-miss, not a demonstration that this is safe.

### 5.7 Suggested API surface for Mission Control (unbuilt — proposed)

Following the "one small typed endpoint, not an event bus" rule already established
for this project:

- `GET /api/camera/{camera_id}/events?since=...&until=...` — proxies
  `databaseQueryByDate`, returns a provider-neutral list (`StoredClip` — id,
  camera_id, occurred_at, duration estimate from `folder_size`, thumbnail if cheaply
  available).
- `POST /api/camera/{camera_id}/clip/{clip_id}/retrieve` — proxies `startDownload`,
  writes the muxed MP4 to a short-lived local cache path, returns its URL.
  `_require_local`-gated, matching every other mutating/resource-fetching endpoint
  in this codebase.
- A future `get_recent_activity()` / `get_clip(...)` voice tool (per §8) would sit on
  top of these, not talk to the bridge directly.

None of this is built yet — it's the natural shape given everything verified above,
left here so Phase 3 doesn't have to re-derive it.

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
| `eufy_session_file` | `.eufy_persistent.json` | Bridge session file (git-ignored). Relative to the backend working dir, alongside `.msal_token_cache.json` — see §5.5. |
| `eufy_openudid` | `None` (bridge generates + persists one) | Stable device fingerprint; changing it forces 2FA and risks eviction. |
| `eufy_camera_names` | `{}` | Optional `{serial: "Front door"}` map for friendly labels; falls back to the device's own `name`. Reuse the `_split_csv` / `NoDecode` pattern in `config.py`. |
| `eufy_front_door_serial` | `None` | Which camera's doorbell/person events get the prominent wake treatment. This household's front door is `T8160P11231428D3` (verified 2026-09-10 — confirm it hasn't changed before hardcoding). |
| `eufy_station_lan_ip` | `None` | This household's HomeBase is at `192.168.50.85` (verified 2026-09-10). Feeds `stationIPAddresses` — see the local-discovery pitfall in §5.1. |
| `eufy_motion_reset_seconds` | `20` | How long a pulse event (`motion`, `personDetected`) stays "active" with no repeat. |
| `eufy_alert_seconds` | `60` | Auto-dismiss window for doorbell / alarm banners. |
| `eufy_contact_open_exception_seconds` | `600` | How long a `contactState.open` must persist before it becomes an exception. |

`eufy_enabled` is independent of `calendar_provider` — do not fold it into that
selector.

### 6.2 New package `app/eufy/`

Mirror the shape and conventions of `app/voice/` and `app/calendar/`.

- **`client.py`** — a minimal async reader for the bridge's NDJSON stream: connect,
  yield parsed event dicts, expose the control channel for captcha/2FA answers and
  for clip-retrieval requests (§5.7). No reconnect logic here.
- **`events.py`** — pure mapping functions, bridge event dict → `CameraEvent` /
  `CameraEventKind` (§2). Unit-tested in isolation with captured fixtures. No I/O.
- **`service.py`** — `EufyEventService`, the long-lived owner:
  - `async run()`: connect → read → on drop, exponential backoff reconnect
    (cap ~60 s), forever, while `eufy_enabled`. Always attempt the persisted session
    first (§5.5) before falling back to a fresh login.
  - maintains the **current activity snapshot** in memory: active per-camera
    states + a bounded (~20) recent-activity ring buffer + current exceptions.
    Expires pulse states after `eufy_motion_reset_seconds`, banners after
    `eufy_alert_seconds`, via a lightweight timer task.
  - on every state change, builds an `ApplicationMessage` and fans it out to
    connected `/api/ws` clients (§6.4).
  - exposes `snapshot()` for `GET /api/household` and `status()` for diagnostics
    (`connected` / `connecting` / `needs_signin` / `disabled` / `error`, last
    event time, device count).
  - exposes the clip-retrieval proxy calls for §5.7's endpoints.
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


class StoredClip(BaseModel):
    """A single retrievable local-storage event — the §5.7 surface."""
    clip_id: str            # opaque; wraps the SDK's storage_path + cipher_id
    camera_id: str
    occurred_at: datetime
    approx_duration_seconds: float | None = None  # estimated from folder_size, not exact
```

Extend `ApplicationMessage` with an optional `activity: HouseholdActivity | None`
(or generalise the envelope — decide during the build). Keep `HouseholdException`
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
- Add the §5.7 clip-listing/retrieval endpoints.
- Do **not** build a generalized event bus or router — one service, direct fan-out
  for events, small dedicated endpoints for clip retrieval. `AGENTS.md` is explicit
  about this.

### 6.5 First-login helper (`python -m app.eufy`)

Model it on `app/auth.py` (`login` / `status` / `logout`):

- `login` — ensure the bridge is running, connect to its control channel. First
  check whether `.eufy_persistent.json` already yields a valid session (§5.5) — if
  so, this is a no-op. Only if a fresh login is actually needed, and the bridge
  reports `captcha` / `2fa`, prompt on stdin and send the answer. Print final
  status.
- `status` — connect, print `connected` / roster / last event time.
- `logout` — clear the session file (document that this forces a fresh 2FA and
  can briefly trip the abuse cooldown if repeated — see §5.6).

A kiosk-side sign-in UI (QR/device-code like the calendar connect sheet) is
**deferred** — eufy's captcha is an image challenge that does not fit that flow.

### 6.6 Dependencies

- Backend: add `websockets>=13,<16` (or reuse `httpx`/`aiohttp`) to
  `pyproject.toml`, imported lazily inside `app/eufy/` only.
- `eufy-bridge/` has its own `package.json` pinning `eufy-security-client` exactly
  (verified: `4.1.1-1`), plus an `engines.node >= 24.0.0` requirement — confirm the
  deployment host has a Node 24 runtime available to the bridge process before
  building this for real.

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
- **Clip retrieval UI is now built** — see §15. It replaced the old `MOCK_EXCEPTION`
  "garage door" placeholder in the home-view right rail with a two-thumbnail
  gallery (`CameraGalleryCard` in `App.tsx`) and a centered tap-to-play modal
  (`CameraClipModal`), not a Settings/diagnostics-only surface as this
  paragraph originally assumed. Privacy mode replaces thumbnails with generic
  placeholders and disables the tap, matching the redaction rule the rest of
  this section already states.
- **No live camera imagery** in the *ambient* appliance UI still holds — the
  gallery is deliberately a touch-initiated review (tap a thumbnail, watch a
  clip), never an auto-playing or live feed on the passive Home screen.

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

- **Display wake** (`docs/camera-support-plan.md`): a doorbell press or a
  front-door person-detected event is an excellent wake trigger. `docs/presence-module-plan.md`
  formalizes this: eufy events become a `zone`-scope `PresenceSignal` source
  (mapped from `CameraEvent` in `app/eufy/service.py`), which by construction can
  never reach the `kiosk`-scope display policy.
- **Voice** (`docs/voice-support-plan.md`): a future read-only tool
  `get_recent_activity()` could answer "did anyone come to the door?" from the
  `GET /api/household` snapshot; a `get_clip(...)` tool could sit on top of §5.7.
  Additive, no new provider access.
- **Wake word** (`docs/wake-word-plan.md`): unrelated; no dependency.

None are prerequisites; none should block this work.

---

## 9. Testing

Deterministic, no network, no real eufy account — mirror `test_graph.py` /
`test_voice.py`.

- **`events.py` mapping** — feed captured bridge event lines (commit a
  `tests/fixtures/eufy/` set: motion, personDetected, strangerDetected,
  doorbellPress, contactState open/close, alarm triggered/delayed, batteryAlert,
  propertyChanged, session-expired). Assert each yields the right `CameraEvent` /
  clears the right state / converts the timestamp. **Do not commit real captured
  debug logs as fixtures** — they contain live account tokens (§5.1); hand-craft
  or redact fixtures instead.
- **`EufyEventService` policy** — with a fake client yielding scripted lines:
  pulse events expire after `eufy_motion_reset_seconds`; a doorbell banner clears
  after `eufy_alert_seconds`; a `contactState.open` becomes an exception only
  after `eufy_contact_open_exception_seconds` and clears on close; a mid-stream
  disconnect reconnects and re-syncs without losing the snapshot;
  `eufy_enabled=false` ⇒ service never constructed, `/api/ws` sends only the
  hello, `GET /api/household` ⇒ 409; failure classification
  (`auth` vs `bridge_unreachable` vs `session_lost`); session-file-present ⇒ no
  login attempted.
- **API** — `GET /api/household` shape & 409-when-disabled; `/api/ws` pushes an
  `ApplicationMessage` when the faked service changes state and sends a snapshot
  on connect. Add clip-listing/retrieval endpoint tests once §5.7 is built.
- **Frontend** — mock the `/api/ws` stream: doorbell banner appears and
  auto-dismisses; activity list renders newest-first and hides when empty;
  camera-derived exception uses the `MOCK_EXCEPTION` card; everything
  camera-related absent when `source_status='disabled'`; Settings "Cameras"
  reflects status.
- **Playwright** — a `VITE_EUFY_FAKE=1` scripted stream (like `VITE_VOICE_FAKE`):
  banner + activity list + no document overflow at 3840×2160 / 1920×1080.
- **Bridge** — a Node test that runs it against a stubbed `EufySecurity` (fake
  event emitter) and asserts the NDJSON output shape and the captcha/2FA control
  handshake. No real SDK, no network.
- **Manual, real hardware** (documented checklist — largely already exercised by
  the 2026-09-10 spike): walk past the S330 → `motion`/`personDetected` within
  seconds; press the doorbell → banner; open a contact sensor → exception after
  the threshold; kill the bridge → Settings shows "Unavailable", calendar
  unaffected, restart recovers; a session-file-present restart skips login
  entirely; list + retrieve a clip via §5.7's endpoints and confirm it plays.

---

## 10. Rollout phases

**Phase 0 — watch and gate.** No longer applicable to clip retrieval (unblocked).
Optionally still watch `@mega-yfue/eufy-sdk` out of curiosity for the *events*
capability, but nothing here depends on it.

**Phase 1 — spike. DONE (2026-09-10).** Login, station/device enumeration, local
P2P connect, event listing (`databaseQueryByDate`), clip download + decrypt, and
muxing to a playable file were all verified against this household's real S380 and
Front Door camera. Findings are captured throughout §5 above. Explicit go: proceed
to Phase 2 whenever the household wants this built.

**Phase 2 — the bridge + backend pipeline.**
`eufy-bridge/` (pinned `eufy-security-client`, NDJSON, captcha/2FA control
channel, clip-retrieval control messages per §5.7); `config.py`; `app/eufy/`
(`client`, `events`, `service`); `models.py` (including `StoredClip`); `lifespan`
in `main.py`; `/api/ws` fan-out; `GET /api/household`; the §5.7 clip endpoints;
`python -m app.eufy`; `websockets` dep. Full test coverage with fakes. No frontend
yet.

**Phase 3 — frontend ambient surfaces.**
`/api/ws` payload consumption; doorbell/alarm banner; activity list; real
exceptions replacing `MOCK_EXCEPTION`; Settings "Cameras" section. Frontend +
Playwright tests. Clip-retrieval UI, if wanted, is a separate later decision — not
assumed here.

**Phase 4 — hardening + docs.**
Reconnect/backoff tuning; event-expiry edge cases; audio muxing for retrieved
clips (unbuilt, see §5.4); `.env.example` block; `README.md` run notes (incl. the
bridge + Node 24 requirement); `AGENTS.md` updates (§12); a deployment doc for the
bridge process; **migrate off the primary eufy account onto a dedicated one**
before this runs unattended long-term (§5.6). Manual hardware checklist run and
recorded.

---

## 11. Open questions (resolve with the user before Phase 2)

1. **Dedicated account migration.** The verified spike used the primary account.
   Confirm a dedicated account will be created and invited to the HomeBase before
   Phase 2 starts, or explicitly accept the primary-account risk for the real
   build too.
2. **Bridge process management.** `AGENTS.md` lists Docker as a non-goal. The
   bridge needs Node >= 24 — run it under the same supervisor as uvicorn / the
   kiosk browser (Windows service / NSSM / Task Scheduler), or containerise it?
   Needs a call. Also decide how the bridge gets a Node 24 runtime if the host's
   system Node is older (the spike used a portable extraction, not a system
   install).
3. **Region** for the account (must match the eufy app exactly). Not directly
   verified — the spike used `"US"` and it worked, but this should be confirmed
   against the actual account settings, not assumed.
4. **Which cameras + friendly names + roles?** This household: HomeBase `Home`
   (`T8030P13232003FB`), `Front Door` (`T8160P11231428D3`), `KittyCam`
   (`T8160P1123171396`). Confirm `Front Door` is still the right
   `eufy_front_door_serial` before hardcoding it into config.
5. **HomeBase familiar faces:** if face recognition is on, `personDetected` fires
   for known faces. Decide whether to surface a recognized name if a future SDK
   version exposes one, or deliberately not (privacy; not an auth mechanism, per
   `camera-support-plan.md`).
6. **Attention budget:** may a doorbell ring interrupt the ambient calendar view
   with a banner, or stay confined to the right rail?
7. **Contact sensors:** are there any eufy entry sensors on this HomeBase, or is
   `contactState` moot for now? (Affects whether the "door open too long"
   exception ships in Phase 3.)
8. **Clip-retrieval product shape:** is on-demand clip retrieval a voice-only tool
   ("did anyone come to the door, show me"), a Settings/diagnostics affordance, or
   both? §5.7 proposes the backend surface either way; the UI decision is open.
9. **ToS tolerance:** acknowledge this uses an unofficial API against Anker's ToS
   and can break, rate-limit, or lock the account, and that that is acceptable for
   a personal-use feature. The 2026-09-10 near-miss (§5.6.1) makes this concrete,
   not abstract.

---

## 12. `AGENTS.md` / `.github/copilot-instructions.md` updates this work requires

- Note the new subsystem under "Repository layout" (`app/eufy/`, `eufy-bridge/`)
  and "Architecture & boundaries": camera events *and* clip retrieval are
  provider-neutral (`HouseholdActivity`, `StoredClip`), mapped at the `app/eufy/`
  boundary; SDK JSON never reaches React — the same rule as calendar providers.
- Record the **deliberate deviations**: (a) an unofficial third-party SDK is a
  soft dependency of an *optional, feature-flagged* capability, isolated in a
  Node sidecar, with the calendar function unaffected by its failure; (b) full
  eufy account credentials are held server-side, justified by there being no
  official API; (c) a Node runtime (>= 24.0.0) is now a deployment prerequisite
  when the feature is on; (d) this is the first capability in the repo that
  retrieves and stores decrypted media locally (however briefly, for clip
  retrieval) — confirm this doesn't conflict with any existing "no media at rest"
  assumption elsewhere in the docs.
- Update the "Real-time" note: `/api/ws` + `ApplicationMessage` are now wired for
  real (camera activity), still deliberately not a generalized event bus.
- Add a durable line (as `camera-support-plan.md` already does for ML/vision):
  unofficial-API integrations must stay feature-flagged, isolated, and severable,
  and must never degrade the core calendar experience; any pinned third-party
  SDK must have its licence re-checked on upgrade; **any config value that feeds
  a timer/interval must be validated against platform limits before shipping**
  (§5.1's overflow pitfall).

---

## 13. Explicitly out of scope

Live video / RTSP / WebRTC streaming (the clip gallery is on-demand tap-to-play
of a *stored* recording, never a live feed); talkback; PTZ or any
camera/station control; arming / disarming / guard-mode changes; **any write
path**; face **recognition** / enrolment (the HomeBase's own output may be
*displayed* if the user opts in and a future SDK version exposes a name, but
Mission Control does no recognition itself); a kiosk-side eufy sign-in UI;
non-eufy cameras; persisting event *history* to disk beyond the short-lived
retrieved-clip cache (§5.7, §15); multi-HomeBase / multi-site; the SDK's
vacuum / mower / smart-light / lock capabilities; the ambient events pipeline
(§2 / §7.2 — motion/person/doorbell banners, contact-sensor exceptions,
Settings "Cameras" diagnostics) — designed, not built by this pass.

**No longer out of scope, as of this revision:** recorded-clip retrieval and
decryption (§5, hardware-verified) and the clip-browsing gallery UI itself
(§15, built 2026-09-11) — both excluded in earlier drafts, the first because
the SDK then targeted (`@mega-yfue/eufy-sdk`) never supported it, the second
because it was left as a future decision once retrieval was proven. Audio
muxing (§5.4) is also no longer a gap — §15's bridge muxes video+audio when
both decode cleanly and falls back to a silent mux otherwise, rather than
dropping audio unconditionally.

---

## 14. Sources

- **This household's own 2026-09-10 verification spike** — the primary source for
  §5. Login, station/device enumeration, local P2P connect, `databaseQueryByDate`,
  `startDownload`, and ffmpeg muxing were all exercised live against the real
  HomeBase 3 and Front Door camera. Verbose debug logs from that spike were
  deleted after use (they contained live account tokens); the findings above are
  everything worth keeping from them.
- `bropat/eufy-security-client` — <https://github.com/bropat/eufy-security-client>
  (npm `eufy-security-client`). Source inspected directly: `src/eufysecurity.ts`
  (`EufySecurity.initialize`, `connect`, event list), `src/http/station.ts`
  (`databaseQueryLocal`, `databaseQueryByDate`, `startDownload`,
  `cancelDownload`), `src/http/utils.ts` (`decodeImage`/`decodeImageAsync`, the
  `v2_eufysecurity:` format added 2026-06-10), `src/p2p/session.ts` (RSA-wrapped
  per-session AES key exchange, `decryptAESData`), `src/p2p/utils.ts`
  (`getP2PCommandEncryptionKey`, AES-ECB P2P command crypto), `src/http/interfaces.d.ts`
  (`EufySecurityConfig`, `LoginOptions`), `src/p2p/interfaces.d.ts`
  (`DatabaseQueryLocal`, `DatabaseQueryByDate`, `HistoryRecordInfo`,
  `StreamMetadata`).
- Victor Goeman, Dairo de Ruck, Tom Cordemans, Jorn Lapon, Vincent Naessens
  (DistriNet, KU Leuven), *"Reverse Engineering the Eufy Ecosystem: A Deep Dive
  into Security Vulnerabilities and Proprietary Protocols,"* 18th USENIX WOOT
  Conference, 2024 — <https://www.usenix.org/conference/woot24/presentation/goeman>.
  Documents the media-AES-key derivation algorithm (`create_pic_code_v1`,
  `getPPCSSuffix`) that `eufy-security-client`'s `getImageKey`/`decodeImage`
  independently implement and keep current; the P2P command AES-ECB key
  derivation; the hidden `OCEAN_XXXXXX` Wi-Fi network and its WPA2-PSK weakness
  (CVE-2023-37822) — **not pursued in this investigation** (needs monitor-mode
  Wi-Fi hardware not available, and is unnecessary given the LAN-direct P2P path
  above already works).
- `@mega-yfue/eufy-sdk` — <https://mega-yfue.github.io/> / npm
  `@mega-yfue/eufy-sdk`. Confirmed still at `0.0.5` (2026-08-05 scaffold) as of
  2026-09-10, no new release. Retained only as a historical note; not a
  dependency of anything in this document.
- Prior-generation context: `bropat/eufy-security-client`'s own README frames
  itself as speaking eufy's REST + P2P APIs directly (not exclusively a "legacy"
  backend as an earlier draft of this doc assumed) — corroborated by the
  2026-06-10 `v2_eufysecurity:` addition and by this investigation's direct
  success against a current-generation HomeBase 3.

---

## 15. The clip gallery, as actually built (2026-09-11)

This section is the payoff of the 2026-09-11 build session: exactly what
shipped, what's verified vs. best-effort, and what a future session should
check first against the real household hardware/account. §5 remains the
authoritative record of the 2026-09-10 hardware verification spike; this
section is the implementation built on top of it.

### 15.1 What's real and running

- **`eufy-bridge/`** (Node, `eufy-security-client@4.1.1-1` pinned) — logs in
  (reusing the persisted session first, per §5.5), enumerates stations/devices,
  opens local P2P (`ONLY_LOCAL`), and exposes a localhost WebSocket control
  channel (`src/server.js`) the backend connects to. `src/eufyBridge.js` owns
  the SDK interaction; `src/ffmpeg.js` muxes a downloaded clip; `src/config.js`
  validates env config (including the §5.6.1 polling-interval overflow guard,
  independently re-checked here since this is the process that actually feeds
  the value to Node's timer).
- **`backend/app/eufy/`** — `client.py` (thin WS client), `service.py`
  (`EufyEventService`: bounded newest-first clip ring buffer, a bounded
  thumbnail LRU, request/response plumbing for thumbnail/video, exponential
  backoff reconnect), `bridge_process.py` (spawns/supervises the bridge child
  process — this build's answer to §11 open question 2: the backend owns
  process lifecycle, no NSSM/Task Scheduler/Docker), `__main__.py`
  (`python -m app.eufy login/status/logout`, modeled on `app/auth.py`).
- **`GET /api/household`**, **`GET /api/camera/clip/{id}/thumbnail`**,
  **`GET /api/camera/clip/{id}/video`** in `app/api.py` — LAN-gated, 409 while
  `eufy_enabled` is false, 404 for an unknown clip id, 503 (never 500) when the
  bridge can't resolve a thumbnail/video in time. `StoredClip` /
  `CameraGallerySnapshot` in `app/models.py`; `ApplicationMessage.camera_clips`
  / `camera_status` push the same shape over `/api/ws` on every change.
- **Frontend**: `src/camera/useCameraActivity.ts` (mirrors `useDisplay.ts` —
  `GET /api/household` reconcile + the shared ws push), `CameraGalleryCard` and
  `CameraClipModal` in `App.tsx`, replacing `MOCK_EXCEPTION` in the home-view
  right rail. Two 16:9 thumbnails (the rail's real width/height budget, not a
  style choice), a bottom scrim + centered play glyph + duration pill (the
  standard YouTube/Nest/Ring tappable-video language), tap opens a centered
  modal (not the bottom-anchored `.detail-sheet` family) with a plain
  `<video controls autoplay>`. Privacy mode swaps thumbnails for a generic
  camera-icon placeholder, issues no thumbnail fetch, and the tap is inert.
- **Freshness has no new cloud-facing polling.** The bridge's own periodic
  `databaseQueryByDate` reconciliation (`eufy_reconcile_interval_seconds`,
  default 120s) is LAN-local P2P to the HomeBase, not a call to eufy's cloud;
  real device events (where they fire — see 15.2) additionally trigger an
  immediate narrow re-query. The only cloud-facing cadence is the SDK's own
  daily session refresh, unchanged from §5.2's verified config.
- **Tests**: `backend/tests/test_eufy_events.py` (pure mapping),
  `test_eufy_service.py` (21 cases against a scripted fake bridge client —
  ring-buffer bounds/dedup, status transitions, thumbnail/video request
  round-trips, disconnect handling), `test_api_camera.py` (10 endpoint-shape
  cases), `eufy-bridge/test/` (13 `node:test` cases against a stubbed
  `EufySecurity`-shaped fake — roster loading, clip dedup, the captcha/2FA
  `connect()` handshake, the thumbnail round trip), `frontend/src/camera/
  useCameraActivity.test.ts` (4 cases), 4 new cases in `App.test.tsx` (tap to
  open, outside-tap dismiss, collapses when empty, privacy placeholders). All
  green; `ruff check`/`format`, `tsc -b`, and `eslint` all clean.
- **Manually verified in-browser** (this session, via a fixture-backed fake
  `get_eufy_service()` — no real eufy account touched): the gallery renders
  from `GET /api/household`, no document overflow at 1920×1080, tap opens the
  centered modal, Escape and outside-tap both dismiss it, privacy lock swaps in
  placeholders with zero thumbnail fetches. This is UI-layer verification only
  — see 15.2 for what is *not* yet proven against real hardware.

### 15.2 What's genuinely unverified — check these first on the real HomeBase

The 2026-09-10 spike (§5) proved login, device enumeration, local P2P connect,
`databaseQueryByDate`, `startDownload`, and ffmpeg muxing. This build session
had no access to the household's real eufy account, hardware, or a Node ≥24
runtime (this dev sandbox has Node 20; `npm install` succeeds with an engine
warning, real SDK behavior was not exercised). Two things this design leans on
were **not** covered by that spike and should be confirmed on first real run:

1. **The ambient device event names** (`"device motion detected"`, `"device
   person detected"`, `"device rings"`, etc., used only as a low-latency
   accelerant for the reconciliation poll — see `DEVICE_EVENT_NAMES` in
   `eufy-bridge/src/eufyBridge.js`) were confirmed against
   `eufy-security-client` 4.1.1-1's own published type definitions
   (`build/interfaces.d.ts`, inspected directly 2026-09-11), not against a real
   device firing them. If a name is wrong or the household's firmware doesn't
   emit it, the *only* consequence is latency — the periodic reconciliation
   still finds the clip within `eufy_reconcile_interval_seconds` — never a
   missed clip or a crash.
2. **`station.downloadImage(thumb_path)` → `"station image download"`** (the
   per-clip thumbnail path) is a real, documented method on `Station`
   (verified against the same type definitions) but was not itself exercised
   live — the 2026-09-10 spike proved the *connect-time per-camera snapshot*
   decode, not this specific call against a stored record's `thumb_path`. If it
   doesn't resolve, `GET /api/camera/clip/{id}/thumbnail` degrades to a 503
   (the gallery shows nothing for that thumbnail, no crash) rather than
   silently succeeding with wrong bytes.

Also unverified end-to-end because it needs a real HomeBase 3 + Node ≥24:
`_downloadAndMux`'s stream-piping/timeout/cancel logic, and `muxClip`'s
HEVC/H.264 × with/without-audio fallback ladder (`eufy-bridge/src/ffmpeg.js`)
against a real downloaded elementary stream and a real `ffmpeg` binary on the
deployment host (confirm `ffmpeg` is on PATH there — it is not a declared
dependency anywhere yet).

### 15.3 Decisions this build session made that extend §3/§6/§11

- **Primary eufy account, explicitly accepted risk.** §11 item 1 asked
  whether to migrate to a dedicated account before Phase 2. The household's
  direction for this build: use the primary account, lean hard on session-file
  reuse (§5.5) and the reconciliation design above to keep actual cloud-facing
  traffic minimal, and accept the elevated risk rather than block on account
  migration. Revisit if the account ever shows rate-limit/eviction symptoms.
- **Bridge process management** (§11 item 2) resolved as: the FastAPI backend
  spawns and supervises the bridge as a child process
  (`app/eufy/bridge_process.py`), restarting it with the same backoff policy as
  the WS reconnect. No Docker, no Windows service, no NSSM — one `uvicorn` run
  brings the whole feature up when `MISSION_CONTROL_EUFY_ENABLED=true`.
- **`openudid` is not a settable init-time config field** — §6.1's original
  table proposed `eufy_openudid`; the real `EufySecurityConfig` (verified
  2026-09-11) has no such field. The library generates and persists it itself,
  inside the session file. `Settings.eufy_openudid` was removed accordingly.
- **`stationIPAddresses` needs the serial known up front** — added
  `eufy_station_serial` alongside `eufy_station_lan_ip` so both can be passed
  to `EufySecurity.initialize()` together, matching the real (keyed-by-serial)
  shape of that config option.
- **Clip id** is `{device_sn}:{record_id}` — `record_id` (a field on
  `DatabaseQueryByDate` this document's earlier drafts didn't mention) is a
  clean stable per-station key, simpler than the start-time encoding §5.7
  implied.
- **Ambient events pipeline (§2/§7.2) is still not built.** This session
  scoped to the clip-review gallery specifically, per the household's request
  to replace the garage-door placeholder — motion/person/doorbell banners, the
  activity list, contact-sensor exceptions, and the Settings "Cameras"
  diagnostics section remain exactly as designed earlier in this document,
  unchanged and unbuilt. `CameraEvent` / `HouseholdActivity` in this doc's
  §6.3 were not added to `app/models.py`; only `StoredClip` /
  `CameraGallerySnapshot` were.

### 15.4 Not done in this pass

- Settings "Cameras" diagnostics section (§7.3) — status/roster/reconnect
  count are exposed by `EufyEventService` internally but have no UI yet.
  `GET /api/household` carries only what the gallery needs.
- `HTTP Range` support on `GET /api/camera/clip/{id}/video` — clips are short
  household recordings, so this was accepted as a v1 gap rather than built.
- A voice tool over this surface (§8) — not started, not needed for the
  gallery to work.
- Migrating off the primary eufy account (§15.3 above).
- Any production deployment doc for the bridge process beyond
  `bridge_process.py` itself (Node ≥24 provisioning on the real kiosk host is
  still a manual prerequisite — this dev sandbox only has Node 20).

---

## 16. First live hardware bring-up (2026-09-11): negative findings and current state

§15 above was written from the 2026-09-10 verification spike plus a same-day
build session against a fixture-backed fake service — real household
credentials, hardware, and Node ≥24 were still untested end-to-end at that
point (§15.2). This section covers what happened bringing it up for real
against this household's actual account, HomeBase 3, and Front
Door/KittyCam cameras, later the same day. Net result: the gallery UI works
end-to-end against real footage (thumbnails, playback, layout all verified),
but **freshness is broken in a way this document did not anticipate**, and
one proposed fix (cloud backfill) turned out to be a dead end for this
account. Read this section before touching `eufy_reconcile_lookback_minutes`
or re-attempting a cloud-backed approach.

### 16.1 Fixed during bring-up

- **`clip_discovered` ordering bug.** `eufy-bridge/src/eufyBridge.js`'s
  `_onDatabaseQueryByDate` emitted records in whatever order the SDK
  returned them; the backend's ring buffer (`EufyEventService._add_clip`)
  does an unconditional `appendleft` per event assuming ascending-chronological
  emission, so a newest-first (or unordered) SDK response silently inverted
  the gallery and evicted the newest clips first as the buffer filled. Fixed
  by sorting explicitly before emitting; covered by a regression test.
- **`ffmpeg` not resolving from a freshly-`winget`-installed PATH.** The
  shell that spawned the backend predated the PATH update; refreshing
  `$env:Path` from the registry before restart fixed it. Not a code bug, but
  worth remembering for the next fresh-machine bring-up.
- **Gallery card 2×2 layout silently overflowed at realistic kiosk heights.**
  Built and screenshot-verified as 2×2 (up to 4 clips), but a 1366×768
  viewport test showed the card's bottom clipped invisibly by an ancestor's
  `overflow:hidden` — no scrollbar, content just vanished. Switched to a
  single row of 4, which keeps true 16:9 crops and fits comfortably at both
  1366×768 and 1920×1080 (verified via DOM geometry, zero overflow).
- **Clip-modal close button read as misplaced.** The reused `.detail-sheet`
  style (`top:14px; right:18px`, cream fill) was built for a component with
  header space above its content; here the video sits flush against the
  card's padding, leaving ~2px clearance, so the button mostly overlapped the
  video with low contrast. Restyled using the app's own dark-translucent
  video-overlay language (matching the thumbnail play glyph) with real
  clearance.

### 16.2 Confirmed, not fixed: local `databaseQueryByDate` isn't reliably tied to the requested window

Querying the real station with different lookback windows produced small
(5–9 record), *different* clusters each time, consistently near the **start**
of whatever range was requested — never reliably reaching records close to
"now" even when a window nominally included a clip confirmed to exist (via
the eufy app) well inside it. Concretely: a 7-day window returned only the
oldest day in range; a 2-day window returned a different, single day; a
6-hour window returned yet another. Widening the window makes this *worse*
(surfaces older data), not better.

Partially root-caused: `eufy-security-client`'s `databaseQueryByDate()`
truncates the precise `since`/`until` `Date` objects to day granularity
(`format(startDate, "YYYYMMDD")`) before the P2P request is ever built
(`eufy-bridge/node_modules/eufy-security-client/build/http/station.js:13337-
13338`) — sub-day windowing never reaches the device. What is **not**
explained by anything found in the SDK's source (a dedicated code-reading
pass turned up no pagination cursor, no "more results" signal, and confirmed
`returnCode` is a plain success/error flag, not a continuation token): why
only a handful of records ever come back per call at all, or why they
cluster at the range's oldest edge specifically. Likely related to the v6/
"mega" backend migration noted in §1 — the SDK client has kept pace on the
image-decode side, but this account/firmware may be mid-transition
server-side in ways that affect how `databaseQueryByDate` responses are
paged or windowed. Not confirmed; flagged as the leading hypothesis only
because the symptom pattern (works locally, cloud index empty, push silent)
lines up with "parts of the migration landed, parts didn't" better than any
single-bug explanation found so far.

**Mitigation (not a fix):** `MISSION_CONTROL_EUFY_RECONCILE_LOOKBACK_MINUTES`
is parked at `1440` (1 day) — empirically the smallest of {1, 2, 3, 6, 7}-day
windows tried that reliably returned ≥4 clips (returned 6 on the first try).
This guarantees *a* gallery isn't empty; it does not guarantee those 4+ clips
are the most recent ones that exist. Do not widen this further expecting
better recency — it was tried up to 7 days this session and only surfaces a
different, similarly-stale cluster, never anything closer to "now."

### 16.3 Abandoned: cloud history backfill

Built and tested a fallback: `EufySecurity.getApi().getVideoEvents()` (a
regular cloud REST call, precise second-granularity windowing, no observed
correlation problems) used sparingly (interval-gated, state persisted across
restarts) to seed a reliable index, with clip bytes still fetched via the
existing local P2P path (`EventRecordResponse` carries the same
`station_sn`/`device_sn`/`storage_path`/`thumb_path`/`cipher_id`/`frame_num`
fields as a local `DatabaseQueryByDate` record — confirmed by direct
comparison of `eufy-security-client`'s type definitions, so no separate
download path was needed).

**Every cloud event endpoint returned zero results against this real
account** — `getVideoEvents` (default filter and explicit
`storageType: LOCAL_AND_CLOUD`), `getAllVideoEvents` (the SDK's own
unfiltered 15-year "everything" convenience call), `getAllHistoryEvents`,
and `getAllAlarmEvents` — despite local P2P confirming real clips exist in
the exact same window. Leading explanation: **this account has no active
eufy cloud video subscription**, so nothing is indexed in eufy's cloud at
all; clips exist only in the HomeBase's local storage. Possibly compounded
by the same v6 migration referenced above. Reverted entirely — the code is
not present in this repo as of this writing. If the household adds a cloud
subscription later, or the migration completes, this approach is fully
designed and could be rebuilt quickly from this section plus git history
(commit history around 2026-09-11 has the full implementation and its test
suite, both green at time of revert).

### 16.4 Confirmed: push events do not fire under the registered names

§15.2 flagged `DEVICE_EVENT_NAMES` as verified only against the SDK's type
definitions, never real firmware. Live-tested 2026-09-11: real motion at
KittyCam (confirmed via the eufy app, with timestamp) produced no
`device event "..."` log line at all, despite the bridge being connected and
subscribed under every name in the list, well after the motion occurred. The
periodic local reconcile (which should have run at least once in the
following few minutes, well within its lookback) also did not surface the
new clip — consistent with §16.2's correlation problem, now demonstrated
against a clip of known, exact provenance rather than an ambiguous historical
one.

**Consequence:** contrary to this document's original design assumption
(§2, §15.1) that push is the primary freshness path and reconcile is only a
low-latency accelerant, *neither* path is currently reliable against this
household's real hardware. The periodic reconcile is the only thing
delivering any clips at all right now, and it has the correlation problem
above.

### 16.5 Open items for next time

- Revisit once eufy's v6/"mega" migration is confirmed complete for this
  account/region/firmware, or once the household's cloud subscription status
  is clarified (§16.3) — either could resolve some or all of §16.2–16.4 at
  once without a code change here.
- If push events matter enough to chase now rather than wait: packet-level
  capture of real P2P traffic during a confirmed motion event is the next
  diagnostic step; static code reading has been exhausted (two independent
  passes, including a dedicated subagent investigation, found no pagination
  or continuation mechanism and no event-name documentation beyond the SDK's
  own type definitions).
- `eufy-bridge/src/eufyBridge.js` now logs `local reconcile: querying ... ->
  ...` and `local reconcile: N record(s) returned` on every reconcile call,
  and `device event "..." from ...` on every push event received — added
  during this investigation specifically so a future session doesn't have to
  re-derive "did anything even run" from silence, the ambiguity that cost
  real time here.

### 16.6 Playback: HEVC video decoded by nobody — fixed via transcode, hardware decode deferred

First real-hardware clip playback on the 4K kiosk (2026-09-11): the modal
player showed audio with a **black video frame** — sound was audible and
correct, picture never appeared. Root cause: `eufy-bridge/src/ffmpeg.js`
muxed with `-c:v copy`, and this household's real clips are HEVC/H.265
(§5.1). `scripts/kiosk-start.ps1` opens the kiosk in stock Chrome or Edge;
Chrome ships with no HEVC decoder at all (licensing), so the browser opened
the muxed MP4, decoded the AAC audio track fine (universally supported), and
silently failed to decode the HEVC video track — no error surfaced anywhere,
since decode failure inside `<video>` doesn't throw, it just renders nothing.

**Fix applied:** `muxClip` now always transcodes video to H.264
(`-c:v libx264 -preset veryfast -crf 23`) instead of copying the bitstream.
This costs real CPU per clip retrieval (encode time, not a free remux) but
guarantees playback in both Chrome and Edge with no dependency on OS codec
packages.

**Deferred, not done:** hardware/OS-level HEVC decode (e.g. Windows' "HEVC
Video Extensions" package) would avoid the transcode cost entirely, but only
helps Edge — Chrome does not use OS/Media-Foundation decoders for HEVC
regardless of what's installed, and `Find-Browser` in
`scripts/kiosk-start.ps1` tries Chrome before Edge, so this only pays off if
the kiosk is also switched to preferring Edge. Revisit if per-clip transcode
latency or kiosk CPU load becomes a real problem.

**Operational note for whoever hits this again:** the eufy-bridge Node
process only reads `ffmpeg.js` (and any other bridge source file) once, at
its own startup — editing the file on disk does nothing to an already-running
bridge, and `retrieveClip` separately caches the muxed output on disk
(`eufy_clip_cache_dir`, keyed by a hash of the clip id) and skips ffmpeg
entirely on a cache hit. A backend restart is required to load bridge code
changes (it respawns the bridge as a fresh child process), and any clip
already muxed under the old behaviour stays cached and stale until its TTL
(`eufy_clip_cache_ttl_seconds`, default 600s) evicts it or the cache file is
deleted by hand — both are needed to actually exercise a bridge-side fix.

**Loading feedback added alongside this fix:** clip retrieval is a real P2P
download + decrypt + transcode, not a cheap fetch — several seconds of
`<video>` sitting there with nothing to show, which looks identical to the
black-screen bug above but for an unrelated reason (still loading, not a
codec failure). `CameraClipModal` (`frontend/src/App.tsx`) now shows a
spinner overlay ("Loading clip…") from the moment the modal opens until the
video reports `canplay`/`playing`, and a plain "Couldn't load this clip."
message if the request errors instead of spinning forever.

## 17. Live-capture session (2026-09-11): the push handler was listening for the wrong event name, and a second bug remains

§16.4 concluded "push events do not fire" against real firmware. That
conclusion was wrong — or rather, right about the symptom and wrong about the
cause. This section covers a same-day follow-up: an instrumented live capture
(a wildcard listener on the SDK client's own `emit`, a LAN packet capture, and
a phone-side `adb logcat` + PCAPdroid capture, all running across one real,
physically-triggered motion event) that found the actual root cause of one
bug and drew a hard line around a second, still-open one. Full raw artifacts
(pcaps, logcat, the instrumented bridge log) are archived locally at
`backend/.eufy-investigation/2026-09-11-push-event-live-capture/` (git-ignored
— see that directory's own `README.md` for the complete writeup this section
summarizes).

### 17.1 Root cause found and fixed: `DEVICE_EVENT_NAMES` was missing the `"device "` prefix

`eufy-bridge/src/eufyBridge.js` subscribed to bare event names — `"motion
detected"`, `"person detected"`, etc. — taken from a reading of
`eufy-security-client`'s type definitions (`build/interfaces.d.ts`,
`EufySecurityEvents`) during the 2026-09-10 spike. Each entry in that
interface is one indivisible string key, and every one of them is actually
**prefixed**: `"device motion detected"`, `"device person detected"`. Reading
the type defs as `"device"` + a suffix, rather than each full string being the
literal event name, meant `client.on("motion detected", ...)` was listening
for a string the SDK never emits, under any firmware, on any account — not an
account-side or v6/"mega"-migration problem as §16.4 assumed.

Confirmed directly: a diagnostic wildcard listener wrapping `client.emit`
(gated behind `EUFY_DEBUG_RAW_EVENTS=1`, see `src/config.js` — off by
default, verbose) captured `[raw-event] "device motion detected" (2 args)`
and `[raw-event] "device person detected" (3 args)` firing twice, ten seconds
apart, at the exact moment of a real physical trigger at the Front Door
camera. Both strings match the type defs exactly. **Fixed:** every entry in
`DEVICE_EVENT_NAMES` renamed to the real, prefixed string; the bridge test
suite's fake-client event now emits the corrected name too. All 14 bridge
tests pass.

This restores the intended low-latency push path (a real event now correctly
triggers `_onDeviceEvent`'s narrow re-query) — it does **not**, on its own,
make new clips appear, because of §17.2.

### 17.2 Confirmed still open: the narrow re-query hits the same broken `databaseQueryByDate`

`_onDeviceEvent`'s targeted re-query calls the same `station.databaseQueryByDate()`
that §16.2 already documented as unreliable. Live-tested across four
periodic reconcile cycles spanning the trigger (~2 minutes before to ~2
minutes after) — all four returned the identical stale 6-record cluster, even
the one that ran after the confirmed push arrived and after the official app
had already retrieved the new event by a different path (§17.3). Fixing
§17.1 alone does not fix "new events don't appear" — a correctly-wired push
handler still terminates in this same broken query.

### 17.3 Why the official app succeeds: a separate, undocumented event-history API

`adb logcat` captured the official app's own pull-to-refresh at the
ReactNativeJS layer, making two distinct calls:

- `TopEventAPI` (cloud video events) → `count=0` — the same dead cloud-video
  endpoint family as §16.3's abandoned backfill attempt.
- A second call, logged as `PullRefresh_Phase2_EventAPI` /
  `refreshEventData` → **`count=2`**, returning both the just-triggered event
  and the original one from earlier that day:
  ```
  {"megaEventId":"T8030P13232003FB~local~2026091100005","startTime":"2026-09-11 12:09:46"}
  {"megaEventId":"T8030P13232003FB~local~2026091100001","startTime":"2026-09-11 10:56:51"}
  ```

The `megaEventId` naming and `~local~` tag point at eufy's newer "mega"
backend exposing a lightweight local-event *metadata* index — separate from
both the dead cloud-video API and from `databaseQueryByDate`'s local P2P
path. SNI from the phone-side pcap (still useful without decryption — SNI is
always sent in the clear) shows a tight cluster of TLS handshakes right
before the API responses land, with `app-house-us-pr.eufy.com` the leading
candidate for the working call (name matches the `houseId` field in the
app's own logged request payload) against `security-app.eufylife.com` as the
likely dead `TopEventAPI` host — not confirmed at the payload level (see
§17.4).

**A promising lead for actually fixing this:** the installed
`eufy-security-client` (4.1.1-1, and 4.2.0 — checked, no newer surface)
already ships `build/http/megaApi.js` (`MegaHTTPApi`) — device-list and MQTT
push-config methods (`getThingsListDecrypted`, `getDevsListDecrypted`,
`getUserMqttInfo`, `getMqttConnectConfig`), plus, critically, **generic
authenticated call primitives**: `call(host, path, payload)` and
`callDecrypted(service, path, payload)`, backed by the SDK's own session
management (`setAuth`/`hasValidSession`/`exportSession`). A source comment in
`megaApi.js` near the MQTT config method confirms v6 events are pushed over
this channel but notes it "is NOT a live event path today" in this SDK
version. None of `megaApi.d.ts`'s methods wrap an event-history query
directly, in either version — but the generic `call`/`callDecrypted`
primitives mean we would not need to reimplement mega's auth/session/crypto
from scratch to call whatever endpoint the app calls; we would only need to
learn the exact path and payload shape and hand them to a method the SDK
already provides.

### 17.4 The decrypted-capture chase, and why it's a dead end on this hardware

Same-day follow-up (still 2026-09-11), trying every candidate from the
original open-items list to get a decrypted capture of the `Phase2_EventAPI`
call:

- **PCAPdroid's exported `.pcap`** — confirmed useless for this: it's a plain
  legacy `.pcap`, which cannot carry embedded decryption secrets (that needs
  `.pcapng` + a keylog, which this PCAPdroid version did not produce). SNI
  from the handshake (always cleartext, decryption-independent) was still
  extractable and is what gave the `app-house-us-pr.eufy.com` candidate.
- **The app's APK / React Native JS bundle** — genuine dead end, not a
  tooling gap. Pulled the base APK and the feature module actually behind the
  Events tab (`RN_ANDROID_ZX_EVENT_TAB.zip`, confirmed correct via matching
  log-message strings found in its Hermes bytecode — `"[RNEvent]
  refreshEventData:"` etc.). No hardcoded host or path string exists anywhere
  in it. This matches the SDK's own architecture
  (`MegaHTTPApi.getDomains()`/`estimateDomain()`, §17.3) — the app resolves
  its backend host dynamically at runtime the same way, so there was never a
  literal URL to find by static search, with or without better Hermes
  tooling. (Separately: the base APK is wrapped in Ijiami app-protection —
  irrelevant here since the Events module lives in an unprotected downloaded
  RN bundle, but worth knowing if a future session goes looking for something
  in the *native* app shell instead.)
- **System-wide MITM (mitmproxy)** — got this fully working as
  infrastructure (installed, LAN-reachable, Windows Firewall approved,
  correctly proxying plaintext HTTP) but the phone's HTTPS traffic to eufy's
  backend never got a chance: the household's phone has an **MDM-enforced
  Always-On VPN** (Tailscale-range address, `100.64.0.0/10`; survived a full
  phone reboot, which is what confirmed it's MDM-enforced rather than a
  regular VPN app or Samsung Secure Folder specifically) that takes routing
  priority over a plain Wi-Fi manual proxy setting. Not something to route
  around — it's the phone owner's employer's device policy, out of scope to
  defeat from this side entirely.
- **PCAPdroid's in-app decryption** (its own VPN-based MITM, independent of
  system proxy routing, so unaffected by the Always-On VPN above) — this is
  the one that actually reached the real question. CA confirmed trusted
  (Settings → Encryption & credentials → Trusted credentials → User),
  reinstalled to be sure, retried: **"broken pipe" during the TLS handshake**
  on the connection to the plausible endpoint. Not a trust-store failure (a
  clean TLS alert, like the earlier "does not trust the proxy's certificate"
  error, would look different) — an abrupt low-level socket close after the
  leaf certificate is presented is the signature of **certificate pinning**
  (e.g. OkHttp's `CertificatePinner` rejecting on pin mismatch), not a chain-
  of-trust problem. The Events module (and/or the "Thing-Network" native
  layer underneath it, §17.3) pins eufy's real certificate and rejects any
  MITM, trusted CA or not.

**Conclusion: getting the decrypted payload needs root**, specifically a
runtime hook (Frida) to patch the app's own pinning check — no amount of
CA-trust-store manipulation on a non-rooted device gets past pinning by
design. Rooting the actual household phone (a Samsung Galaxy S24 Ultra,
`SM-S928U` — the US carrier/unlocked variant, which has no official Samsung
OEM-unlock path at all) was evaluated and rejected: a real, permanent Knox
e-fuse trip (irreversible even after later unrooting/reflashing stock),
breaks Samsung Pay/Pass/Secure Folder and the household's work MDM
integration outright, and is a device-policy question for the owner's
employer independent of the technical risk. See §17.5 for the lower-risk
alternative this points to instead.

### 17.5 Deferred: a rooted emulator for the pinning bypass, not the real phone

Not attempted this session — recorded here as complete-enough context for a
future session to pick straight up, since the real-phone path is closed
(§17.4) but the underlying question (what does `Phase2_EventAPI` actually
request) is still open and this is the standard, low-risk way to answer it.

**Why an emulator sidesteps everything in §17.4:** a rootable Android
emulator (e.g. an Android Studio AVD using one of Google's own
`google_apis` — not `google_apis_playstore` — system images, which ship
rootable/writable by design) is fully disposable. Rooting it trips nothing
permanent, touches no Knox fuse, and is completely disconnected from the
household's actual phone or its MDM/work-VPN integration — that whole
category of risk just doesn't apply to a throwaway VM.

**What's needed, roughly in order:**

1. Android Studio (for the AVD manager + emulator) — not yet installed on
   this dev machine as of this writing.
2. Create an AVD on a `google_apis` (non-Play Store) system image — these
   ship with an unlocked/writable `/system`, so no separate bootloader-unlock
   step the way a real device needs. A recent API level matching the phone's
   real Android version is worth matching if the app has a `minSdk`/behavior
   split, otherwise the newest available `google_apis` image is simplest.
3. `adb push`/`adb install` the pulled APKs — already have `base.apk` +
   `split_config.arm64_v8a.apk` + `split_feature_asset_pack.apk` from this
   session, but the emulator is almost certainly x86_64, not arm64, so the
   `arm64_v8a` native-library split will not run there. Two options: install
   with `adb install-multiple` and let it fail closed on native libs (fine if
   the Events module itself is all RN/Hermes, no native code of its own,
   which §17.4's findings suggest); or use an x86_64-native APK variant if
   `pm path`/`bundletool` can produce one, or run the AVD with a
   arm64-translation-capable image (recent AVDs support this on newer Android
   Studio releases, at a performance cost).
4. **Untested, flag this as the first thing to verify:** the base APK's
   Ijiami protection (§17.4) commonly includes anti-emulator detection as
   part of its anti-tampering feature set. The app may simply refuse to start
   at all on an emulator, independent of root. Worth finding out early —
   before investing in Frida setup — whether the app even launches.
5. If it launches: install Frida server on the emulator (rootable AVDs
   support this cleanly, no exploit needed — just push the matching
   `frida-server` binary and run it), then use a standard SSL-unpinning
   script (`frida-trust` / `objection`'s built-in
   `android sslpinning disable`, or a hand-written Frida script targeting
   OkHttp's `CertificatePinner.check`) while capturing with mitmproxy exactly
   as set up in §17.4 — that infrastructure (installed, working, just
   defeated by pinning) is otherwise ready to reuse as-is.
6. Sign into the household's real eufy account inside the emulator to get a
   real, populated Events tab to refresh against — same account credentials
   already used by the bridge (`backend/.env`).
7. Once the decrypted `Phase2_EventAPI` request/response is captured, resume
   at the point §17.6 left off: confirm the path against
   `app-house-us-pr.eufy.com` and try it through the `mega_call` diagnostic
   primitive (§17.6) — that plumbing is already built and confirmed working,
   only the exact path string is still missing.

### 17.6 Empirical probing (same session, no root): confirmed the mechanism works, path still unknown

Tried in parallel with recording §17.5, without waiting for a rooted
emulator — going straight at `MegaHTTPApi`'s public surface with informed
guesses, on the theory that a wrong path just 404s cleanly (safe to try) and
a right one would settle this immediately.

**Confirmed reachable at runtime:** `EufySecurity`'s `megaTransition` field is
TypeScript `private` (`build/eufysecurity.d.ts`) but that is compile-time
only — erased in the actual compiled `.js`, where it is a plain
`this.megaTransition = new MegaTransition(...)` assignment, not a real JS
private field (`#megaTransition`). So `client.megaTransition.getMegaApi()`
is genuinely callable from `eufyBridge.js`, and it lazily reuses the
already-persisted v6 session — no second login, no second connection to the
account. Added as `EufyBridge.megaCall(service, path, payload)` →
`MegaHTTPApi.callDecrypted`, exposed over the control socket as a new
`mega_call` message type gated by `EUFY_DEBUG_MEGA_CALL=1` (off by default,
same pattern as `debugRawEvents`), with a small CLI (`eufy-bridge/mega-probe.js`)
to fire one-off calls at the *already-running* bridge without opening a
competing session. `megaApi.js` also confirms the service-name guess from
§17.3: `clusterHost(service)` builds `app-{service}-{region}-pr.eufy.com`,
so `app-house-us-pr.eufy.com` means the service really is `"house"`, and
`getUserMqttInfo()`'s own call (`callDecrypted("devicemanage",
"/app/devicemanage/get_user_mqtt_info", {})`) confirms the general path
shape: `/app/{service}/{snake_case_action}`.

**Guessed and got clean 404s from a real, correctly-authenticated endpoint**
(not an auth/signing error — confirming both the mechanism and the service
name are right) for: `get_event_list`, `refresh_event_data` (the direct
transform of the app's own `refreshEventData` function name — highest-
confidence guess, still wrong), `get_events`, `event_list`, `list_event`,
`query_event_list`, `get_house_event_list`, `house_event_list`.

**Went back to static analysis with the now-known `/app/{service}/{action}`
shape** to search for it directly rather than guessing further: re-pulled
just the Events module and grepped for the literal pattern `/app/[a-z_]+/[a-z_]+`
across it and seven more likely bundles (`RN_ANDROID_ZX_EVENT_TAB`,
`RN_ANDROID_ZX_EVENT`, `RN_ANDROID_ZX_T8030`, `RN_ANDROID_zx-rnsdk` — the
shared-SDK-shaped one, `RN_ANDROID_ZX_GLOBAL`, `RN_ANDROID_MEGA_PLAYER`,
`RN_ANDROID_ZX_AI`, `RN_ANDROID_SEC_SETTING`). Found plenty of *other* real
`/app/{service}/{action}` paths this way (`/app/nvr/get_dictionary`,
`/app/device/relate_list`, `/app/equipment/get_white_list`, a couple dozen
more) — confirming the pattern and the extraction technique both work — but
**zero matches anywhere for `/app/house/*`**. `RN_ANDROID_ZX_EVENT_TAB`
itself (the Events tab module, confirmed correct via matching log-message
strings, §17.4) has *no* `/app/` literals in it at all. Conclusion: this
specific call is not made from the RN/JS layer — it is almost certainly
issued from native (Java/Kotlin, or the "Thing-Network" native layer seen in
logcat, §17.3) code, with the JS side only invoking a native bridge method.
That is very likely inside the Ijiami-protected base APK (§17.4), which is a
meaningfully bigger reverse-engineering undertaking than reading a JS
bundle — realistically in the same effort tier as the rooted-emulator path
in §17.5, not a shortcut around it.

**Net result:** the `mega_call` infrastructure and probing technique are
solid and reusable (confirmed against a real endpoint, not simulated), but
this session did not land on the actual path. Whoever picks this up next
should not keep blind-guessing snake_case variations — the productive next
step is §17.5's decrypted capture (which would just *answer* this) or a
proper look at the native app code, not more guesses.

### 17.7 Open items for next time

- Revisit §16.5's original packet-capture suggestion now that we know *why*
  it's worth doing: not just "does anything arrive" (answered — yes, and
  §17.1 fixed the local handler for it) but "what does the one HTTP call that
  actually works look like" (still open, blocked on §17.4/§17.5).
