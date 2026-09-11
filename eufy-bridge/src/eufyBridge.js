"use strict";

const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const crypto = require("node:crypto");

const { EufySecurity, P2PConnectionType } = require("eufy-security-client");

const { muxClip } = require("./ffmpeg");

// Real device event names, verified against eufy-security-client 4.1.1-1's
// own type definitions (EufySecurityEvents in build/interfaces.d.ts,
// inspected 2026-09-11) — NOT exercised against a real device by the
// 2026-09-10 hardware spike, which proved login / device listing / local P2P
// / database query / clip download + decrypt, but not these specific push
// events actually firing. Confirm on first real run against the household's
// S330/HB3. A missing or renamed event here only costs latency (the periodic
// reconciliation poll still finds any new clip within
// `reconcileIntervalSeconds`), never correctness — this list is purely a
// low-latency accelerant, not the source of truth for what's on the station.
const DEVICE_EVENT_NAMES = [
  "motion detected",
  "person detected",
  "stranger person detected",
  "pet detected",
  "dog detected",
  "vehicle detected",
  "crying detected",
  "sound detected",
  "rings",
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
  constructor(config, log, { initializeClient } = {}) {
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
    this._wireEvents();
    this.emit({ type: "status", state: "connecting" });
    await this.client.connect({ force: false });
  }

  async stop() {
    this._stopReconciliation();
    if (this.client) this.client.close();
  }

  _logger() {
    const log = this.log;
    return {
      trace() {},
      debug() {},
      info: (...args) => log(`[eufy-security-client] ${args.map(String).join(" ")}`),
      warn: (...args) => log(`[eufy-security-client] WARN ${args.map(String).join(" ")}`),
      error: (...args) => log(`[eufy-security-client] ERROR ${args.map(String).join(" ")}`),
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
      client.on(eventName, (device) => this._onDeviceEvent(device));
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
    // Low-latency accelerant: re-list a narrow window around now for just
    // this camera. Any real match lands in the same de-dup cache the
    // periodic reconciliation uses (`_onDatabaseQueryByDate`), so overlapping
    // windows from both paths cost nothing.
    const now = new Date();
    const since = new Date(now.getTime() - 2 * 60 * 1000);
    const until = new Date(now.getTime() + 2 * 60 * 1000);
    station.databaseQueryByDate([device.getSerial()], since, until);
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
    station.databaseQueryByDate(serials, since, now);
  }

  _onDatabaseQueryByDate(records) {
    for (const record of records || []) {
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
