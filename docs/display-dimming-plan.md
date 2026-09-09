---
status: future
summary: Backend-driven idle dimming of the physical panel (dim, not off) between interactions.
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

Not built. This document is the design target.

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

- **Activity pings** — a small `useActivityPing` hook: `pointerdown` / `touchstart`
  on the shell, `useVoiceSession` active states (`listening` / `thinking` /
  `speaking`), and `hasActiveTimer`. Throttled; plain `POST`, not the WS.
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
| `MISSION_CONTROL_DISPLAY_DIM_ENABLED` | `false` | Master switch for idle dimming. |
| `MISSION_CONTROL_DISPLAY_DIM_AFTER_SECONDS` | `90` | Idle time before the panel dims. |
| `MISSION_CONTROL_DISPLAY_DIM_LEVEL` | `35` | Target while dimmed: 0–100 for hardware brightness; mapped to overlay opacity (`1 − level/100`, clamped) for the `overlay` mechanism. |
| `MISSION_CONTROL_DISPLAY_CONTROL_MECHANISM` | `auto` | `auto` \| `wmi` \| `ddcci` \| `gamma` \| `overlay` \| `none`. `auto` probes `wmi` → `ddcci` → `overlay`; `gamma` is opt-in only. |

Config is read through an accessor (the future runtime-store hook), shaped so a
writable store can shadow env later — same posture as `PresenceSettings`.

---

## Phases

1. **No hardware.** `DisplayController` seam (`overlay` + `none` only), inactivity
   policy (pure, fake clock), `POST /api/presence/activity`, config. Unit tests.
2. **Wire-up.** `GET /api/display`, `ApplicationMessage.display` push, frontend
   activity pings + overlay dimmer + Settings diagnostics block.
3. **Hardware.** `wmi` / `ddcci` / `gamma` mechanisms behind
   `HOST_LOCAL_DISPLAY`, `ctypes` bindings, startup probe, restore-to-full on
   teardown.
4. **On the kiosk.** Probe which mechanism moves the real panel, tune
   `dim_after` / `dim_level`, measure wake latency, check whether digitizer HID
   jitter spuriously counts as activity, write the deployment notes.

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
These are the same components. Convergence:

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
