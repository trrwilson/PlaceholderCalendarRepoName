"use strict";
// Dev tool, not part of the bridge itself. Connects to the already-running
// bridge's control socket as a second client (server.js supports multiple) and
// fires one "mega_call" request per CLI arg pair, so we don't spin up a second
// EufySecurity session or duplicate auth/login. Requires EUFY_DEBUG_MEGA_CALL=1
// on the running bridge. Usage: node mega-probe.js <path> [payloadJson]
const WebSocket = require("./node_modules/ws");

const path = process.argv[2];
if (!path) {
  console.error("usage: node mega-probe.js <path> [payloadJson]");
  process.exit(1);
}
const payload = process.argv[3] ? JSON.parse(process.argv[3]) : {
  refresh: true,
  lastEventTime: 0,
  houseId: "",
  deviceSnList: [],
  parentSnList: [],
  startTime: Date.now() - 24 * 60 * 60 * 1000,
  endTime: Date.now(),
  category: [],
  eventType: [],
  storageType: [],
  triggerType: [],
  detectionList: [],
  intExtras: [],
  videoTypeList: [],
  storageCloud: [],
  megaPersonIds: [],
  count: 30,
  isFavourite: false,
  isSelectUnConnDevice: false,
  serverStorage: 0,
  faceIds: [],
  filtterDevices: [],
  sensorId: -1,
  loadDBCatch: false,
  transaction: `${Date.now()}`,
  filterAnimal: false,
  group_id: [],
};

const ws = new WebSocket("ws://127.0.0.1:3011");
ws.on("open", () => {
  const requestId = "probe1";
  console.log(`--> service=house path=${path}`);
  ws.send(JSON.stringify({ type: "mega_call", request_id: requestId, service: "house", path, payload }));
});
ws.on("message", (raw) => {
  const msg = JSON.parse(raw.toString("utf8"));
  if (msg.request_id === "probe1") {
    console.log("<--", JSON.stringify(msg, null, 2));
    ws.close();
    process.exit(0);
  }
});
ws.on("error", (err) => {
  console.error("socket error:", err.message);
  process.exit(1);
});
setTimeout(() => {
  console.error("timed out waiting for a response");
  process.exit(1);
}, 15000);
