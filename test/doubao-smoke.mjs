#!/usr/bin/env node
/**
 * 豆包輸入法 ASR 煙霧測試：
 *   node test/doubao-smoke.mjs <audio file>
 *
 * 會先用 ffmpeg 轉成 24 kHz mono s16le（跟 server 內部一致），
 * 再走 src/doubao.mjs 的完整流程。
 *
 * 第一次跑會匿名註冊一個裝置並把憑證寫到 ~/.config/doubao-ime/cred.json。
 */

import { spawn } from "node:child_process";
import { DEFAULT_CREDENTIAL_PATH, transcribeDoubao } from "../src/doubao.mjs";

const input = process.argv[2];
if (!input) {
  console.error("usage: node test/doubao-smoke.mjs <audio file>");
  process.exit(2);
}

function decode(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", [
      "-hide_banner", "-loglevel", "error",
      "-i", file,
      "-ac", "1", "-ar", "24000",
      "-f", "s16le", "-",
    ]);
    const parts = [];
    let err = "";
    p.stdout.on("data", (b) => parts.push(b));
    p.stderr.on("data", (b) => (err += b));
    p.on("close", (code) => (code === 0 ? resolve(Buffer.concat(parts)) : reject(new Error(err || `ffmpeg ${code}`))));
    p.on("error", reject);
  });
}

const pcm = await decode(input);
console.log(`audio: ${(pcm.length / 2 / 24000).toFixed(2)}s   cred: ${DEFAULT_CREDENTIAL_PATH}`);
console.log("registering / connecting …");

const t0 = Date.now();
const result = await transcribeDoubao({ source: pcm });

console.log(`raw       : ${result.rawText}`);
console.log(`normalized: ${result.text}`);
console.log(
  `audioMs=${result.audioMs} frames=${result.frames} elapsed=${Date.now() - t0}ms attempts=${result.attempts} device=${result.deviceId}`,
);
