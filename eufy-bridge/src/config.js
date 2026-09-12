"use strict";

const path = require("node:path");

// Config from environment variables only — the backend (app/eufy/bridge_process.py)
// spawns this process and passes credentials as env, never argv (argv is visible to
// any other process via `ps` / Task Manager). See docs/eufy-sdk-integration.md §6.1.

function requireEnv(name) {
  const value = process.env[name];
  if (!value) throw new Error(`missing required environment variable ${name}`);
  return value;
}

function intEnv(name, fallback) {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number.parseInt(raw, 10);
  if (!Number.isFinite(value)) throw new Error(`${name} must be an integer, got ${raw}`);
  return value;
}

// Node's setTimeout silently clamps any delay over ~2^31-1 ms (~35,791 minutes)
// instead of throwing, and eufy-security-client's own cloud-refresh housekeeping
// reschedules itself on that same broken timer — a value meant as "basically
// never" fires almost immediately, repeatedly. This bit a real household during
// verification (~356 extra authenticated cloud calls in under two minutes; see
// docs/eufy-sdk-integration.md §5.6.1). The Python side validates this too
// (app/config.py's own field_validator) — this is defence in depth, since this
// process is the one that actually feeds the value to the timer.
const MAX_POLLING_INTERVAL_MINUTES = 44640; // 31 days

function loadConfig() {
  const pollingIntervalMinutes = intEnv("EUFY_POLLING_INTERVAL_MINUTES", 1440);
  if (pollingIntervalMinutes < 1 || pollingIntervalMinutes > MAX_POLLING_INTERVAL_MINUTES) {
    throw new Error(
      `EUFY_POLLING_INTERVAL_MINUTES must be between 1 and ${MAX_POLLING_INTERVAL_MINUTES}, got ${pollingIntervalMinutes}`
    );
  }

  const cameraNames = {};
  for (const pair of (process.env.EUFY_CAMERA_NAMES || "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq > 0) {
      const serial = pair.slice(0, eq).trim();
      const name = pair.slice(eq + 1).trim();
      if (serial && name) cameraNames[serial] = name;
    }
  }

  const sessionFile = requireEnv("EUFY_SESSION_FILE");

  return {
    email: requireEnv("EUFY_EMAIL"),
    password: requireEnv("EUFY_PASSWORD"),
    region: process.env.EUFY_REGION || "US",
    sessionFile,
    stationLanIp: process.env.EUFY_STATION_LAN_IP || undefined,
    stationSerial: process.env.EUFY_STATION_SERIAL || undefined,
    cameraNames,
    host: process.env.EUFY_HOST || "127.0.0.1",
    port: intEnv("EUFY_PORT", 3011),
    pollingIntervalMinutes,
    reconcileIntervalSeconds: intEnv("EUFY_RECONCILE_INTERVAL_SECONDS", 120),
    reconcileLookbackMinutes: intEnv("EUFY_RECONCILE_LOOKBACK_MINUTES", 10),
    clipCacheDir: requireEnv("EUFY_CLIP_CACHE_DIR"),
    clipCacheTtlSeconds: intEnv("EUFY_CLIP_CACHE_TTL_SECONDS", 600),
    // Diagnostic-only, off by default: logs every event the SDK client emits
    // (not just the ones this bridge has a handler for) and turns on the
    // SDK's own trace/debug logging. For chasing the real-hardware push/
    // reconcile correlation problem in docs/eufy-sdk-integration.md §16.2-16.4
    // — `DEVICE_EVENT_NAMES` was verified only against the SDK's type
    // definitions, never real firmware, so a wildcard listener is the only
    // way to catch an event under a name nobody guessed. Never enable this
    // for normal operation — it is verbose and not meant to run continuously.
    debugRawEvents: process.env.EUFY_DEBUG_RAW_EVENTS === "1",
    // Diagnostic-only, off by default: exposes the "mega_call" control
    // message (EufyBridge.megaCall -> MegaHTTPApi.callDecrypted) for probing
    // the undocumented v6 "mega" event-history endpoint — see
    // docs/eufy-sdk-integration.md §17. A materially more powerful surface
    // than debugRawEvents (an authenticated write-capable-shaped call
    // primitive, not passive logging), so it gets its own flag rather than
    // riding along with that one.
    debugMegaCall: process.env.EUFY_DEBUG_MEGA_CALL === "1",
    // Off by default: periodic P2P enumeration of `history_record_info` via a
    // second SDK (@mega-yfue/eufy-sdk), feeding the same clip-discovery
    // pipeline as the eufy-security-client `databaseQueryByDate` reconcile.
    // Exists to work around that reconcile's documented freshness bug (a
    // date-range query returns a stale cluster at the oldest edge of the
    // window instead of the most recent events — docs/eufy-sdk-integration.md
    // §16.2/§19.2) with a FULL_TABLE query that this investigation confirmed
    // does not exhibit it (§19.1). Requires EUFY_STATION_SERIAL to be set —
    // logs a warning and stays a no-op without it, same as the LAN-IP hint.
    megaEnumerationEnabled: process.env.EUFY_MEGA_ENUMERATION_ENABLED === "1",
    // Separate persisted session file — a different SDK, a different
    // persistence format, never shared with EUFY_SESSION_FILE above.
    megaSessionFile:
      process.env.EUFY_MEGA_SESSION_FILE || path.join(path.dirname(sessionFile), ".eufy_mega_persistent.json"),
    // How long to wait for a dbChunk reply per poll before giving up on that
    // pass. §19.1's live testing saw a reply within ~1-2s; this leaves
    // generous headroom without blocking the shared reconcile cadence badly.
    megaQueryWindowMs: intEnv("EUFY_MEGA_QUERY_WINDOW_MS", 8000),
    // How long to wait after opening the mega-yfue P2P session before
    // assuming it's up and sending the query — mirrors the same pitfall
    // §5.1 documents for the primary SDK (local P2P discovery can silently
    // stall). Exposed as config (not a hardcoded constant) mainly so tests
    // can shrink it; production should rarely need to change it.
    megaP2pWarmupMs: intEnv("EUFY_MEGA_P2P_WARMUP_MS", 4000),
  };
}

module.exports = { loadConfig, MAX_POLLING_INTERVAL_MINUTES };
