#!/usr/bin/env node
/**
 * muse-dictate — external Node.js client for Meta Muse's dictation (Voyager ASR).
 *
 *   muse-dictate --probe                      # handshake check, no audio
 *   muse-dictate                              # mic, press Enter to stop
 *   muse-dictate --seconds 8                  # mic, auto stop
 *   muse-dictate --file memo.m4a              # transcribe a file
 *   muse-dictate --mode ENDPOINTING           # server-side endpointing (multi-turn)
 *   muse-dictate --list-devices               # list avfoundation audio devices
 *
 * Token: --token, $MUSE_TOKEN, $META_TOKEN, or $MUSE_TOKEN_FILE
 */

import "../src/env.mjs";

import { readFileSync, existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { VoyagerClient } from "../src/voyager.mjs";
import {
  BYTES_PER_AUDIO_SECOND,
  BYTES_PER_CHUNK,
  DEFAULT_MODEL,
  MODE,
  WS_URL,
  padToChunk,
} from "../src/protocol.mjs";
import { createMicCapture, decodeFileToPcm, listDevices } from "../src/mic.mjs";
import { normalizeTranscript } from "../src/text.mjs";

const FINAL_TIMEOUT_MS = 30_000; // app uses a 10 s base, up to 120 s for long audio
const HELP = `muse-dictate — talk to Meta Muse's Voyager ASR endpoint from macOS

Usage:
  muse-dictate [options]

Options:
  --token <t>        Meta access token (default: $MUSE_TOKEN, $META_TOKEN, $MUSE_TOKEN_FILE)
  --model <m>        ASR model (default: ${DEFAULT_MODEL})
  --mode <m>         PUSH_TO_TALK | ENDPOINTING (default: PUSH_TO_TALK)
  --lang <list>      languageBias, comma separated (e.g. en,zh)
  --seconds <n>      record for n seconds instead of waiting for Enter
  --device <d>       ffmpeg avfoundation audio device (default :0)
  --file <path>      transcribe a local audio file instead of the microphone
  --speed <n>        with --file: 相對即時的傳送倍速（預設 4）
  --fast             with --file: 不節流（可能被伺服器截斷）
  --probe            connect + handshake only, print the result and exit
  --json             emit one JSON object per line (no \\r redraw)
  --url <wss>        override the endpoint (default ${WS_URL})
  --list-devices     list avfoundation devices and exit
  --verbose          log every protocol frame
  -h, --help         show this help
`;

function parseArgs(argv) {
  const opts = { mode: MODE.PUSH_TO_TALK, device: ":0", json: false, verbose: false, fast: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    const next = () => {
      const v = argv[++i];
      if (v === undefined) throw new Error(`missing value for ${a}`);
      return v;
    };
    switch (a) {
      case "--token": opts.token = next(); break;
      case "--model": opts.model = next(); break;
      case "--mode": opts.mode = next().toUpperCase(); break;
      case "--lang": opts.lang = next(); break;
      case "--seconds": opts.seconds = Number(next()); break;
      case "--device": opts.device = next(); break;
      case "--file": opts.file = next(); break;
      case "--url": opts.url = next(); break;
      case "--fast": opts.fast = true; break;
      case "--speed": opts.speed = Number(next()); break;
      case "--probe": opts.probe = true; break;
      case "--json": opts.json = true; break;
      case "--verbose": opts.verbose = true; break;
      case "--list-devices": opts.listDevices = true; break;
      case "-h": case "--help": opts.help = true; break;
      default:
        if (a.startsWith("-")) throw new Error(`unknown option ${a}`);
    }
  }
  return opts;
}

function loadToken(explicit) {
  if (explicit) return explicit;
  if (process.env.MUSE_TOKEN) return process.env.MUSE_TOKEN.trim();
  if (process.env.META_TOKEN) return process.env.META_TOKEN.trim();
  const p = process.env.MUSE_TOKEN_FILE || join(homedir(), ".config", "muse-voice", "token");
  if (existsSync(p)) return readFileSync(p, "utf8").trim();
  return null;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TTY = !!process.stdout.isTTY;

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) return console.log(HELP);
  if (opts.listDevices) return console.log(await listDevices());

  const token = loadToken(opts.token);
  if (!token) {
    console.error("no token given. Set MUSE_TOKEN or MUSE_TOKEN_FILE in the environment or .env");
    process.exit(2);
  }

  const client = new VoyagerClient({
    token,
    model: opts.model ?? DEFAULT_MODEL,
    mode: opts.mode,
    languageBias: opts.lang ? opts.lang.split(",").map((s) => s.trim()).filter(Boolean) : [],
    url: opts.url,
    debug: opts.verbose,
  });

  const emit = (event, extra = {}) => {
    if (opts.json) console.log(JSON.stringify({ t: new Date().toISOString(), event, ...extra }));
  };

  let lastPartial = "";
  let printed = false;
  const segments = [];
  let hadError = false;
  let closeInfo = null;

  const closePromise = new Promise((resolve) => client.once("close", resolve));

  client.on("partial", (m) => {
    const text = normalizeTranscript(m.transcript);
    lastPartial = text;
    emit("partial", { text });
    if (!opts.json && TTY) process.stdout.write(`\r\x1b[K${text}`);
  });
  client.on("final", (m) => {
    const text = normalizeTranscript(m.transcript);
    if (text) segments.push(text);
    if (text) printed = true;
    emit("final", { text });
    if (!opts.json) process.stdout.write(`${TTY ? "\r\x1b[K" : ""}${text}\n`);
  });
  client.on("speechStart", (m) => emit("speechStart", m));
  client.on("speechEnd", (m) => emit("speechEnd", m));
  client.on("speechComplete", (m) => {
    if (m.transcript) segments.push(m.transcript);
    if (m.transcript) printed = true;
    emit("speechComplete", m);
    if (!opts.json) process.stdout.write(`${TTY ? "\r\x1b[K" : ""}${m.transcript}\n`);
  });
  client.on("audioDropped", (m) => emit("audioDropped", m));
  client.on("error", (err) => {
    hadError = true;
    emit("error", { code: err.code, message: err.message });
    if (!opts.json) console.error(`\n[voyager error] ${err.code ?? ""} ${err.message}`);
  });
  client.on("close", (info) => {
    closeInfo = info;
  });

  let exitCode = 0;
  try {
    const sessionId = await client.connect();
    emit("ack", { sessionId });

    if (opts.probe) {
      console.error("handshake accepted, sessionId =", sessionId);
      client.close(1000);
      await closePromise;
      return;
    }

    // Stop producing audio as soon as the socket dies, instead of recording into a void.
    const producer = opts.file ? streamFile(client, opts) : streamMic(client, opts, closePromise);
    const early = await Promise.race([producer.then(() => "done"), closePromise.then(() => "closed")]);

    if (early === "closed") {
      if (!opts.json && closeInfo?.code !== 1000) {
        console.error(`\n[socket closed early] code=${closeInfo?.code} reason=${closeInfo?.reason ?? ""}`);
      }
      if (closeInfo?.code !== 1000) exitCode = 1;
    } else {
      client.endStream();
      const info =
        closeInfo ?? (await Promise.race([closePromise, sleep(FINAL_TIMEOUT_MS).then(() => null)]));
      if (!info) {
        console.error(`\n[timeout] no final transcript within ${FINAL_TIMEOUT_MS} ms of endStream`);
        client.close(1000);
        exitCode = 1;
      } else {
        emit("closed", info);
        if (info.code !== 1000) exitCode = 1;
      }
    }
  } catch (err) {
    console.error(`\n[failed] ${err.code ?? err.name}: ${err.message}`);
    exitCode = 1;
    client.close(1000);
  }

  if (hadError) exitCode = 1;

  const text = normalizeTranscript(segments.length ? segments.join(" ") : lastPartial);
  if (opts.json) {
    console.log(JSON.stringify({ event: "result", text }));
  } else if (!printed) {
    // 串流時已經印過就不再印一次
    if (text) console.log(text);
    else console.error("[no transcript]");
  }
  if (!text) exitCode = exitCode || 1;

  // readline / SIGINT listeners would otherwise keep the event loop alive
  process.exit(exitCode);
}

async function streamMic(client, opts, closePromise) {
  const capture = createMicCapture({ device: opts.device });
  capture.onChunk((frame) => client.pushPcm(frame));
  capture.start();
  console.error("● recording — press Enter to stop");

  const rl = process.stdin.isTTY ? createInterface({ input: process.stdin, output: process.stderr }) : null;
  const triggers = [];
  if (opts.seconds) triggers.push(sleep(opts.seconds * 1000).then(() => "seconds"));
  if (rl) triggers.push(new Promise((resolve) => rl.once("line", () => resolve("enter"))));
  triggers.push(new Promise((resolve) => process.once("SIGINT", () => resolve("sigint"))));
  triggers.push(closePromise.then(() => "closed"));

  const reason = await Promise.race(triggers);
  if (rl) rl.close();
  await capture.stop();
  if (reason === "closed") return;
  console.error("■ stopped, waiting for the final transcript…");
}

async function streamFile(client, opts) {
  const pcm = await decodeFileToPcm(opts.file);
  const totalMs = Math.round((pcm.length / BYTES_PER_AUDIO_SECOND) * 1000);
  console.error(`● file ${opts.file}: ${totalMs} ms of 24 kHz mono PCM`);

  const start = Date.now();
  const speed = opts.fast ? Infinity : (opts.speed ?? Number(process.env.MUSE_SPEED || 4));
  let sent = 0;
  for (let off = 0; off < pcm.length; off += BYTES_PER_CHUNK) {
    if (client.closed) return;
    // pad the tail so every uplink frame is exactly 20 ms
    const frame = padToChunk(pcm.subarray(off, off + BYTES_PER_CHUNK));
    client.pushPcm(frame);
    sent += frame.length;
    if (Number.isFinite(speed) && speed > 0) {
      const dueAt = start + (sent / BYTES_PER_AUDIO_SECOND / speed) * 1000;
      const wait = dueAt - Date.now();
      if (wait > 0) await sleep(wait);
    }
  }
  console.error("■ file fully sent, waiting for the final transcript…");
}

main();
