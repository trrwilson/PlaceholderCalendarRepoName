"use strict";

const { WebSocketServer } = require("ws");

// The bridge's half of the localhost control channel the Python backend
// speaks (app/eufy/client.py): one JSON object per WebSocket text message, in
// both directions. Bound to `host` (127.0.0.1 by default) only — never
// exposed off-box. One connection at a time is the expected shape (the
// backend is the sole consumer), but broadcast() supports more without any
// extra work, matching app/realtime.py's ConnectionRegistry symmetry.
function startServer({ host, port, onMessage, log }) {
  const wss = new WebSocketServer({ host, port });
  const sockets = new Set();

  wss.on("connection", (socket) => {
    sockets.add(socket);
    log(`backend connected (${sockets.size} active)`);
    socket.on("message", (raw) => {
      let message;
      try {
        message = JSON.parse(raw.toString("utf8"));
      } catch {
        log("received a non-JSON message, dropping it");
        return;
      }
      Promise.resolve(onMessage(message, socket)).catch((err) => {
        log(`error handling message ${message && message.type}: ${err && err.stack}`);
      });
    });
    socket.on("close", () => {
      sockets.delete(socket);
      log(`backend disconnected (${sockets.size} active)`);
    });
    socket.on("error", (err) => log(`socket error: ${err && err.message}`));
  });

  function broadcast(message) {
    const payload = JSON.stringify(message);
    for (const socket of sockets) {
      if (socket.readyState === socket.OPEN) socket.send(payload);
    }
  }

  return { broadcast, close: () => wss.close() };
}

module.exports = { startServer };
