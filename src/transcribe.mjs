/**
 * 共用轉錄核心：一段 24 kHz / mono / s16le PCM（Buffer 或 async iterable）-> 文字。
 *
 * 速度上的取捨（實測 26.45 秒音檔，ENDPOINTING）：
 *   1x  28.3s  2x  14.8s  3x  10.6s  4x  8.5s  6x  6.3s(開始出現重複字)  10x  3.6s(被截斷, close 1008)
 * 所以預設 4x：夠快、逐字稿完整、不會重複。出錯（1008 / 逾時）會自動降速重試。
 *
 * 併發：不等待 handshake ack 就開始送（client 會先緩衝 4 秒），
 * 這樣 connect 的 RTT 跟音訊上傳重疊，省掉一個往返。
 */

import { VoyagerClient } from "./voyager.mjs";
import { BYTES_PER_AUDIO_SECOND, BYTES_PER_CHUNK, DEFAULT_MODEL, MODE, padToChunk } from "./protocol.mjs";
import { normalizeTranscript } from "./text.mjs";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const RETRYABLE = new Set(["1008", "timeout", "socket_failure", "audio_queue_overflow"]);

function chunkSource(source) {
  if (source == null) throw Object.assign(new Error("empty audio"), { code: "empty_audio" });
  if (Buffer.isBuffer(source) || source instanceof Uint8Array) {
    return (async function* () {
      yield Buffer.from(source);
    })();
  }
  if (typeof source[Symbol.asyncIterator] === "function") return source;
  throw Object.assign(new Error("source must be a Buffer or async iterable"), { code: "bad_source" });
}

async function runOnce({
  source,
  token,
  model,
  mode,
  languageBias,
  speed,
  timeoutMs,
  onPartial,
  onFirstChunk,
}) {
  const startedAt = Date.now();
  const client = new VoyagerClient({ token, model, mode, languageBias });
  const segments = [];
  let partial = "";
  let closeInfo = null;

  const closePromise = new Promise((resolve) => client.once("close", resolve));
  client.on("close", (info) => {
    closeInfo = info;
  });
  client.on("partial", (m) => {
    partial = m.transcript || partial;
    onPartial?.(m.transcript || "");
  });
  client.on("final", (m) => {
    if (m.transcript) segments.push(m.transcript);
  });
  client.on("speechComplete", (m) => {
    if (m.transcript) segments.push(m.transcript);
  });
  client.on("error", () => {});

  // 不等 ack 就開始送：VoyagerClient 會先把音訊緩衝起來（上限 4 秒）
  let ackAt = null;
  const connectPromise = client.connect().then((sid) => {
    ackAt = Date.now();
    return sid;
  });
  connectPromise.catch(() => {});

  const splitter = createSplitter();
  let sentBytes = 0;
  let sendStartedAt = null;
  let firstChunkAt = null;

  const pushFrame = async (frame) => {
    if (client.closed) return;
    if (sendStartedAt === null) sendStartedAt = Date.now();
    client.pushPcm(frame);
    sentBytes += frame.length;
    if (speed > 0 && Number.isFinite(speed)) {
      const dueAt = sendStartedAt + (sentBytes / BYTES_PER_AUDIO_SECOND / speed) * 1000;
      const wait = dueAt - Date.now();
      if (wait > 1) await sleep(wait);
    }
  };

  const closeError = () =>
    Object.assign(new Error(`voyager closed ${closeInfo?.code} ${closeInfo?.reason || ""}`.trim()), {
      code: String(closeInfo?.code ?? "closed"),
      retryable: true,
    });

  try {
    for await (const chunk of chunkSource(source)) {
      if (client.closed) break;
      if (firstChunkAt === null) {
        firstChunkAt = Date.now();
        onFirstChunk?.(firstChunkAt - startedAt);
      }
      for (const frame of splitter.push(chunk)) await pushFrame(frame);
    }
    if (!client.closed) for (const frame of splitter.flush()) await pushFrame(frame);
  } catch (err) {
    // 伺服器先關了連線時，解碼端的錯誤沒有意義，讓 close code 決定
    if (!client.closed) {
      client.close(1000);
      throw err;
    }
  }

  const sendDoneAt = Date.now();

  // 連線在 ack 前就斷：用 close code 當錯誤（可重試），不要回報 closed_before_ack
  if (!client.acked && closeInfo && closeInfo.code !== 1000) throw closeError();

  const sessionId = await connectPromise; // 真正的 handshake 錯誤會在這裡爆
  if (!client.closed) client.endStream();

  const info = closeInfo ?? (await Promise.race([closePromise, sleep(timeoutMs).then(() => null)]));
  const finishedAt = Date.now();
  if (!info) {
    client.close(1000);
    throw Object.assign(new Error(`no final transcript within ${timeoutMs}ms`), { code: "timeout", retryable: true });
  }

  const rawText = segments.length > 0 ? segments.join(" ") : partial;
  const result = {
    text: normalizeTranscript(rawText),
    rawText,
    segments,
    audioMs: Math.round((sentBytes / BYTES_PER_AUDIO_SECOND) * 1000),
    bytesSent: sentBytes,
    sessionId,
    closeCode: info.code,
    closeReason: info.reason,
    timing: {
      firstChunkMs: firstChunkAt ? firstChunkAt - startedAt : null,
      ackMs: ackAt ? ackAt - startedAt : null,
      sendMs: sendDoneAt - (sendStartedAt ?? startedAt),
      drainMs: finishedAt - sendDoneAt,
      totalMs: finishedAt - startedAt,
    },
  };

  // 被伺服器判定超速（1008）或整段沒東西，就讓上層降速重試
  if (info.code !== 1000 || !result.text) {
    const err = Object.assign(new Error(`voyager closed ${info.code} ${info.reason || ""}`.trim()), {
      code: String(info.code),
      retryable: true,
      result,
    });
    throw err;
  }
  return result;
}

function createSplitter() {
  let rest = Buffer.alloc(0);
  return {
    push(buf) {
      rest = rest.length ? Buffer.concat([rest, buf]) : buf;
      const frames = [];
      while (rest.length >= BYTES_PER_CHUNK) {
        frames.push(rest.subarray(0, BYTES_PER_CHUNK));
        rest = rest.subarray(BYTES_PER_CHUNK);
      }
      return frames;
    },
    flush() {
      const tail = rest;
      rest = Buffer.alloc(0);
      return tail.length ? [padToChunk(tail, BYTES_PER_CHUNK)] : [];
    },
  };
}

/**
 * @param {object} opts
 * @param {Buffer|AsyncIterable<Buffer>} opts.source  24 kHz mono s16le
 * @param {string} opts.token
 * @param {string} [opts.model]
 * @param {string} [opts.mode]            PUSH_TO_TALK | ENDPOINTING
 * @param {number} [opts.speed]           相對即時倍速，預設 4
 * @param {number} [opts.retries]         失敗降速重試次數，預設 1
 * @param {(ms:number)=>void} [opts.onFirstChunk]
 */
export async function transcribe({
  source,
  sourceFactory,
  token,
  model = DEFAULT_MODEL,
  mode = MODE.PUSH_TO_TALK,
  languageBias = [],
  speed = Number(process.env.MUSE_SPEED || 4),
  timeoutMs = Number(process.env.MUSE_TIMEOUT_MS || 120_000),
  retries = Number(process.env.MUSE_RETRIES ?? 1),
  onPartial,
  onFirstChunk,
  raw = false,
}) {
  if (!token) throw Object.assign(new Error("missing token"), { code: "missing_token" });
  if (!source && typeof sourceFactory !== "function") {
    throw Object.assign(new Error("empty audio"), { code: "empty_audio" });
  }
  // 每次嘗試都要拿到全新的來源（ffmpeg 產生的 async iterator 不能重讀）
  const makeSource = typeof sourceFactory === "function" ? sourceFactory : () => source;

  let attempt = 0;
  let currentSpeed = speed;
  const attempts = [];
  for (;;) {
    try {
      const result = await runOnce({
        source: makeSource(),
        token,
        model,
        mode,
        languageBias,
        speed: currentSpeed,
        timeoutMs,
        onPartial,
        onFirstChunk,
      });
      if (attempts.length) result.attempts = attempts;
      if (raw) return { ...result, text: result.rawText };
      return result;
    } catch (err) {
      const canRetry = attempt < retries && (err.retryable || RETRYABLE.has(String(err.code)));
      if (!canRetry) {
        if (err.result && attempts.length) {
          err.result.attempts = attempts;
          return raw ? { ...err.result, text: err.result.rawText } : err.result;
        }
        throw err;
      }
      attempts.push({ speed: currentSpeed, code: String(err.code), ms: err.result?.timing?.totalMs });
      attempt += 1;
      currentSpeed = Math.max(1, currentSpeed / 2);
    }
  }
}

/** 便利函式：直接吃一個完整 Buffer */
export function transcribePcm(opts) {
  return transcribe({ ...opts, source: opts.pcm ?? opts.source });
}

/** 便利函式：吃一個「會回傳 PCM 串流」的工廠（重試時可重新產生） */
export function transcribeFactory(opts) {
  return transcribe(opts);
}
