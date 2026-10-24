#!/usr/bin/env node
/**
 * asr-transcribe-server — OpenAI-compatible transcription API backed by Meta Muse's
 * Voyager ASR endpoint and ElevenLabs Scribe V2.
 *
 *   POST /v1/audio/transcriptions   (multipart/form-data, field `file`)
 *   POST /v1/audio/translations     (501 — Muse only transcribes)
 *   GET  /v1/models
 *   GET  /health
 *
 * 輸出已正規化：簡體 → 繁體（台灣用語）、去掉結尾句點。
 *
 * 直接跑：  node server.mjs
 * pm2：     pm2 start ecosystem.config.cjs
 */

import "./src/env.mjs";

import { createServer } from "node:http";
import { createWriteStream } from "node:fs";
import { pipeline } from "node:stream/promises";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Busboy from "busboy";

import { transcribe } from "./src/transcribe.mjs";
import { isScribeModel, SCRIBE_MODEL, transcribeElevenLabs } from "./src/elevenlabs.mjs";
import { attachVolcengineWs } from "./src/volcengine-ws.mjs";
import { decodeToPcmChunks } from "./src/mic.mjs";
import { guessLanguage } from "./src/text.mjs";
import { BYTES_PER_AUDIO_SECOND, DEFAULT_MODEL, MODE } from "./src/protocol.mjs";

const PORT = Number(process.env.PORT || 8791);
const HOST = process.env.HOST || "127.0.0.1";
const API_KEY = process.env.MUSE_API_KEY?.trim();
if (!API_KEY) throw new Error("MUSE_API_KEY must be set in the environment or .env");
const TOKEN_FILE = process.env.MUSE_TOKEN_FILE || join(process.env.HOME || "", ".config/muse-voice/token");
const MAX_UPLOAD = Number(process.env.MUSE_MAX_UPLOAD || 200 * 1024 * 1024);
const MAX_AUDIO_SECONDS = Number(process.env.MUSE_MAX_AUDIO_SECONDS || 600);
const SPEED = Number(process.env.MUSE_SPEED || 4);
const MODEL_NAME = process.env.MUSE_MODEL || DEFAULT_MODEL;
const MODE_DEFAULT = (process.env.MUSE_MODE || MODE.PUSH_TO_TALK).toUpperCase();

let cachedToken = null;

async function getToken() {
  if (process.env.MUSE_TOKEN) return process.env.MUSE_TOKEN.trim();
  try {
    const t = (await readFile(TOKEN_FILE, "utf8")).trim();
    if (t) return t;
  } catch {}
  return null;
}

// 每次請求都重讀檔案，這樣重抓 token 之後不用重啟
async function tokenForRequest() {
  if (process.env.MUSE_TOKEN) return process.env.MUSE_TOKEN.trim();
  const fresh = (await getToken()) ?? cachedToken;
  cachedToken = fresh;
  return fresh;
}

function sendJson(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "content-length": Buffer.byteLength(payload),
    "access-control-allow-origin": "*",
    ...headers,
  });
  res.end(payload);
}

function sendText(res, status, body, contentType = "text/plain; charset=utf-8") {
  res.writeHead(status, {
    "content-type": contentType,
    "content-length": Buffer.byteLength(body),
    "access-control-allow-origin": "*",
  });
  res.end(body);
}

function openaiError(res, status, message, type = "invalid_request_error", code = null) {
  sendJson(res, status, { error: { message, type, code, param: null } });
}

/** multipart 解析：把 file 欄位寫到暫存檔，其餘欄位收成物件 */
function parseMultipart(req, dir) {
  return new Promise((resolve, reject) => {
    let bb;
    try {
      bb = Busboy({ headers: req.headers, limits: { fileSize: MAX_UPLOAD, files: 1 } });
    } catch (err) {
      return reject(Object.assign(err, { status: 400, hint: "expect multipart/form-data with a file field" }));
    }
    const fields = {};
    const pending = [];
    let tooBig = false;
    let fileSeq = 0;

    bb.on("file", (name, stream, info) => {
      const path = join(dir, `in-${fileSeq++}-${(info.filename || "audio").replace(/[^\w.-]/g, "_")}`);
      stream.on("limit", () => {
        tooBig = true;
        stream.destroy();
      });
      const done = pipeline(stream, createWriteStream(path)).then(() => ({
        field: name,
        path,
        filename: info.filename,
        mime: info.mimeType,
      }));
      pending.push(done);
    });
    bb.on("field", (name, value) => {
      if (/^timestamp_granularities/.test(name)) return;
      fields[name] = value;
    });
    bb.on("error", reject);
    bb.on("close", async () => {
      try {
        const files = await Promise.all(pending);
        if (tooBig) return reject(Object.assign(new Error("file too large"), { status: 413 }));
        if (files.length === 0) return reject(Object.assign(new Error("missing file field"), { status: 400 }));
        resolve({ fields, file: files[0] });
      } catch (err) {
        reject(err);
      }
    });
    req.pipe(bb);
  });
}

const pad = (n, w = 2) => String(n).padStart(w, "0");

function srtTime(ms) {
  const h = Math.floor(ms / 3_600_000);
  const m = Math.floor((ms % 3_600_000) / 60_000);
  const s = Math.floor((ms % 60_000) / 1000);
  const t = ms % 1000;
  return `${pad(h)}:${pad(m)}:${pad(s)},${pad(t, 3)}`;
}

function vttTime(ms) {
  return srtTime(ms).replace(",", ".");
}

function renderBody(format, { text, durationMs, language }) {
  switch (format) {
    case "text":
      return { type: "text/plain; charset=utf-8", body: text + "\n" };
    case "srt":
      return {
        type: "application/x-subrip; charset=utf-8",
        body: `1\n${srtTime(0)} --> ${srtTime(durationMs)}\n${text}\n`,
      };
    case "vtt":
      return {
        type: "text/vtt; charset=utf-8",
        body: `WEBVTT\n\n00:00:00.000 --> ${vttTime(durationMs)}\n${text}\n`,
      };
    case "verbose_json":
      return {
        type: "application/json; charset=utf-8",
        body: JSON.stringify({
          task: "transcribe",
          language,
          duration: Number((durationMs / 1000).toFixed(3)),
          text,
          segments: [
            {
              id: 0,
              seek: 0,
              start: 0,
              end: Number((durationMs / 1000).toFixed(3)),
              text: ` ${text}`,
              tokens: [],
              temperature: 0,
              avg_logprob: 0,
              compression_ratio: 1,
              no_speech_prob: 0,
            },
          ],
        }),
      };
    default:
      return { type: "application/json; charset=utf-8", body: JSON.stringify({ text }) };
  }
}

async function handleTranscription(req, res, startedAt) {
  const dir = await mkdtemp(join(tmpdir(), "muse-asr-"));
  let fields = {};
  let file = null;
  try {
    ({ fields, file } = await parseMultipart(req, dir));

    const useScribe = isScribeModel(fields.model);
    const token = useScribe ? process.env.ELEVENLABS_API_KEY?.trim() : await tokenForRequest();
    if (!token) {
      return openaiError(res, 503,
        useScribe ? "no ElevenLabs token configured (set ELEVENLABS_API_KEY)" : "no Muse token configured (set MUSE_TOKEN or MUSE_TOKEN_FILE)",
        "server_error", useScribe ? "no_elevenlabs_token" : "no_token");
    }
    const format = (fields.response_format || "json").toLowerCase();
    const speed = Number(fields.speed ?? SPEED) || SPEED;

    // 邊解邊送：ffmpeg 的 stdout 直接餵給 Voyager，decode 跟網路重疊
    const limitBytes = MAX_AUDIO_SECONDS * BYTES_PER_AUDIO_SECOND;
    let seenBytes = 0;
    async function* guarded() {
      for await (const chunk of decodeToPcmChunks(file.path)) {
        seenBytes += chunk.length;
        if (seenBytes > limitBytes) {
          throw Object.assign(new Error(`audio too long (> ${MAX_AUDIO_SECONDS}s)`), {
            status: 413,
            code: "audio_too_long",
          });
        }
        yield chunk;
      }
    }

    const result = useScribe ? await transcribeElevenLabs({
      source: guarded(),
      token,
      language: fields.language,
    }) : await transcribe({
      sourceFactory: () => guarded(),
      token,
      model: MODEL_NAME,
      mode: (fields.mode || MODE_DEFAULT).toUpperCase(),
      languageBias: fields.language ? [fields.language] : [],
      speed,
    });

    const text = result.text;
    const language = guessLanguage(text, fields.language);
    const out = renderBody(format, { text, durationMs: result.audioMs, language });

    res.museInfo = {
      route: "transcriptions",
      provider: useScribe ? "elevenlabs" : "muse",
      model: useScribe ? SCRIBE_MODEL : MODEL_NAME,
      audioSec: Number((result.audioMs / 1000).toFixed(2)),
      speed,
      chars: text.length,
      session: result.sessionId,
      format,
      close: result.closeCode,
      requestedModel: fields.model || null,
      timing: result.timing,
      attempts: result.attempts || undefined,
    };

    res.writeHead(200, {
      "content-type": out.type,
      "content-length": Buffer.byteLength(out.body),
      "access-control-allow-origin": "*",
      "x-muse-session": result.sessionId || "",
      "x-muse-audio-ms": String(result.audioMs),
    });
    res.end(out.body);
  } catch (err) {
    const status = err.status || 500;
    const code = err.code || null;
    console.error(
      JSON.stringify({ t: new Date().toISOString(), route: "transcriptions", error: err.message, code }),
    );
    if (!res.headersSent) {
      if (code === "invalid_api_key" || /Unauthorized/i.test(err.message || "")) {
        return openaiError(
          res,
          401,
          "Muse rejected the token (ABRA token expired?) — refresh MUSE_TOKEN or MUSE_TOKEN_FILE",
          "authentication_error",
          "invalid_api_key",
        );
      }
      openaiError(res, status, err.message || "transcription failed", "server_error", code);
    }
  } finally {
    if (file?.path) rm(file.path, { force: true }).catch(() => {});
    rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

const server = createServer(async (req, res) => {
  const startedAt = Date.now();
  const url = new URL(req.url, `http://${req.headers.host || "localhost"}`);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const bare = path.replace(/^\/v1(?=\/|$)/, "") || "/";

  // 每個請求都留一行（含 401 / 404），不然「有沒有打進來」永遠看不出來
  res.museInfo = null;
  res.on("finish", () => {
    console.log(
      JSON.stringify({
        t: new Date().toISOString(),
        method: req.method,
        path,
        status: res.statusCode,
        ms: Date.now() - startedAt,
        auth: req.headers.authorization ? "sent" : "none",
        ua: (req.headers["user-agent"] || "").slice(0, 48),
        ip: req.socket.remoteAddress,
        ...(res.museInfo || {}),
      }),
    );
  });

  if (req.method === "OPTIONS") {
    res.writeHead(204, {
      "access-control-allow-origin": "*",
      "access-control-allow-headers": "authorization, content-type",
      "access-control-allow-methods": "POST, GET, OPTIONS",
      "access-control-max-age": "86400",
    });
    return res.end();
  }

  if (req.method === "GET" && (path === "/health" || path === "/healthz")) {
    const token = await getToken();
    return sendJson(res, 200, {
      ok: true,
      service: "asr-transcribe-server",
      model: MODEL_NAME,
      mode: MODE_DEFAULT,
      token: token ? "present" : "missing",
      opencc: process.env.OPENCC_TARGET || "twp",
      speed: SPEED,
    });
  }

  // 給人看的索引頁：不用 key，瀏覽器直接打開不會只看到 401
  if (req.method === "GET" && (path === "/" || path === "/v1")) {
    return sendJson(res, 200, {
      ok: true,
      service: "asr-transcribe-server",
      message: "OpenAI-compatible transcription API. 實際打的是 /v1/audio/transcriptions，要帶 Bearer key。",
      auth: 'Authorization: Bearer <MUSE_API_KEY>',
      endpoints: {
        "POST /v1/audio/transcriptions": "multipart/form-data: file, model(含 scribe 不分大小寫 → ElevenLabs Scribe V2；其餘 → Muse), language, response_format",
        "POST /v1/audio/translations": "501",
        "GET /v1/models": "list",
        "GET /health": "no auth",
      },
      model: MODEL_NAME,
      opencc: process.env.OPENCC_TARGET || "twp",
    });
  }

  // API key is required at startup for HTTP and WebSocket authentication.
  if (API_KEY) {
    const hdr = req.headers.authorization || "";
    const given = hdr.replace(/^Bearer\s+/i, "").trim();
    if (given !== API_KEY) {
      return openaiError(res, 401, "invalid api key", "authentication_error", "invalid_api_key");
    }
  }

  if (req.method === "GET" && bare === "/models") {
    // Model aliases keep using Muse unless the name contains "scribe".
    return sendJson(res, 200, {
      object: "list",
      data: ["whisper-1", "gpt-4o-transcribe", "gpt-4o-mini-transcribe", MODEL_NAME, SCRIBE_MODEL].map((id) => ({
        id,
        object: "model",
        created: 0,
        owned_by: isScribeModel(id) ? "elevenlabs" : "meta-muse",
      })),
    });
  }

  // 任何 model id 都回 200 —— 有些 client / UI 會先 GET 一次確認存在
  const modelMatch = bare.match(/^\/models\/(.+)$/);
  if (req.method === "GET" && modelMatch) {
    return sendJson(res, 200, {
      id: decodeURIComponent(modelMatch[1]),
      object: "model",
      created: 0,
      owned_by: isScribeModel(decodeURIComponent(modelMatch[1])) ? "elevenlabs" : "meta-muse",
    });
  }

  if (req.method === "POST" && bare === "/audio/transcriptions") {
    return handleTranscription(req, res, startedAt);
  }
  if (req.method === "POST" && bare === "/audio/translations") {
    return openaiError(res, 501, "Muse only transcribes; translations are not supported", "invalid_request_error", "not_supported");
  }

  openaiError(res, 404, `no route for ${req.method} ${path}`, "invalid_request_error", "not_found");
});

attachVolcengineWs(server, {
  getToken: tokenForRequest,
  model: MODEL_NAME,
  apiKey: API_KEY,
  log: (line) => console.log(line),
});

server.listen(PORT, HOST, () => {
  console.log(JSON.stringify({ t: new Date().toISOString(), msg: "listening", host: HOST, port: server.address().port, model: MODEL_NAME }));
});

for (const sig of ["SIGINT", "SIGTERM"]) {
  process.on(sig, () => {
    console.log(JSON.stringify({ t: new Date().toISOString(), msg: "shutting down", sig }));
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
