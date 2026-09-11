"use strict";

const { spawn } = require("node:child_process");
const fs = require("node:fs");

function runFfmpeg(args) {
  return new Promise((resolve, reject) => {
    let proc;
    try {
      proc = spawn("ffmpeg", args, { stdio: ["ignore", "ignore", "pipe"] });
    } catch (err) {
      reject(err);
      return;
    }
    let stderr = "";
    proc.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    proc.on("error", reject); // ffmpeg not on PATH
    proc.on("close", (code) => {
      if (code === 0) resolve();
      else reject(new Error(`ffmpeg exited ${code}: ${stderr.slice(-2000)}`));
    });
  });
}

// Raw P2P elementary streams (app/eufy: station.startDownload) have no
// container a decoder can sniff, so ffmpeg must be told the video codec
// explicitly — and StreamMetadata.videoCodec is not reliable at face value
// (verified 2026-09-10: it reported a value suggesting H.264 for a stream that
// was actually HEVC — see docs/eufy-sdk-integration.md §5.1). Try HEVC first
// (what the verified spike's real clip turned out to be), then H.264, each
// with and without the audio track, and take the first attempt that succeeds —
// audio muxing was proven-decryptable but not exercised by that spike, so
// treat it as best-effort: a clip with unmuxable audio still plays, silently.
async function muxClip({ videoPath, audioPath, outPath }) {
  const hasAudio = Boolean(audioPath) && fs.existsSync(audioPath) && fs.statSync(audioPath).size > 0;
  const attempts = [];
  for (const videoFormat of ["hevc", "h264"]) {
    if (hasAudio) {
      attempts.push({
        hasAudio: true,
        args: [
          "-y",
          "-f",
          videoFormat,
          "-i",
          videoPath,
          "-i",
          audioPath,
          "-map",
          "0:v:0",
          "-map",
          "1:a:0",
          "-c:v",
          "copy",
          "-c:a",
          "aac",
          "-movflags",
          "+faststart",
          outPath,
        ],
      });
    }
    attempts.push({
      hasAudio: false,
      args: ["-y", "-f", videoFormat, "-i", videoPath, "-c:v", "copy", "-movflags", "+faststart", outPath],
    });
  }
  let lastError;
  for (const attempt of attempts) {
    try {
      await runFfmpeg(attempt.args);
      return { path: outPath, hasAudio: attempt.hasAudio };
    } catch (err) {
      lastError = err;
    }
  }
  throw lastError || new Error("ffmpeg muxing failed for an unknown reason");
}

module.exports = { muxClip };
