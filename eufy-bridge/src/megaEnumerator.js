"use strict";

// Periodic P2P enumeration of the station's `history_record_info` table via
// @mega-yfue/eufy-sdk's low-level `P2PSession.queryDatabase()`, feeding
// results into the SAME clip-discovery pipeline the eufy-security-client
// `databaseQueryByDate()` reconcile already uses (record field names match —
// see docs/eufy-sdk-integration.md section 19). Exists because that reconcile call
// has a real, reproducible bug (section 16.2/19.2: a date-range query returns a
// stale cluster at the OLDEST edge of the requested window, not the most
// recent events) that a FULL_TABLE query (no date bounds at all) does not
// exhibit in this investigation's testing.
//
// A completely separate SDK and P2P session from the one `EufyBridge`
// otherwise drives — but the SAME account credentials (section 19: the fix is the
// account_id read off the device's own `member.admin_user_id`, not a
// different account or a login-side change) and a distinct session-store
// file, since the two SDKs use unrelated persistence formats.
//
// The root cause of the original "-104" failure (docs section 18.2): `accountId`
// must be the STATION's own `member.admin_user_id`, never the logged-in
// account's `userId` — the two differ even under the real account owner
// (section 19.1). This module always re-reads it from the device's own record
// rather than caching or assuming it.

const FULL_TABLE_QUERY = {
  count: 2000,
  start_date: "",
  end_date: "",
  start_id: 0,
  end_id: 1,
  flag: 0,
  need_ai: 1,
  res_unzip: 1,
  update_time: "0",
  start_time: "0",
  alarm_id: "",
};

const DEFAULT_QUERY_WINDOW_MS = 8_000;
const DEFAULT_P2P_WARMUP_MS = 4_000;

/**
 * The decrypted dbChunk text can carry trailing bytes past the last 16-byte
 * AES block boundary that were never decrypted at all (the SDK's own
 * `p2p-session.ts` comment: CMD_DATABASE reply chunks "are NOT 16-aligned...
 * a trailing byte past the block boundary" is decrypted only up to the
 * aligned head). Those bytes are leftover ciphertext, not a fixed padding
 * character — sometimes they happen to decode as clean NUL, sometimes as
 * other non-JSON noise (confirmed live: a production poll hit
 * `Unexpected non-whitespace character after JSON at position 5957` because
 * this investigation's own earlier NUL-only stripping assumed the padding
 * was always zero bytes). Rather than guess at what the garbage looks like,
 * scan for the end of the first complete top-level JSON value (respecting
 * string literals/escapes) and ignore everything after it.
 */
function extractLeadingJson(text) {
  let depth = 0;
  let started = false;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
      continue;
    }
    if (ch === "{" || ch === "[") {
      depth += 1;
      started = true;
    } else if (ch === "}" || ch === "]") {
      depth -= 1;
      if (started && depth === 0) return text.slice(0, i + 1);
    }
  }
  return text; // no balanced close found -- let JSON.parse report the real error
}

/**
 * "2026-09-11 16:11:04" + "-0700" -> a real Date, using the record's OWN
 * reported timezone rather than assuming the bridge host's local time (the
 * two are not necessarily the same, and `history_record_info` records
 * report their own `time_zone` for exactly this reason).
 */
function parseStationTimestamp(dateStr, tzOffset) {
  if (!dateStr) return new Date(NaN);
  const iso = String(dateStr).trim().replace(" ", "T");
  const offset =
    typeof tzOffset === "string" && /^[+-]\d{4}$/.test(tzOffset)
      ? `${tzOffset.slice(0, 3)}:${tzOffset.slice(3)}`
      : "Z";
  return new Date(`${iso}${offset}`);
}

/** Map a raw `history_record_info` row to the same shape `databaseQueryByDate()`
 * emits, so it can be handed straight to `EufyBridge._onDatabaseQueryByDate()`
 * with no separate code path. */
function toDatabaseQueryByDateShape(record) {
  return {
    device_sn: record.device_sn,
    station_sn: record.station_sn,
    record_id: record.record_id,
    start_time: parseStationTimestamp(record.start_time, record.time_zone),
    storage_path: record.storage_path,
    thumb_path: record.thumb_path,
    cipher_id: record.cipher_id,
    frame_num: record.frame_num,
  };
}

class MegaEnumerator {
  /**
   * `createClient` is an injectable seam over `@mega-yfue/eufy-sdk`'s
   * `EufyMega` + `FileSessionStore`, matching `EufyBridge`'s own
   * `initializeClient` seam — tests hand this a stubbed client instead of
   * the real SDK, no network, no hardware.
   */
  constructor({ email, password, region, sessionFile, stationSerial, log, queryWindowMs, p2pWarmupMs, createClient }) {
    this.email = email;
    this.password = password;
    this.region = region;
    this.sessionFile = sessionFile;
    this.stationSerial = stationSerial;
    this.log = log || (() => {});
    this.queryWindowMs = queryWindowMs || DEFAULT_QUERY_WINDOW_MS;
    this.p2pWarmupMs = p2pWarmupMs ?? DEFAULT_P2P_WARMUP_MS;
    this._createClient = createClient || (() => this._createRealClient());
  }

  _createRealClient() {
    // eslint-disable-next-line global-require -- lazy: only loaded when this feature is on.
    const { EufyMega, FileSessionStore } = require("@mega-yfue/eufy-sdk");
    return new EufyMega({
      email: this.email,
      password: this.password,
      countryCode: this.region,
      store: new FileSessionStore(this.sessionFile),
    });
  }

  /**
   * One enumeration pass: login (reuses the persisted session on a healthy
   * run — no fresh password round trip), find the configured station,
   * resolve its real `admin_user_id`, send one `history_record_info`
   * FULL_TABLE query, collect whatever `dbChunk`s arrive within
   * `queryWindowMs`, disconnect. Never throws — a failed pass just yields no
   * records, matching this feature's "additive, never blocks the working
   * reconcile path" design (this bridge's core `databaseQueryByDate` path is
   * untouched by this module either way).
   *
   * A fresh client per call rather than one kept alive across polls: this
   * investigation's single-shot testing never ran two queries on one P2P
   * connection without the station apparently ending the session after the
   * first (docs section 18.3/18.6) — "one query per connection" is the only
   * pattern confirmed safe so far. Revisit (docs section 19.4 item 6) before
   * trying to keep this session open across polls.
   */
  async poll() {
    if (!this.stationSerial) {
      this.log("mega-enumerator: no station serial configured -- skipping");
      return [];
    }
    let client;
    try {
      client = this._createClient();
    } catch (err) {
      this.log(`mega-enumerator: could not create client: ${err && err.message}`);
      return [];
    }

    try {
      // eslint-disable-next-line global-require -- lazy, mirrors _createRealClient above.
      const { LoginStatus } = require("@mega-yfue/eufy-sdk");
      const result = await client.login();
      if (result.status !== LoginStatus.Ok) {
        this.log(`mega-enumerator: login not OK (status=${result.status}) -- skipping this pass`);
        return [];
      }

      const devices = await client.getDevices();
      const station = devices.find((d) => d.sn === this.stationSerial);
      if (!station) {
        this.log(`mega-enumerator: station ${this.stationSerial} not in device list -- skipping`);
        return [];
      }
      const member = (station.raw || {}).member || {};
      const accountId =
        typeof member.admin_user_id === "string" && member.admin_user_id
          ? member.admin_user_id
          : result.session?.userId || "";

      await client.getDevice(station.sn).catch(() => {});
      await new Promise((resolve) => setTimeout(resolve, this.p2pWarmupMs));
      const session = client.getP2pSessions().get(station.sn);
      if (!session) {
        this.log(`mega-enumerator: no P2P session opened for ${station.sn} -- skipping`);
        return [];
      }

      const chunks = [];
      const onChunk = (payload) => chunks.push(payload.text);
      session.on("dbChunk", onChunk);
      session.queryDatabase("history_record_info", {
        accountId,
        channel: 255,
        query: FULL_TABLE_QUERY,
      });
      await new Promise((resolve) => setTimeout(resolve, this.queryWindowMs));
      session.off("dbChunk", onChunk);

      if (chunks.length === 0) {
        this.log("mega-enumerator: no dbChunk reply within the query window");
        return [];
      }
      let parsed;
      try {
        parsed = JSON.parse(extractLeadingJson(chunks.join("")));
      } catch (err) {
        this.log(`mega-enumerator: failed to parse dbChunk reply: ${err.message}`);
        return [];
      }
      const records = Array.isArray(parsed.data) ? parsed.data : [];
      this.log(`mega-enumerator: ${records.length} record(s) from history_record_info FULL_TABLE`);
      return records.map(toDatabaseQueryByDateShape);
    } catch (err) {
      this.log(`mega-enumerator: poll failed: ${err && err.stack}`);
      return [];
    } finally {
      try {
        await client.disconnect();
      } catch {
        /* best-effort */
      }
    }
  }
}

module.exports = {
  MegaEnumerator,
  FULL_TABLE_QUERY,
  parseStationTimestamp,
  toDatabaseQueryByDateShape,
  extractLeadingJson,
};
