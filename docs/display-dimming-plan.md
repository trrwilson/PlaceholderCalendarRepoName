---
status: future
summary: Backend-driven idle dimming of the physical panel (dim, not off) between interactions. Stage 1 (colocation seam + WMI/DDC-CI brightness + night mode) is built, plus a basic presence-driven slice of the inactivity policy itself (see "Implemented so far").
---

# Mission Control: idle display dimming — design plan

Dim the wall panel — **not** turn it off — after a short period with no
interaction, and restore full brightness the instant someone touches, speaks, or
a timer fires. A browser tab cannot set Windows display brightness (no Web API;
Screen Wake Lock only *prevents* dimming), so the real-brightness path runs in
the backend, which the deployment topology already places on the same host as the
kiosk. A perceptual overlay in the frontend is the fallback where the backend
does not own the panel.

This is deliberately the *dim* half of display power. Full **standby / sleep** is
owned by [camera-support-plan.md](camera-support-plan.md); this plan shares its
`DisplayController`, inactivity-policy, and activity-seam design and adds one
level below `awake`. See [§ Relationship](#relationship-to-presence-work).

This document is the design target. **Stage 1 is built**, and a basic slice of
the inactivity policy now exists too, driven by presence signals — camera
motion, plus touch and voice activity pulses (`POST /api/presence/activity`,
throttled client-side) — rather than this plan's own separate policy; see
[§ Implemented so far](#implemented-so-far). The *fuller* inactivity policy
(an active timer as a keep-awake vote), the `gamma` / `overlay` mechanisms,
the `asleep` level, and the Settings diagnostics block are still not built.

---

## Decisions locked in

| Question | Decision |
| --- | --- |
| What "dim" means | An intermediate display level between `awake` and `asleep`. The panel backlight (or a perceptual overlay) drops to a configurable target; the UI is untouched and stays legible. Never a lock — a dimmed panel still takes touch normally. |
| Where the policy lives | **Backend**, always — it already has to arbitrate keep-awake votes (active timer today; camera presence later). A pure state machine with an injected clock (house style — cf. `MockCalendarProvider.today`, the privacy grace clock). It runs whether or not the backend owns the panel. |
| Real brightness vs. overlay | When the backend owns the attached panel (`MISSION_CONTROL_HOST_LOCAL_DISPLAY=true`) it drives hardware brightness. Otherwise it publishes the target level only and the kiosk renders a black overlay to match. One policy, two effectors — never both at once. |
| Colocation is explicit | A single config assertion, `MISSION_CONTROL_HOST_LOCAL_DISPLAY`, replaces the "documented prerequisite" prose. Every OS / device-API call is inert unless it is `true`. `camera-support-plan.md`'s `SC_MONITORPOWER` sleep path gates on the same flag. |
| Device mechanism | Not pre-decided per install. Probe at startup, pick the first that verifiably moves the panel, record it for diagnostics. `DisplayController` stays dumb (`set_level()` / `status()`); "don't re-issue an identical command" lives in the policy. |
| Wake latency | An activity pulse restores `awake` synchronously on the next policy tick; target < 200 ms panel response. On backend shutdown or controller teardown the panel is **always** restored to full brightness. |
| Fail-safe | Any mechanism error ⇒ treat the panel as `awake` and surface it in diagnostics. A dimming feature must never be able to leave the wall dark or stuck dim. |
| Feature default | Off. `MISSION_CONTROL_DISPLAY_DIM_ENABLED=false`. |

---

## Backend ↔ device integration

`DisplayController` (behind a seam, one no-op default for dev/CI):

```
DisplayController
  probe()            -> records the live mechanism + whether it verifiably works
  set_level(level)   -> level in {awake, dim, asleep}; asleep delegated to the
                        presence-work sleep path, no-op here until that ships
  status()           -> mechanism, current level, availability, last error
```

Mechanisms, tried in this order under `MISSION_CONTROL_DISPLAY_CONTROL_MECHANISM=auto`:

| Mechanism | Call | Works on | Notes |
| --- | --- | --- | --- |
| `wmi` | `WmiMonitorBrightnessMethods.WmiSetBrightness()` (`root\wmi`) | Integrated / laptop panels, some AIOs | The OS brightness slider. **Unlikely** on an external 4K wall panel — probe confirms. |
| `ddcci` | `dxva2.dll` `GetPhysicalMonitorsFromHMONITOR` → `SetVCPFeature(h, 0x10, v)` (VCP `0x10` = luminance) | External monitors that honour DDC/CI | Same panel class the presence plan flags as unreliable for VCP `0xD6`; if `0xD6` power works, `0x10` brightness likely does too. |
| `gamma` | `gdi32` `SetDeviceGammaRamp` | Any GPU output | Software dim (like f.lux) — reversible, monitor-independent, **backlight stays lit** (no power saving). Needs `HKLM\...\ICM\GdiIccGammaRange=1` on Win10+. Opt-in only (`auto` never selects it — it darkens the whole GPU output). |
| `overlay` | none — publish target only | Always | The kiosk paints the dim. The only mechanism when not colocated. |
| `none` | no-op | Always | Dev / CI. |

Bindings via `ctypes` against `dxva2.dll` / `gdi32.dll` / a `powershell` shell-out
for WMI — no new runtime dependency. An optional `[display]` extra can pull
`comtypes` / `wmi` if the shell-out proves flaky. Twinkle Tray / Monitorian are
the reference implementations of `wmi` + `ddcci`.

The camera is opened once in lifespan startup in the presence plan; the display
controller is cheap and stateless — construct it in lifespan startup when
`HOST_LOCAL_DISPLAY` is set, probe once, log the chosen mechanism.

---

## Frontend ↔ backend API

- **`GET /api/display`** — `DisplayConfig` (effective settings) + live
  `DisplayState`: `level`, `overlay_opacity` (0 when hardware is doing the work),
  `mechanism`, `colocated`, `dim_after_seconds`, `last_activity` per source,
  controller availability, last error. Polled like `/api/calendar/auth` and the
  presence plan's `/api/presence`; drives a read-only Settings → Advanced
  diagnostics block (never raw error strings on the wall — `frontend/AGENTS.md`).
- **`DisplayState` on the `/api/ws` hello**, and pushed via a new
  `ApplicationMessage.display` on every level change — a small typed extension of
  the existing envelope, not a second socket (`backend/AGENTS.md` → Real-time).
- **`POST /api/presence/activity {source}`** — a discrete activity pulse,
  `source ∈ {touch, voice, wake_word, camera}`. Throttled client-side to ~1 per
  10 s plus a periodic heartbeat. `_require_local`-gated; **deliberately not
  `_require_unlocked`** — a touch while privacy mode is locked must still wake the
  panel (documented DoD exception, like the `fired`-timer delete). This is the
  shared seam the presence plan also needs; whichever ships first builds it.
- **`PUT /api/display/config`** *(optional)* — process-memory runtime override of
  `dim_after_seconds` / `dim_level` / enabled, reverting on restart, mirroring
  `PUT /api/voice/wake-config`. Lets Settings tune it without a redeploy.

Frontend work:

- **Activity pings** — **implemented (2026-09-11)**: `frontend/src/presence/useActivityPing.ts`
  posts on `pointerdown` anywhere in the shell, throttled to ~1 per 10 s
  client-side; plain `POST`, not the WS. Voice turns are already covered
  server-side (`note_activity(ActivitySource.voice)` at token grant / relay
  start — see `app/api.py`), so no separate frontend ping is needed there.
  Not yet wired: `useVoiceSession`'s listening/thinking/speaking states as a
  *sustained* keep-awake vote (today a turn only resets the countdown at its
  start) and `hasActiveTimer`.
- **Overlay dimmer** — one fixed full-viewport `<div>`, `pointer-events: none`,
  `aria-hidden`, opacity = `DisplayState.overlay_opacity`, ~600 ms CSS transition.
  Applied only when `overlay_opacity > 0` (i.e. mechanism `overlay`), so hardware
  and overlay never double-dim.
- The first touch on a dimmed panel wakes it **and** is still delivered to the UI
  (dim is not a lock). *Open question:* whether a wall calendar wants the
  phone-style "first tap only wakes" instead — defer to kiosk testing.

---

## Inactivity policy

Pure state machine, injected `now`. Inputs: activity pulses (above) and
keep-awake votes. Rules:

- `dim` only when the feature is enabled, no keep-awake vote is active, and
  `now − last_activity > display_dim_after_seconds`.
- **An active timer is a keep-awake vote** — never dim while a timer is `running`
  or `fired` (consistent with `docs/timer-plan.md` → "Physical display stays
  awake" and the existing `navigator.wakeLock`).
- Any activity pulse ⇒ `awake` immediately.
- Never issue an identical `set_level` twice in a row.
- `asleep` transitions are out of scope here (presence plan owns the longer
  threshold and the camera "present" vote).

---

## Configuration

| Variable | Default | Meaning |
| --- | --- | --- |
| `MISSION_CONTROL_HOST_LOCAL_DISPLAY` | `false` | Formal assertion that this backend runs on the same host as the kiosk browser and owns the physically attached panel. Gates every OS / device-API display call (this plan and the presence-plan sleep path). |
| `MISSION_CONTROL_DISPLAY_DIM_ENABLED` | **`true`** (implemented) | Master switch for idle dimming. This doc originally specced `false`; the *basic* slice actually built (below) defaults on, matching `presence_enabled`'s same on-by-default posture this session. |
| `MISSION_CONTROL_DISPLAY_DIM_AFTER_SECONDS` | **`20`** (implemented) | Idle time before the panel dims. Originally specced `90`; shipped at `10`, then raised to `20` (2026-09-11) once touch/voice activity pulses were wired in — a fuse that short otherwise dims mid-interaction. |
| `MISSION_CONTROL_DISPLAY_DIM_LEVEL` | **`0`** (implemented) | Target while dimmed. Originally specced `35` (+ overlay-opacity mapping, not built); the basic slice is hardware-brightness only, default `0`. |
| `MISSION_CONTROL_DISPLAY_DIM_RESTORE_LEVEL` | **`60`** (implemented, new — not in the original design) | Target a presence signal restores to, *unless* night mode is on (its own level wins then). The original design restored to "whatever the panel was showing before dimming"; the basic slice uses a fixed level instead — see "Implemented so far". |
| `MISSION_CONTROL_DISPLAY_CONTROL_MECHANISM` | `auto` | `auto` \| `wmi` \| `ddcci` \| `gamma` \| `overlay` \| `none`. `auto` probes `wmi` → `ddcci` → `overlay`; `gamma` is opt-in only. |

Config is read through an accessor (the future runtime-store hook), shaped so a
writable store can shadow env later — same posture as `PresenceSettings`.

---

## Phases

1. **No hardware.** `DisplayController` seam (`overlay` + `none` only), inactivity
   policy (pure, fake clock), `POST /api/presence/activity`, config. Unit tests.
2. **Wire-up.** `GET /api/display`, `ApplicationMessage.display` push, frontend
   activity pings + overlay dimmer + Settings diagnostics block.
3. **Hardware.** `wmi` / `ddcci` mechanisms behind `HOST_LOCAL_DISPLAY`,
   `ctypes` bindings, startup probe, restore-to-full on teardown. **Done** for
   night mode (stage 1); `gamma` and the inactivity policy that drives them are
   still open.
4. **On the kiosk.** Probe which mechanism moves the real panel, tune
   `dim_after` / `dim_level`, measure wake latency, check whether digitizer HID
   jitter spuriously counts as activity, write the deployment notes.

---

## Implemented so far

Stage 1 (the foundations + a human-facing test), shipped:

- **Colocation seam.** `MISSION_CONTROL_HOST_LOCAL_DISPLAY` (default `false`) is
  the single structural assertion; `app/host.py` + `HostCapabilities` +
  `GET /api/capabilities` report it. Every OS/device call gates on it. The
  presence-plan sleep path is expected to consume the same seam.
- **`DisplayController`** (`app/display.py`) — `NullDisplayController` (`none`,
  dev/CI/not-colocated), `WmiDisplayController` (`wmi`, a PowerShell shell-out to
  `WmiMonitorBrightnessMethods.WmiSetBrightness`) and `DdcCiDisplayController`
  (`ddcci`, `ctypes` against `dxva2.dll` `GetMonitorBrightness` /
  `SetMonitorBrightness` — VCP `0x10`, all attached DDC/CI monitors moved
  together, the 0-100 percentage scaled into each panel's native range). Both
  Windows only, no new dependency.
  `MISSION_CONTROL_DISPLAY_CONTROL_MECHANISM = auto|wmi|ddcci|none`; `auto` is a
  `FallbackDisplayController` that probes `wmi` → `ddcci` when colocated and
  adopts the first that verifiably reads the panel. Probe failure ⇒ mechanism
  reported as `none`, collected per-mechanism errors in `DisplayState.last_error`.
- **`DisplayStore`** — same mould as `TimerStore` / `PrivacyStore` (injected
  clock + broadcast, no socket import, process singleton). Holds `brightness`,
  `reference_brightness`, `night_mode`; "never re-issue an identical level";
  restore-to-reference on lifespan shutdown.
- **API** — `GET /api/display`, `PUT /api/display {brightness?, night_mode?}`
  (`_require_local` + `_require_unlocked`), `DisplayState` on the `/api/ws` hello
  and pushed as `ApplicationMessage.display` on every change.
- **Night mode** — `set_night_mode` voice tool (cloud providers; the Local/Hybrid
  pipeline still answers "can't control the display yet") and a Settings → Display
  toggle. On captures the current level as the reference and drops to
  `MISSION_CONTROL_DISPLAY_NIGHT_MODE_LEVEL_PCT` (default 10) % of it; off
  restores exactly that reference.
- Frontend `useDisplay` hook (`frontend/src/display/`) reconciles like
  `usePrivacy`. No perceptual overlay yet — stage 1 assumes a colocated host that
  owns the panel (`wmi` or `ddcci`).

**Basic presence-driven idle dimming (2026-09-10), backend-only — no frontend
change.** A smaller, more direct version of the "Inactivity policy" section
above, built ahead of the fuller design:

- **`PresenceDisplayPolicy`** (`app/presence/display_policy.py`) dims the panel
  after `display_dim_after_seconds` with no *kiosk-scope presence signal at
  all* — camera motion, or (as of 2026-09-11, see below) a touch/voice
  activity pulse; a timer keep-awake vote still isn't wired. It subscribes to
  `PresenceAggregator`'s new `on_signal` hook (fires on every `observe()` call,
  unlike `on_change` which only fires on a `present` transition) — necessary
  because this MVP's local-camera `motion` signals never flip `present` (see
  `camera-support-plan.md`) and so would never reach a transition-only
  subscriber.
- **`DisplayStore.set_ambient_brightness()`** — a new low-level primitive
  alongside `set_brightness()` (the explicit-user-choice path, which
  deliberately *leaves* night mode) and `set_night_mode()`. It sets an explicit
  level without touching `night_mode` or `reference_brightness`, so the
  presence policy's automatic dim/restore cycle is layered *underneath*
  whatever standing choice (night mode or not) is in effect, rather than
  clobbering it. `DisplayStore.night_level()` is the matching read: what night
  mode is currently targeting, independent of whatever the panel is showing
  this instant.
- **Night mode dynamically replaces the restore target**: `_restore()` uses
  `night_level()` instead of the fixed `display_dim_restore_level` whenever
  `night_mode` is on — a household that dimmed the panel for the evening does
  not get jolted back to full brightness by someone walking past.
- **Cross-thread bridging**: `PresenceAggregator.observe()` runs on the
  camera's background thread or a sync FastAPI request-handler thread — neither
  has a running event loop — so `on_signal` hands off via
  `loop.call_soon_threadsafe`, the same pattern `app/voice/wake_azure.py` uses
  for its own SDK-callback thread. `app/presence.bind_event_loop()` captures
  the loop once at lifespan startup.
- **Not built**: a timer-activity pulse or active-timer keep-awake vote,
  restoring to "whatever it was" instead of a fixed level, the
  `overlay`/perceptual-dim fallback, and any Settings-visible diagnostics for
  it (state is only observable via `GET /api/display`'s `brightness` field and
  this policy's own console logs).
- **Tests**: `backend/tests/test_display_policy.py` (the policy in isolation,
  injected short timeouts) and one end-to-end test in
  `backend/tests/test_presence.py` exercising the real lifespan wiring.

**Touch activity pulse + tighter camera latency (2026-09-11).** Two follow-on
changes, both aimed at making the idle-dim/restore cycle track actual kiosk
use more closely:

- **`useActivityPing`** (`frontend/src/presence/useActivityPing.ts`) posts
  `POST /api/presence/activity {source: "touch"}` on any `pointerdown`,
  throttled to ~1 per 10 s — the frontend half of the activity seam this doc
  and `camera-support-plan.md` both left unbuilt. `display_dim_after_seconds`
  moved `10 → 20` at the same time: a 10 s fuse dims mid-interaction between
  two throttled pings.
- **`presence_inference_interval_ms` moved `750 → 150`** (`app/config.py`) —
  the local-camera motion detector now samples a frame every 150 ms instead of
  750 ms, cutting the worst-case delay between someone entering frame and the
  panel restoring by up to 600 ms. MOG2 over the already-downscaled 320×240
  analysis frame is cheap enough that 5x the sampling rate is not a measurable
  CPU concern. This does not touch the detector algorithm itself, only its
  cadence.

---

## Testing

Mirror `backend/tests/` style — pure policy + fakes, no real monitor:

- idle past the threshold dims; an activity pulse restores `awake`
- an active timer prevents dimming; clearing it lets the threshold apply
- no redundant identical `set_level` calls
- controller teardown / shutdown restores full brightness
- mechanism probe falls back (`wmi` unavailable → `ddcci` → `overlay`)
- `overlay_opacity` maths from `dim_level`
- `POST /api/presence/activity` throttle + `_require_local`, and that it is
  **not** blocked while privacy-locked
- `DisplayState` pushed on change, present on the WS hello

A diagnostic mode = real policy + `none` controller + verbose `/api/display`,
which is also the CI configuration. The policy must never auto-start under pytest.

---

## Relationship to presence work

[camera-support-plan.md](camera-support-plan.md) already specifies
`DisplayController`, the inactivity policy, and the activity seam for **sleep**.
These are the same components. The activity seam itself (`POST
/api/presence/activity`, `note_activity`) is the `kiosk`-scope instance of the
general contract in [presence-module-plan.md](presence-module-plan.md) — no
change to what's built or planned here, just the shared name for it. Convergence:

- `DisplayController.set_level()` takes `{awake, dim, asleep}`. This plan
  implements `awake ↔ dim`; the presence plan adds `asleep` and the camera
  "present" keep-awake vote.
- One inactivity policy, two thresholds: `display_dim_after_seconds` (here) and
  the presence plan's longer inactivity timeout.
- One activity seam / `POST /api/presence/activity`. Whichever plan is built
  first lands the shared parts; the second extends them.
- `MISSION_CONTROL_HOST_LOCAL_DISPLAY` is introduced here and consumed by both.

---

## Non-goals

Display standby / sleep (presence plan). Presence or person detection. Colour
temperature / night-shift / HDR. Multiple displays. Per-viewer persistence of dim
settings. Host suspend / hibernate. Any attempt to set brightness from the
browser itself.
