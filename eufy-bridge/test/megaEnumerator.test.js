"use strict";

// Exercises MegaEnumerator against a stubbed @mega-yfue/eufy-sdk-shaped fake
// client -- no real SDK login, no network, no hardware. Covers what this
// session's live investigation established (docs/eufy-sdk-integration.md
// sections 18-19): the accountId must come from the station's own
// device.raw.member.admin_user_id (not the logged-in userId), the query goes
// out on channel 255 with the FULL_TABLE payload, and the reply is mapped
// into the exact shape EufyBridge._onDatabaseQueryByDate() already expects.

const test = require("node:test");
const assert = require("node:assert/strict");
const { EventEmitter } = require("node:events");
const { LoginStatus } = require("@mega-yfue/eufy-sdk");

const { MegaEnumerator, FULL_TABLE_QUERY, parseStationTimestamp, extractLeadingJson } = require("../src/megaEnumerator");

const NUL = String.fromCharCode(0);

class FakeP2PSession extends EventEmitter {
  constructor() {
    super();
    this.queryCalls = [];
  }
  queryDatabase(table, opts) {
    this.queryCalls.push({ table, opts });
  }
}

class FakeMegaClient {
  constructor({ loginStatus = LoginStatus.Ok, userId = "login-user-id", devices = [], session } = {}) {
    this._loginStatus = loginStatus;
    this._userId = userId;
    this._devices = devices;
    this._session = session || new FakeP2PSession();
    this.disconnectCalls = 0;
  }
  async login() {
    return { status: this._loginStatus, session: { userId: this._userId } };
  }
  async getDevices() {
    return this._devices;
  }
  async getDevice() {
    return undefined;
  }
  getP2pSessions() {
    return new Map([[this._devices[0] && this._devices[0].sn, this._session]]);
  }
  async disconnect() {
    this.disconnectCalls += 1;
  }
}

function makeEnumerator({ client, stationSerial = "STATION1", queryWindowMs = 5, p2pWarmupMs = 5, log = () => {} } = {}) {
  return {
    enumerator: new MegaEnumerator({
      email: "a@example.com",
      password: "secret",
      region: "US",
      sessionFile: "/tmp/does-not-matter.json",
      stationSerial,
      queryWindowMs,
      p2pWarmupMs,
      log,
      createClient: () => client,
    }),
    client,
  };
}

test("poll() sends the station's own member.admin_user_id, not the logged-in userId", async () => {
  const client = new FakeMegaClient({
    userId: "login-user-id",
    devices: [{ sn: "STATION1", model: "T8030", raw: { member: { admin_user_id: "station-admin-id" } } }],
  });
  const { enumerator } = makeEnumerator({ client });

  const pending = enumerator.poll();
  // Let the P2P warm-up delay elapse and the query get sent, then let the
  // query window run out on its own -- no dbChunk arrives, poll() resolves
  // with an empty array.
  await pending;

  const session = client._session;
  assert.equal(session.queryCalls.length, 1);
  assert.equal(session.queryCalls[0].table, "history_record_info");
  assert.equal(session.queryCalls[0].opts.accountId, "station-admin-id");
  assert.equal(session.queryCalls[0].opts.channel, 255);
  assert.deepEqual(session.queryCalls[0].opts.query, FULL_TABLE_QUERY);
});

test("poll() falls back to the login userId only when the device record has no member.admin_user_id", async () => {
  const client = new FakeMegaClient({
    userId: "login-user-id",
    devices: [{ sn: "STATION1", model: "T8030", raw: {} }],
  });
  const { enumerator } = makeEnumerator({ client });

  await enumerator.poll();

  assert.equal(client._session.queryCalls[0].opts.accountId, "login-user-id");
});

test("poll() maps a real dbChunk reply into the databaseQueryByDate record shape", async () => {
  const client = new FakeMegaClient({
    devices: [{ sn: "STATION1", model: "T8030", raw: { member: { admin_user_id: "station-admin-id" } } }],
  });
  const { enumerator } = makeEnumerator({ client });

  const pending = enumerator.poll();
  // Past the (short, test-configured) P2P warm-up delay, so the dbChunk
  // listener is attached before these fire -- Node's EventEmitter does not
  // queue events for a listener registered after the emit.
  await new Promise((resolve) => setTimeout(resolve, 20));
  // Emit a real captured-shape reply, split across two chunks with NUL
  // padding on the end, the way the real wire response arrived in this
  // investigation's testing.
  const record = {
    device_sn: "CAM1",
    station_sn: "STATION1",
    record_id: 2026091100009,
    start_time: "2026-09-11 16:11:04",
    end_time: "2026-09-11 16:11:17",
    storage_path: "/zx/emmcdata/Camera00/202609/20260911161103/20260911161103.zxvideo",
    thumb_path: "/zx/emmcdata/Camera00/202609/20260911161103/snapshort.jpg",
    cipher_id: 0,
    frame_num: 203,
    time_zone: "-0700",
  };
  const body = JSON.stringify({ cmd: 10000, count: 1, data: [record] });
  // Trailing garbage past the last decrypted 16-byte block is leftover
  // ciphertext, not reliably NUL -- confirmed live in production (a real
  // poll hit "Unexpected non-whitespace character after JSON" because an
  // earlier version of this code assumed the padding was always zero
  // bytes). Use non-NUL noise here specifically to guard against that
  // regression.
  client._session.emit("dbChunk", { text: body.slice(0, 10) });
  client._session.emit("dbChunk", { text: body.slice(10) + "\x07\x9f\x03" });

  const results = await pending;
  assert.equal(results.length, 1);
  assert.equal(results[0].device_sn, "CAM1");
  assert.equal(results[0].record_id, 2026091100009);
  assert.equal(results[0].storage_path, record.storage_path);
  assert.equal(results[0].cipher_id, 0);
  assert.equal(results[0].frame_num, 203);
  assert.ok(results[0].start_time instanceof Date);
  assert.equal(results[0].start_time.toISOString(), "2026-09-11T23:11:04.000Z"); // -0700 -> UTC
});

test("poll() returns no records and does not throw when login is not OK", async () => {
  const client = new FakeMegaClient({ loginStatus: LoginStatus.TwoFactor });
  const { enumerator } = makeEnumerator({ client });

  const results = await enumerator.poll();
  assert.deepEqual(results, []);
});

test("poll() returns no records when the configured station is not in the device list", async () => {
  const client = new FakeMegaClient({ devices: [{ sn: "OTHER", model: "T8030", raw: {} }] });
  const { enumerator } = makeEnumerator({ client, stationSerial: "STATION1" });

  const results = await enumerator.poll();
  assert.deepEqual(results, []);
});

test("poll() disconnects the client even when the query window yields nothing", async () => {
  const client = new FakeMegaClient({
    devices: [{ sn: "STATION1", model: "T8030", raw: { member: { admin_user_id: "id" } } }],
  });
  const { enumerator } = makeEnumerator({ client, queryWindowMs: 5 });

  await enumerator.poll();
  assert.equal(client.disconnectCalls, 1);
});

test("poll() is a no-op when no station serial is configured", async () => {
  // `null`, not `undefined` -- makeEnumerator's own `stationSerial` default
  // parameter would otherwise silently substitute "STATION1" for `undefined`.
  const client = new FakeMegaClient({ devices: [] });
  const { enumerator } = makeEnumerator({ client, stationSerial: null });

  const results = await enumerator.poll();
  assert.deepEqual(results, []);
  assert.equal(client.disconnectCalls, 0, "must not even construct/login a client with no station configured");
});

test("extractLeadingJson trims trailing NUL padding", () => {
  assert.equal(extractLeadingJson(`{"a":1}${NUL.repeat(3)}`), '{"a":1}');
});

test("extractLeadingJson trims trailing non-NUL ciphertext noise (the real production failure mode)", () => {
  assert.equal(extractLeadingJson('{"a":1}\x07\x9f\x03'), '{"a":1}');
});

test("extractLeadingJson does not get confused by braces inside a string value", () => {
  const withBraces = '{"a":"looks like json: {\\"b\\":2}"}';
  assert.equal(extractLeadingJson(withBraces + NUL.repeat(2)), withBraces);
});

test("extractLeadingJson is a no-op when there is no trailing garbage", () => {
  assert.equal(extractLeadingJson('{"a":1}'), '{"a":1}');
});

test("parseStationTimestamp applies the record's own reported timezone", () => {
  const d = parseStationTimestamp("2026-09-11 16:11:04", "-0700");
  assert.equal(d.toISOString(), "2026-09-11T23:11:04.000Z");
});

test("parseStationTimestamp falls back to UTC for a missing/malformed offset", () => {
  const d = parseStationTimestamp("2026-09-11 16:11:04", undefined);
  assert.equal(d.toISOString(), "2026-09-11T16:11:04.000Z");
});
