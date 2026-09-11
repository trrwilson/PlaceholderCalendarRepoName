"use strict";

// Exercises EufyBridge against a stubbed EufySecurity-shaped fake event
// emitter — no real SDK, no network, no hardware. Covers what this session
// could verify without the household's real account/HomeBase: roster
// loading, clip-record de-duplication, the captcha/2FA answer handshake, and
// the thumbnail request/response round trip. The P2P download+mux path
// (`retrieveClip`) needs real Readable streams and a real `ffmpeg` binary and
// is deliberately NOT exercised here — see docs/eufy-sdk-integration.md for
// what the 2026-09-10 hardware spike did verify directly.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const { EufyBridge } = require("../src/eufyBridge");

class FakeStation extends EventEmitter {
  constructor(serial) {
    super();
    this.serial = serial;
    this.queries = [];
    this.downloadImageCalls = [];
  }
  getSerial() {
    return this.serial;
  }
  databaseQueryByDate(serials, since, until) {
    this.queries.push({ serials, since, until });
  }
  downloadImage(coverPath) {
    this.downloadImageCalls.push(coverPath);
  }
  async startDownload() {}
  cancelDownload() {}
}

class FakeDevice {
  constructor(serial, name, stationSerial) {
    this.serial = serial;
    this.name = name;
    this.stationSerial = stationSerial;
  }
  getSerial() {
    return this.serial;
  }
  getName() {
    return this.name;
  }
  getStationSerial() {
    return this.stationSerial;
  }
}

class FakeClient extends EventEmitter {
  constructor({ stations = [], devices = [] } = {}) {
    super();
    this._stations = stations;
    this._devices = devices;
    this.connectCalls = [];
  }
  async connect(options) {
    this.connectCalls.push(options);
  }
  close() {}
  async getStations() {
    return this._stations;
  }
  async getDevices() {
    return this._devices;
  }
  async getDevice(serial) {
    return this._devices.find((d) => d.getSerial() === serial);
  }
}

function makeBridge({ stations, devices }) {
  const fakeClient = new FakeClient({ stations, devices });
  const logs = [];
  const events = [];
  const clipCacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "eufy-bridge-test-"));
  const bridge = new EufyBridge(
    {
      email: "a@example.com",
      password: "secret",
      region: "US",
      sessionFile: path.join(clipCacheDir, "session.json"),
      cameraNames: {},
      reconcileIntervalSeconds: 3600, // don't let the real timer fire during tests
      reconcileLookbackMinutes: 10,
      clipCacheDir,
      clipCacheTtlSeconds: 600,
      pollingIntervalMinutes: 1440,
    },
    (message) => logs.push(message),
    { initializeClient: async () => fakeClient }
  );
  bridge.onEvent = (message) => events.push(message);
  return { bridge, fakeClient, logs, events };
}

test("start() loads the roster and emits ready with friendly names", async () => {
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "Front Door", "STATION1");
  const { bridge, fakeClient, events } = makeBridge({ stations: [station], devices: [device] });

  await bridge.start();
  fakeClient.emit("connect");
  // "connect" handling is async (awaiting getStations/getDevices) — flush microtasks.
  await new Promise((resolve) => setImmediate(resolve));

  const ready = events.find((e) => e.type === "ready");
  assert.ok(ready, "expected a ready event");
  assert.deepEqual(ready.devices, [{ camera_id: "CAM1", camera_name: "Front Door" }]);
  assert.ok(events.some((e) => e.type === "status" && e.state === "connected"));
});

test("EUFY_CAMERA_NAMES override wins over the device's own name", async () => {
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "SDK Default Name", "STATION1");
  const { bridge, fakeClient, events } = makeBridge({ stations: [station], devices: [device] });
  bridge.config.cameraNames = { CAM1: "Front Door" };

  await bridge.start();
  fakeClient.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));

  const ready = events.find((e) => e.type === "ready");
  assert.equal(ready.devices[0].camera_name, "Front Door");
});

test("a database-query-by-date response emits clip_discovered once per new record", async () => {
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "Front Door", "STATION1");
  const { bridge, fakeClient, events } = makeBridge({ stations: [station], devices: [device] });
  await bridge.start();
  fakeClient.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  events.length = 0;

  const record = {
    device_sn: "CAM1",
    station_sn: "STATION1",
    record_id: 42,
    start_time: new Date("2026-09-07T18:30:00Z"),
    storage_path: "/path/to/clip",
    thumb_path: "/path/to/thumb",
    cipher_id: 7,
    frame_num: 300,
  };
  fakeClient.emit("station database query by date", station, 0, [record]);
  fakeClient.emit("station database query by date", station, 0, [record]); // duplicate

  const discovered = events.filter((e) => e.type === "clip_discovered");
  assert.equal(discovered.length, 1, "the duplicate record must not be re-emitted");
  assert.equal(discovered[0].clip_id, "CAM1:42");
  assert.equal(discovered[0].camera_name, "Front Door");
  assert.equal(discovered[0].frame_num, 300);
});

test("a database-query-by-date response emits clip_discovered oldest-first regardless of record order", async () => {
  // The backend's ring buffer (EufyEventService._add_clip) does an
  // unconditional appendleft per clip_discovered event and relies on
  // oldest-first emission to end up newest-first itself. The SDK's actual
  // return order for databaseQueryByDate isn't documented, so this asserts
  // the bridge sorts rather than trusting it — records here arrive
  // newest-first, the opposite of what's required.
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "Front Door", "STATION1");
  const { bridge, fakeClient, events } = makeBridge({ stations: [station], devices: [device] });
  await bridge.start();
  fakeClient.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  events.length = 0;

  const recordAt = (id, iso) => ({
    device_sn: "CAM1",
    station_sn: "STATION1",
    record_id: id,
    start_time: new Date(iso),
    storage_path: "/path/to/clip",
    thumb_path: "/path/to/thumb",
    cipher_id: 7,
    frame_num: 300,
  });
  const newest = recordAt(3, "2026-09-07T18:30:00Z");
  const middle = recordAt(2, "2026-09-06T18:30:00Z");
  const oldest = recordAt(1, "2026-09-05T18:30:00Z");
  fakeClient.emit("station database query by date", station, 0, [newest, middle, oldest]);

  const discovered = events.filter((e) => e.type === "clip_discovered");
  assert.deepEqual(
    discovered.map((e) => e.clip_id),
    ["CAM1:1", "CAM1:2", "CAM1:3"],
    "must emit oldest-first even when the SDK returned newest-first"
  );
});

test("a device event triggers a narrow re-query for that camera's station", async () => {
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "Front Door", "STATION1");
  const { bridge, fakeClient } = makeBridge({ stations: [station], devices: [device] });
  await bridge.start();
  fakeClient.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));
  station.queries.length = 0; // clear the initial "station connect" reconcile, if any

  fakeClient.emit("device motion detected", device);

  assert.equal(station.queries.length, 1);
  assert.deepEqual(station.queries[0].serials, ["CAM1"]);
});

test("captcha challenge round-trips through connect({captcha})", async () => {
  const { bridge, fakeClient, events } = makeBridge({ stations: [], devices: [] });
  await bridge.start();

  fakeClient.emit("captcha request", "captcha-id-1", "data:image/png;base64,AAAA");
  assert.ok(events.some((e) => e.type === "auth" && e.need === "captcha"));
  assert.ok(events.some((e) => e.type === "status" && e.state === "needs_signin"));

  await bridge.answerCaptcha("1234");
  const call = fakeClient.connectCalls.at(-1);
  assert.deepEqual(call, { captcha: { captchaId: "captcha-id-1", captchaCode: "1234" }, force: false });
});

test("tfa challenge round-trips through connect({verifyCode})", async () => {
  const { bridge, fakeClient, events } = makeBridge({ stations: [], devices: [] });
  await bridge.start();

  fakeClient.emit("tfa request");
  assert.ok(events.some((e) => e.type === "auth" && e.need === "tfa"));

  await bridge.answerTfa("998877");
  const call = fakeClient.connectCalls.at(-1);
  assert.deepEqual(call, { verifyCode: "998877", force: false });
});

test("getThumbnail resolves from the matching station image download event", async () => {
  const station = new FakeStation("STATION1");
  const device = new FakeDevice("CAM1", "Front Door", "STATION1");
  const { bridge, fakeClient } = makeBridge({ stations: [station], devices: [device] });
  await bridge.start();
  fakeClient.emit("connect");
  await new Promise((resolve) => setImmediate(resolve));

  fakeClient.emit("station database query by date", station, 0, [
    {
      device_sn: "CAM1",
      station_sn: "STATION1",
      record_id: 1,
      start_time: new Date(),
      storage_path: "/p",
      thumb_path: "/thumb/1.jpg",
      cipher_id: 1,
      frame_num: 100,
    },
  ]);

  const pending = bridge.getThumbnail("CAM1:1");
  // Let downloadImage() get called, then simulate the async image arriving.
  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(station.downloadImageCalls, ["/thumb/1.jpg"]);
  fakeClient.emit("station image download", station, "/thumb/1.jpg", {
    data: Buffer.from("fake-jpeg"),
    type: { ext: "jpg", mime: "image/jpeg" },
  });

  const result = await pending;
  assert.deepEqual(result, { data: Buffer.from("fake-jpeg") });
});

test("getThumbnail for an unknown clip id fails fast without touching the station", async () => {
  const { bridge } = makeBridge({ stations: [], devices: [] });
  await bridge.start();
  const result = await bridge.getThumbnail("does-not-exist");
  assert.equal(result.error, "unknown clip");
});
