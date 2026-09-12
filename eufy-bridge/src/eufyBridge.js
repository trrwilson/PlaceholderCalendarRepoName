"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { EufySecurity, P2PConnectionType } = require("eufy-security-client");

const { muxClip } = require("./ffmpeg");
const { MegaEnumerator } = require("./megaEnumerator");

// Real device event names the `EufySecurity` client emits, taken verbatim
// from eufy-security-client 4.1.1-1's own type definitions (EufySecurityEvents
// in build/interfaces.d.ts). Each is emitted on the *client*, not the device,
// with the device passed as the first argument — e.g.
// `client.on("device motion detected", (device, state) => ...)`.
//
// This list previously used the bare names ("motion detected" etc., without
// the "device " prefix) based on a misreading of the type definitions during
// the 2026-09-10 verification spike — an easy mistake, since each map key is
// one indivisible string, not a "device" namespace plus a suffix. That meant
// `client.on(eventName, ...)` was subscribing to an event that never exists
// under any firmware, so every real push (docs/eufy-sdk-integration.md
// §16.4's "push events do not fire" finding) was silently dropped — not an
// account/firmware/migration problem as originally suspected. Confirmed live
// 2026-09-11 with a wildcard listener on `client.emit` (see `debugRawEvents`
// in src/config.js): a real motion trigger produced "device motion detected"
// and "device person detected" on the client, matching the type defs exactly.
const DEVICE_EVENT_NAMES = [
  "device motion detected",
  "device person detected",
  "device stranger person detected",
  "device pet detected",
  "device dog detected",
  "device vehicle detected",
  "device crying detected",
  "device sound detected",
  "device rings",
];

const DOWNLOAD_START_TIMEOUT_MS = 20_000;
const DOWNLOAD_FINISH_TIMEOUT_MS = 60_000;
const THUMBNAIL_TIMEOUT_MS = 12_000;

class EufyBridge {
  /**
   * `initializeClient` is an injectable seam over `EufySecurity.initialize`
   * (`(config, logger) => Promise<client>`) so tests can hand this class a
   * stubbed fake event-emitting client instead of the real SDK — Node 20
   * (this repo's dev sandbox) predates the SDK's own `>=24.0.0` requirement
   * and `node:test`'s `mock.module` (Node 22+), so constructor injection is
   * the seam, not module mocking. See test/eufyBridge.test.js.
   */
  constructor(config, log, { initializeClient, createMegaClient } = {}) {
    this.config = config;
    this.log = log;
    this.client = null;
    this.stations = new Map(); // station serial -> Station
    this.deviceNames = new Map(); // device serial -> friendly name
    this.deviceStation = new Map(); // device serial -> station serial
    this.clipCache = new Map(); // clipId -> DatabaseQueryByDate record
    this.pendingAuth = null; // { kind: "captcha", captchaId } | { kind: "tfa" } | null
    this.reconcileTimer = null;
    this._downloadInFlight = null;
    this._initializeClient = initializeClient || ((cfg, logger) => EufySecurity.initialize(cfg, logger));
    this.megaEnumerator = null;
    this.megaPollTimer = null;
    this._megaPollInFlight = false;
    this._runMegaPollOnce = null; // set in _startMegaEnumeration; shared by the periodic timer and event triggers
    this._megaEventPending = false;
    this._megaEventCooldownTimer = null;
    this._megaLastEventPollAt = 0; // last time an event trigger actually started a pass -- NOT touched by the periodic timer
    this._createMegaClient = createMegaClient; // undefined -> MegaEnumerator uses the real SDK
    /** Set by index.js to fan messages out over the control WebSocket. */
    this.onEvent = () => {};
  }

  emit(message) {
    try {
      this.onEvent(message);
    } catch (err) {
      this.log(`onEvent handler threw: ${err && err.stack}`);
    }
  }

  async start() {
    fs.mkdirSync(this.config.clipCacheDir, { recursive: true });
    fs.mkdirSync(path.dirname(this.config.sessionFile), { recursive: true });

    const eufyConfig = {
      username: this.config.email,
      password: this.config.password,
      country: this.config.region,
      language: "en",
      trustedDeviceName: "mission-control-bridge",
      persistentDir: path.dirname(this.config.sessionFile),
      persistentData: this._loadPersistentData(),
      // ONLY_LOCAL: P2P never relays through eufy's cloud (verified 2026-09-10).
      p2pConnectionSetup: P2PConnectionType.ONLY_LOCAL,
      pollingIntervalMinutes: this.config.pollingIntervalMinutes,
      eventDurationSeconds: 10,
    };
    if (this.config.stationLanIp && this.config.stationSerial) {
      eufyConfig.stationIPAddresses = { [this.config.stationSerial]: this.config.stationLanIp };
    }

    // `new EufySecurity(config)` does not work — the static factory is
    // required (verified 2026-09-10, see docs/eufy-sdk-integration.md §5.1).
    this.client = await this._initializeClient(eufyConfig, this._logger());
    if (this.config.debugRawEvents) this._wireRawEventLogging();
    this._wireEvents();
    this.emit({ type: "status", state: "connecting" });
    await this.client.connect({ force: false });
    this._startMegaEnumeration();
  }

  async stop() {
    this._stopReconciliation();
    this._stopMegaEnumeration();
    if (this.client) this.client.close();
  }

  // See src/megaEnumerator.js and docs/eufy-sdk-integration.md §18-§19: a
  // second, independent SDK/session used only to work around a documented
  // freshness bug in the primary `databaseQueryByDate` reconcile above. Fully
  // separate lifecycle from `this.client` — it has its own login and its own
  // short-lived P2P connection per poll, so it starts/stops independently of
  // the main client's connect/close events rather than piggybacking on them.
  _startMegaEnumeration() {
    if (!this.config.megaEnumerationEnabled) return;
    if (!this.config.stationSerial) {
      this.log("mega-enumerator: EUFY_MEGA_ENUMERATION_ENABLED=1 but no EUFY_STATION_SERIAL set — staying off");
      return;
    }
    this.megaEnumerator = new MegaEnumerator({
      email: this.config.email,
      password: this.config.password,
      region: this.config.region,
      sessionFile: this.config.megaSessionFile,
      stationSerial: this.config.stationSerial,
      queryWindowMs: this.config.megaQueryWindowMs,
      p2pWarmupMs: this.config.megaP2pWarmupMs,
      log: this.log,
      createClient: this._createMegaClient,
    });
    this._runMegaPollOnce = () => {
      if (this._megaPollInFlight) return;
      this._megaPollInFlight = true;
      this.megaEnumerator
        .poll()
        .then((records) => {
          if (records.length) this._onDatabaseQueryByDate(records);
        })
        .catch((err) => this.log(`mega-enumerator: unexpected error: ${err && err.stack}`))
        .finally(() => {
          this._megaPollInFlight = false;
          // A device-event trigger arrived while this pass was running --
          // run exactly one follow-up rather than dropping it silently.
          if (this._megaEventPending) {
            this._megaEventPending = false;
            this._triggerMegaPollFromEvent();
          }
        });
    };
    this.log(`mega-enumerator: enabled, polling every ${this.config.reconcileIntervalSeconds}s`);
    this._runMegaPollOnce(); // don't wait a full interval for the first, more useful pass
    this.megaPollTimer = setInterval(this._runMegaPollOnce, this.config.reconcileIntervalSeconds * 1000);
    this.megaPollTimer.unref();
  }

  _stopMegaEnumeration() {
    if (this.megaPollTimer) {
      clearInterval(this.megaPollTimer);
      this.megaPollTimer = null;
    }
    if (this._megaEventCooldownTimer) {
      clearTimeout(this._megaEventCooldownTimer);
      this._megaEventCooldownTimer = null;
    }
    this._megaEventPending = false;
    this._megaLastEventPollAt = 0;
    this._runMegaPollOnce = null;
    this.megaEnumerator = null;
  }

  // Off-schedule accelerant for a real device push: asks the SAME poll the
  // periodic timer uses to run right now instead of waiting up to
  // reconcileIntervalSeconds (docs/eufy-sdk-integration.md §19-§20 -- the
  // mega-enumerator FULL_TABLE query is the one enumeration path confirmed
  // to actually surface fresh clips on this hardware; the classic
  // databaseQueryByDate re-query in _onDeviceEvent below is not, §17.2).
  // No-op when mega enumeration is disabled or unconfigured.
  //
  // Debounced against two things independently: an already-running pass (any
  // source), and a previous EVENT-triggered pass that started less than
  // megaEventCooldownMs ago -- deliberately not gated by the periodic
  // timer's own runs, so an event arriving right after a scheduled poll
  // still fires right away rather than inheriting that poll's cooldown. A
  // burst of pushes (more than one event name per physical trigger, §17.1,
  // or several cameras firing close together) collapses into at most one
  // extra pass, never a pile-up. At most one follow-up is queued; repeated
  // triggers while one is already queued are coalesced into that same
  // follow-up.
  _triggerMegaPollFromEvent() {
    if (!this._runMegaPollOnce) return;
    if (this._megaPollInFlight) {
      this._megaEventPending = true;
      return;
    }
    const remaining = this.config.megaEventCooldownMs - (Date.now() - this._megaLastEventPollAt);
    if (remaining > 0) {
      this._megaEventPending = true;
      if (!this._megaEventCooldownTimer) {
        this._megaEventCooldownTimer = setTimeout(() => {
          this._megaEventCooldownTimer = null;
          if (this._megaEventPending) {
            this._megaEventPending = false;
            this._triggerMegaPollFromEvent();
          }
        }, remaining);
        this._megaEventCooldownTimer.unref();
      }
      return;
    }
    this._megaLastEventPollAt = Date.now();
    this._runMegaPollOnce();
  }

  _logger() {
    const log = this.log;
    const verbose = this.config.debugRawEvents;
    return {
      trace: verbose ? (...args) => log(`[eufy-security-client] TRACE ${args.map(String).join(" ")}`) : () => {},
      debug: verbose ? (...args) => log(`[eufy-security-client] DEBUG ${args.map(String).join(" ")}`) : () => {},
      info: (...args) => log(`[eufy-security-client] ${args.map(String).join(" ")}`),
      warn: (...args) => log(`[eufy-security-client] WARN ${args.map(String).join(" ")}`),
      error: (...args) => log(`[eufy-security-client] ERROR ${args.map(String).join(" ")}`),
    };
  }

  // Diagnostic-only (see `debugRawEvents` in src/config.js): logs the name and
  // arg count of every event the client emits, including ones this bridge has
  // no handler for. Wraps `emit` rather than adding a listener because Node's
  // EventEmitter has no built-in wildcard subscription.
  _wireRawEventLogging() {
    const client = this.client;
    const log = this.log;
    const originalEmit = client.emit.bind(client);
    client.emit = (eventName, ...args) => {
      log(`[raw-event] "${eventName}" (${args.length} arg${args.length === 1 ? "" : "s"})`);
      return originalEmit(eventName, ...args);
    };
  }

  _loadPersistentData() {
    try {
      return fs.readFileSync(this.config.sessionFile, "utf8");
    } catch {
      return undefined; // no session yet — a fresh login runs instead
    }
  }

  _wireEvents() {
    const client = this.client;

    // Written on every emission, not just once — the library re-emits this as
    // cloud tokens refresh (docs/eufy-sdk-integration.md §5.5). A valid file
    // here is what lets the next start skip password login entirely.
    client.on("persistent data", (data) => {
      try {
        fs.writeFileSync(this.config.sessionFile, data, "utf8");
      } catch (err) {
        this.log(`failed to persist eufy session: ${err.message}`);
      }
    });

    client.on("connect", async () => {
      this.log("cloud login connected");
      this.pendingAuth = null;
      try {
        await this._loadRoster();
        this.emit({ type: "status", state: "connected" });
        this._startReconciliation();
      } catch (err) {
        this.log(`failed to load device roster: ${err.stack}`);
        this.emit({ type: "status", state: "error", detail: String(err) });
      }
    });

    client.on("close", () => {
      this.log("cloud connection closed");
      this._stopReconciliation();
      this.emit({ type: "status", state: "reconnecting" });
    });

    client.on("connection error", (err) => {
      this.log(`cloud connection error: ${err && err.message}`);
      this.emit({ type: "status", state: "error", detail: String(err && err.message) });
    });

    // Never auto-retried — a human must supply the answer (control messages
    // below), matching the "never hammer the login endpoint" rule
    // (docs/eufy-sdk-integration.md §5.6).
    client.on("tfa request", () => {
      this.pendingAuth = { kind: "tfa" };
      this.emit({ type: "status", state: "needs_signin" });
      this.emit({ type: "auth", need: "tfa" });
    });

    client.on("captcha request", (id, captcha) => {
      this.pendingAuth = { kind: "captcha", captchaId: id };
      this.emit({ type: "status", state: "needs_signin" });
      this.emit({ type: "auth", need: "captcha", captcha_id: id, image: captcha });
    });

    client.on("station connect", (station) => this._onStationConnect(station));
    client.on("station close", (station) => {
      this.log(`station ${station.getSerial()} local P2P session closed`);
    });
    client.on("station connection error", (station, err) => {
      this.log(`station ${station.getSerial()} P2P error: ${err && err.message}`);
    });

    client.on("station database query by date", (station, returnCode, records) => {
      this._onDatabaseQueryByDate(records);
    });

    for (const eventName of DEVICE_EVENT_NAMES) {
      client.on(eventName, (device) => {
        // Logged explicitly -- without this line there's no way to tell a
        // push ever arrived: the narrow re-query it triggers logs nothing of
        // its own, and its result folds silently into the same
        // clip_discovered stream the periodic reconcile also feeds.
        this.log(`"${eventName}" from ${device.getSerial()}`);
        this._onDeviceEvent(device);
      });
    }
  }

  async _loadRoster() {
    const stations = await this.client.getStations();
    for (const station of stations) {
      this.stations.set(station.getSerial(), station);
    }
    const devices = await this.client.getDevices();
    const roster = [];
    for (const device of devices) {
      const serial = device.getSerial();
      const name = this.config.cameraNames[serial] || device.getName();
      this.deviceNames.set(serial, name);
      this.deviceStation.set(serial, device.getStationSerial());
      roster.push({ camera_id: serial, camera_name: name });
    }
    this.emit({ type: "ready", devices: roster });
  }

  _onStationConnect(station) {
    const serial = station.getSerial();
    this.log(`station ${serial} local P2P connected`);
    // The station's local database is only queryable once P2P is actually up
    // — kick an immediate reconciliation rather than waiting a full interval.
    this._reconcileStation(station).catch((err) =>
      this.log(`initial reconcile failed for ${serial}: ${err.stack}`)
    );
  }

  _onDeviceEvent(device) {
    const stationSerial = this.deviceStation.get(device.getSerial());
    const station = stationSerial && this.stations.get(stationSerial);
    if (!station) return;
    // Low-latency accelerant #1: re-list a narrow window around now for just
    // this camera, on the already-open primary session. Free, and any real
    // match lands in the same de-dup cache the periodic reconciliation uses
    // (`_onDatabaseQueryByDate`) -- but not, on its own, a fix: this specific
    // query is the one documented as unreliable on this hardware
    // (docs/eufy-sdk-integration.md §16.2/§17.2). Kept because it costs
    // nothing on a connection that's already up.
    const now = new Date();
    const since = new Date(now.getTime() - 2 * 60 * 1000);
    const until = new Date(now.getTime() + 2 * 60 * 1000);
    station.databaseQueryByDate([device.getSerial()], since, until);
    // Low-latency accelerant #2, the one that actually surfaces fresh clips
    // on this hardware (docs §19-§20): pull the mega-enumerator's next pass
    // forward instead of waiting up to reconcileIntervalSeconds for it.
    this._triggerMegaPollFromEvent();
  }

  _startReconciliation() {
    this._stopReconciliation();
    // LAN-local P2P calls to the HomeBase, not calls to eufy's cloud — safe to
    // run this often (docs/eufy-sdk-integration.md, "minimize cloud-facing
    // activity" is about the *cloud* path, not the local one).
    this.reconcileTimer = setInterval(() => {
      for (const station of this.stations.values()) {
        this._reconcileStation(station).catch((err) =>
          this.log(`reconcile failed for ${station.getSerial()}: ${err.stack}`)
        );
      }
    }, this.config.reconcileIntervalSeconds * 1000);
    this.reconcileTimer.unref();
  }

  _stopReconciliation() {
    if (this.reconcileTimer) {
      clearInterval(this.reconcileTimer);
      this.reconcileTimer = null;
    }
  }

  async _reconcileStation(station) {
    const now = new Date();
    const since = new Date(now.getTime() - this.config.reconcileLookbackMinutes * 60 * 1000);
    const serials = [...this.deviceStation.entries()]
      .filter(([, stationSn]) => stationSn === station.getSerial())
      .map(([deviceSn]) => deviceSn);
    if (serials.length === 0) return;
    // Logged explicitly -- without this there's no way to tell "no query ran"
    // from "a query ran and the station's response didn't include what we
    // expected" (docs/eufy-sdk-integration.md §15.5/§15.6: the response is
    // not reliably correlated to the requested window on this household's
    // real hardware, so that distinction matters for diagnosis).
    this.log(`local reconcile: querying ${since.toISOString()} -> ${now.toISOString()} (lookback ${this.config.reconcileLookbackMinutes}m)`);
    station.databaseQueryByDate(serials, since, now);
  }

  _onDatabaseQueryByDate(records) {
    this.log(`local reconcile: ${(records || []).length} record(s) returned`);
    // `clip_discovered` events must be emitted oldest-first: the backend's
    // ring buffer (`EufyEventService._add_clip`) does an unconditional
    // `appendleft` per event and relies on that ordering to end up
    // newest-first itself. The SDK's own return order isn't documented, so
    // sort explicitly rather than assume it matches.
    const sorted = [...(records || [])].sort(
      (a, b) => new Date(a.start_time).getTime() - new Date(b.start_time).getTime(),
    );
    for (const record of sorted) {
      const clipId = `${record.device_sn}:${record.record_id}`;
      if (this.clipCache.has(clipId)) continue;
      this.clipCache.set(clipId, record);
      const cameraName = this.deviceNames.get(record.device_sn) || record.device_sn;
      this.emit({
        type: "clip_discovered",
        clip_id: clipId,
        camera_id: record.device_sn,
        camera_name: cameraName,
        occurred_at: new Date(record.start_time).toISOString(),
        frame_num: record.frame_num,
      });
    }
  }

  // Diagnostic-only, gated by `debugMegaCall` in src/config.js (off by
  // default): probes `MegaHTTPApi.callDecrypted` directly for chasing
  // docs/eufy-sdk-integration.md §17's "what does the one HTTP call that
  // actually works look like" question. `megaTransition` is TypeScript
  // `private` on EufySecurity (compile-time only — erased at runtime, a
  // plain accessible property on the actual object), and `getMegaApi()`
  // lazily creates/reuses the already-persisted v6 session, so this needs no
  // separate login and opens no second connection to the account.
  async megaCall(service, path, payload) {
    try {
      const megaApi = await this.client.megaTransition.getMegaApi();
      const data = await megaApi.callDecrypted(service, path, payload || {});
      return { data };
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    }
  }

  async answerCaptcha(code) {
    if (!this.pendingAuth || this.pendingAuth.kind !== "captcha") return;
    const { captchaId } = this.pendingAuth;
    this.pendingAuth = null;
    await this.client.connect({ captcha: { captchaId, captchaCode: code }, force: false });
  }

  async answerTfa(code) {
    if (!this.pendingAuth || this.pendingAuth.kind !== "tfa") return;
    this.pendingAuth = null;
    await this.client.connect({ verifyCode: code, force: false });
  }

  async getThumbnail(clipId) {
    const record = this.clipCache.get(clipId);
    if (!record) return { error: "unknown clip" };
    const station = this.stations.get(record.station_sn);
    if (!station) return { error: "station unavailable" };
    return await new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.client.removeListener("station image download", onImage);
        resolve({ error: "timed out waiting for the thumbnail" });
      }, THUMBNAIL_TIMEOUT_MS);
      const onImage = (imgStation, file, image) => {
        if (imgStation.getSerial() !== station.getSerial() || file !== record.thumb_path) return;
        clearTimeout(timeout);
        this.client.removeListener("station image download", onImage);
        resolve({ data: image.data });
      };
      this.client.on("station image download", onImage);
      station.downloadImage(record.thumb_path);
    });
  }

  async retrieveClip(clipId) {
    const record = this.clipCache.get(clipId);
    if (!record) return { error: "unknown clip" };
    const cachedPath = this._cachedClipPath(clipId);
    if (fs.existsSync(cachedPath)) return { path: cachedPath };

    const station = this.stations.get(record.station_sn);
    const device = station && (await this.client.getDevice(record.device_sn));
    if (!station || !device) return { error: "station or device unavailable" };

    // One clip download at a time — a second request for a *different* clip
    // queues behind this one rather than racing the same
    // download-start/finish event pair (households tap one clip at a time).
    while (this._downloadInFlight) {
      await this._downloadInFlight.catch(() => {});
    }
    const download = this._downloadAndMux(station, device, record, clipId);
    this._downloadInFlight = download;
    try {
      const outPath = await download;
      return { path: outPath };
    } catch (err) {
      return { error: String(err && err.message ? err.message : err) };
    } finally {
      if (this._downloadInFlight === download) this._downloadInFlight = null;
    }
  }

  async _waitForDownloadStreams(device) {
    return await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.client.removeListener("station download start", onStart);
        reject(new Error("timed out waiting for the clip download to start"));
      }, DOWNLOAD_START_TIMEOUT_MS);
      const onStart = (dlStation, dlDevice, metadata, videoStream, audioStream) => {
        if (dlDevice.getSerial() !== device.getSerial()) return;
        clearTimeout(timeout);
        this.client.removeListener("station download start", onStart);
        resolve({ videoStream, audioStream });
      };
      this.client.on("station download start", onStart);
    });
  }

  async _downloadAndMux(station, device, record, clipId) {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "eufy-clip-"));
    const videoRaw = path.join(tmpDir, "video.raw");
    const audioRaw = path.join(tmpDir, "audio.raw");
    try {
      const streamsPromise = this._waitForDownloadStreams(device);
      await station.startDownload(device, record.storage_path, record.cipher_id);
      const { videoStream, audioStream } = await streamsPromise;

      const finishPromise = new Promise((resolve) => {
        const onFinish = (fnStation, fnDevice) => {
          if (fnDevice.getSerial() !== device.getSerial()) return;
          this.client.removeListener("station download finish", onFinish);
          resolve();
        };
        this.client.on("station download finish", onFinish);
      });

      const videoDone = new Promise((resolve, reject) => {
        const out = fs.createWriteStream(videoRaw);
        videoStream.pipe(out);
        out.on("finish", resolve);
        out.on("error", reject);
        videoStream.on("error", reject);
      });
      // Audio is best-effort (docs/eufy-sdk-integration.md §5.4 — decrypt is
      // proven, muxing is new): never let an audio-side failure fail the
      // whole clip.
      const audioDone = new Promise((resolve) => {
        const out = fs.createWriteStream(audioRaw);
        audioStream.pipe(out);
        out.on("finish", resolve);
        out.on("error", () => resolve());
        audioStream.on("error", () => resolve());
      });

      await Promise.race([
        Promise.all([videoDone, audioDone, finishPromise]),
        new Promise((_resolve, reject) =>
          setTimeout(
            () => reject(new Error("clip download timed out")),
            DOWNLOAD_FINISH_TIMEOUT_MS
          )
        ),
      ]).catch((err) => {
        station.cancelDownload(device);
        throw err;
      });

      const outPath = this._cachedClipPath(clipId);
      const result = await muxClip({ videoPath: videoRaw, audioPath: audioRaw, outPath });
      return result.path;
    } finally {
      fs.rm(tmpDir, { recursive: true, force: true }, () => {});
    }
  }

  _cachedClipPath(clipId) {
    const safe = crypto.createHash("sha1").update(clipId).digest("hex");
    return path.join(this.config.clipCacheDir, `${safe}.mp4`);
  }

  // Evict cached clip files past their TTL. Never touches a file mid-stream —
  // a finished GET has already read it; a stale unlink race just means the
  // next request re-downloads, never a crash.
  startCacheEviction() {
    const timer = setInterval(() => {
      const cutoff = Date.now() - this.config.clipCacheTtlSeconds * 1000;
      let entries;
      try {
        entries = fs.readdirSync(this.config.clipCacheDir);
      } catch {
        return;
      }
      for (const name of entries) {
        const full = path.join(this.config.clipCacheDir, name);
        try {
          if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full);
        } catch {
          // already gone, or racing another process — fine either way
        }
      }
    }, 60_000);
    timer.unref();
  }
}

module.exports = { EufyBridge, DEVICE_EVENT_NAMES };
