"use strict";

// Mission Control's eufy sidecar: wraps eufy-security-client (cloud login,
// push events, local P2P clip listing/retrieval) and exposes it to the
// FastAPI backend over a localhost-only WebSocket control channel
// (app/eufy/client.py speaks the other end). Not published, not a Python
// dependency — deployment infrastructure only. See
// docs/eufy-sdk-integration.md.
//
// Spawned and supervised by app/eufy/bridge_process.py, which passes every
// setting below as an environment variable (see src/config.js) — never argv.

const { loadConfig } = require("./src/config");
const { EufyBridge } = require("./src/eufyBridge");
const { startServer } = require("./src/server");

function log(message) {
  // Plain stdout lines; the backend's supervisor pipes these into its own
  // logger with an "[eufy-bridge]" prefix (app/eufy/bridge_process.py).
  process.stdout.write(`${new Date().toISOString()} ${message}\n`);
}

async function main() {
  const config = loadConfig();
  const bridge = new EufyBridge(config, log);

  const { broadcast } = startServer({
    host: config.host,
    port: config.port,
    log,
    onMessage: async (message, socket) => {
      const requestId = message.request_id;
      switch (message.type) {
        case "answer_captcha":
          await bridge.answerCaptcha(message.code);
          break;
        case "answer_tfa":
          await bridge.answerTfa(message.code);
          break;
        case "get_thumbnail": {
          const result = await bridge.getThumbnail(message.clip_id);
          const payload = { type: "thumbnail", request_id: requestId, clip_id: message.clip_id };
          if (result.data) payload.data_base64 = result.data.toString("base64");
          if (result.error) payload.error = result.error;
          socket.send(JSON.stringify(payload));
          break;
        }
        case "retrieve_clip": {
          const result = await bridge.retrieveClip(message.clip_id);
          const payload = { type: "clip_file", request_id: requestId, clip_id: message.clip_id };
          if (result.path) payload.path = result.path;
          if (result.error) payload.error = result.error;
          socket.send(JSON.stringify(payload));
          break;
        }
        case "mega_call": {
          if (!config.debugMegaCall) {
            log(`mega_call rejected: EUFY_DEBUG_MEGA_CALL is not set`);
            socket.send(JSON.stringify({ type: "mega_call_result", request_id: requestId, error: "disabled" }));
            break;
          }
          const result = await bridge.megaCall(message.service, message.path, message.payload);
          socket.send(JSON.stringify({ type: "mega_call_result", request_id: requestId, ...result }));
          break;
        }
        default:
          log(`unrecognised control message type: ${message.type}`);
      }
    },
  });

  bridge.onEvent = broadcast;
  bridge.startCacheEviction();

  log(`listening on ${config.host}:${config.port}`);
  await bridge.start();
}

main().catch((err) => {
  log(`fatal: ${err && err.stack}`);
  process.exitCode = 1;
});

// The backend supervisor (app/eufy/bridge_process.py) terminates this process
// with SIGTERM on shutdown; exit cleanly rather than dumping a stack trace.
process.on("SIGTERM", () => process.exit(0));
process.on("SIGINT", () => process.exit(0));
