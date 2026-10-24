/**
 * 火山協議冒煙測試：模擬一個「大模型流式語音識別」client。
 *   node test/volc-smoke.mjs [音檔] [wss://...]
 * 會把音檔轉成 16 kHz PCM，用 100 ms 一包送，並印出所有 server 回應。
 */

import "../src/env.mjs";

import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { gzipSync, gunzipSync } from "node:zlib";
import WebSocket from "ws";

const file = process.argv[2] || "/tmp/zh-test.aiff";
const endpoint = process.argv[3] || "ws://127.0.0.1:10005/api/v3/sauc/bigmodel";
const key = process.env.MUSE_API_KEY?.trim();
if (!key) throw new Error("MUSE_API_KEY must be set in the environment or .env");

const MSG = { FULL_CLIENT_REQUEST: 0x1, AUDIO_ONLY: 0x2 };

function frame(obj, { messageType, sequence = 1, compression = 0, flags = 0x1 }) {
  const json = Buffer.from(JSON.stringify(obj), "utf8");
  const body = compression === 1 ? gzipSync(json) : json;
  const head = Buffer.alloc(4);
  head[0] = 0x11;
  head[1] = (messageType << 4) | flags;
  head[2] = 0x10 | compression;
  head[3] = 0;
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(sequence, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, seq, size, body]);
}

function audioFrame(pcm, { sequence, isLast = false, compression = 0 }) {
  const body = compression === 1 ? gzipSync(pcm) : pcm;
  const head = Buffer.alloc(4);
  head[0] = 0x11;
  head[1] = (MSG.AUDIO_ONLY << 4) | (isLast ? 0x3 : 0x1);
  head[2] = 0x00 | compression;
  head[3] = 0;
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(isLast ? 0xffffffff : sequence, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  return Buffer.concat([head, seq, size, body]);
}

function parse(buf) {
  if (buf.length < 4) return null;
  const headerSize = (buf[0] & 0x0f) * 4;
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const compression = buf[2] & 0x0f;
  let off = headerSize;
  let seq = null;
  if (flags === 1 || flags === 3) {
    seq = buf.readUInt32BE(off);
    off += 4;
  }
  const size = buf.readUInt32BE(off);
  off += 4;
  if (buf.length < off + size) return null;
  let payload = buf.subarray(off, off + size);
  if (compression === 1) {
    try {
      payload = gunzipSync(payload);
    } catch {}
  }
  return { consumed: off + size, messageType, flags, comp: compression, seq, payload };
}

function decodeTo16k(file) {
  return new Promise((resolve, reject) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", "16000", "-f", "s16le", "-"]);
    const parts = [];
    p.stdout.on("data", (b) => parts.push(b));
    p.on("close", (c) => (c === 0 ? resolve(Buffer.concat(parts)) : reject(new Error("ffmpeg " + c))));
    p.on("error", reject);
  });
}

const pcm = await decodeTo16k(file);
console.log("audio:", (pcm.length / 32000).toFixed(2), "s @16k");

const edgeIp = process.env.VOLC_EDGE_IP;
const edgeHost = process.env.VOLC_EDGE_HOST;
const wsOptions = {
  headers: {
    "X-Api-App-Key": key,
    "X-Api-Access-Key": key,
    "X-Api-Key": key,
    "X-Api-Resource-Id": "volc.bigasr.sauc.duration",
    "X-Api-Request-Id": crypto.randomUUID(),
    "X-Api-Connect-Id": crypto.randomUUID(),
  },
};
let target = endpoint;
if (edgeIp && edgeHost) {
  // 走 Cloudflare edge：TCP 連到指定 IP，Host/SNI 仍用真正的網域（本機 WARP DNS 解不出來時用）
  const u = new URL(endpoint);
  const via = new URL(endpoint);
  via.hostname = edgeIp;
  target = via.toString();
  wsOptions.headers.Host = edgeHost;
  wsOptions.servername = edgeHost;
  wsOptions.rejectUnauthorized = false;
  console.log("[edge]", target, "sni/host=", edgeHost);
}
const ws = new WebSocket(target, wsOptions);

let pending = Buffer.alloc(0);
const t0 = Date.now();
let chunks = 0;

ws.on("open", () => {
  console.log("[open]", ((Date.now() - t0) / 1000).toFixed(2) + "s");
  ws.send(
    frame(
      {
        user: { uid: "smoke-test" },
        audio: { format: "pcm", codec: "raw", rate: 16000, bits: 16, channel: 1, language: "zh-CN" },
        request: { model_name: "bigmodel", enable_itn: true, enable_punc: true, show_utterances: true, result_type: "full" },
      },
      { messageType: MSG.FULL_CLIENT_REQUEST },
    ),
  );

  // 100 ms = 3200 bytes @ 16k mono s16le；按真實時間送
  const CHUNK = 3200;
  let seq = 2;
  let off = 0;
  const timer = setInterval(() => {
    if (off >= pcm.length) {
      clearInterval(timer);
      ws.send(audioFrame(Buffer.alloc(0), { sequence: seq++, isLast: true }));
      console.log("[sent last packet]", ((Date.now() - t0) / 1000).toFixed(2) + "s");
      return;
    }
    const slice = pcm.subarray(off, off + CHUNK);
    off += CHUNK;
    chunks++;
    ws.send(audioFrame(slice, { sequence: seq++ }));
  }, 100);
});

ws.on("message", (data) => {
  pending = Buffer.concat([pending, Buffer.from(data)]);
  for (;;) {
    const f = parse(pending);
    if (!f) break;
    pending = pending.subarray(f.consumed);
    let obj;
    try {
      obj = JSON.parse(f.payload.toString("utf8"));
    } catch {
      obj = f.payload.toString("utf8").slice(0, 120);
    }
    const text = obj?.result?.text ?? obj?.error ?? "";
    console.log(
      `${((Date.now() - t0) / 1000).toFixed(2)}s  type=0x${f.messageType.toString(16)} seq=${f.seq} last=${f.flags === 3 || f.flags === 2} ${JSON.stringify(text).slice(0, 90)}`,
    );
  }
});

ws.on("close", (code, reason) => {
  console.log("[close]", code, reason.toString(), ((Date.now() - t0) / 1000).toFixed(2) + "s", "chunks=" + chunks);
  process.exit(0);
});

ws.on("error", (e) => {
  console.log("[error]", e.message);
  process.exit(1);
});

setTimeout(() => {
  console.log("[timeout]");
  process.exit(1);
}, 90_000);
