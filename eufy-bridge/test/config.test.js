"use strict";

const test = require("node:test");
const assert = require("node:assert/strict");

const { loadConfig, MAX_POLLING_INTERVAL_MINUTES } = require("../src/config");

function withEnv(vars, fn) {
  const prior = {};
  for (const key of Object.keys(vars)) {
    prior[key] = process.env[key];
    if (vars[key] === undefined) delete process.env[key];
    else process.env[key] = vars[key];
  }
  try {
    return fn();
  } finally {
    for (const key of Object.keys(prior)) {
      if (prior[key] === undefined) delete process.env[key];
      else process.env[key] = prior[key];
    }
  }
}

const BASE_ENV = {
  EUFY_EMAIL: "a@example.com",
  EUFY_PASSWORD: "secret",
  EUFY_SESSION_FILE: "/tmp/session.json",
  EUFY_CLIP_CACHE_DIR: "/tmp/clips",
};

test("loadConfig applies sane defaults", () => {
  withEnv(BASE_ENV, () => {
    const config = loadConfig();
    assert.equal(config.region, "US");
    assert.equal(config.pollingIntervalMinutes, 1440);
    assert.equal(config.reconcileIntervalSeconds, 120);
    assert.equal(config.host, "127.0.0.1");
    assert.equal(config.port, 3011);
  });
});

test("loadConfig throws on a missing required var", () => {
  withEnv({ ...BASE_ENV, EUFY_EMAIL: undefined }, () => {
    assert.throws(() => loadConfig(), /EUFY_EMAIL/);
  });
});

test("loadConfig rejects a pollingIntervalMinutes that would overflow Node's setTimeout", () => {
  // The exact bug that fired ~356 extra authenticated cloud calls during the
  // 2026-09-10 verification spike (docs/eufy-sdk-integration.md §5.6.1): a
  // value meant as "basically never" silently clamps instead of erroring.
  withEnv({ ...BASE_ENV, EUFY_POLLING_INTERVAL_MINUTES: "999999" }, () => {
    assert.throws(() => loadConfig(), /EUFY_POLLING_INTERVAL_MINUTES/);
  });
});

test("loadConfig accepts the maximum sane pollingIntervalMinutes", () => {
  withEnv({ ...BASE_ENV, EUFY_POLLING_INTERVAL_MINUTES: String(MAX_POLLING_INTERVAL_MINUTES) }, () => {
    const config = loadConfig();
    assert.equal(config.pollingIntervalMinutes, MAX_POLLING_INTERVAL_MINUTES);
  });
});

test("loadConfig parses EUFY_CAMERA_NAMES as serial=name pairs", () => {
  withEnv({ ...BASE_ENV, EUFY_CAMERA_NAMES: "AAA=Front Door,BBB=KittyCam" }, () => {
    const config = loadConfig();
    assert.deepEqual(config.cameraNames, { AAA: "Front Door", BBB: "KittyCam" });
  });
});
