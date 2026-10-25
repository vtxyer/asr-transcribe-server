/**
 * 豆包輸入法（Doubao IME）語音輸入的 ASR 後端。
 *
 * 逆向自官方客戶端（macOS/Android），協定重點：
 *   - 裝置註冊：POST https://log.snssdk.com/service/2/device_register/  → device_id / install_id
 *   - 取 token ：POST https://is.snssdk.com/service/settings/v3/         → settings.asr_config.app_key
 *   - ASR 串流 ：WSS wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws?aid=401734&device_id=...
 *                header: proto-version: v2 / x-custom-keepalive: true
 *                封包：protobuf AsrRequest（binary frame），流程
 *                  StartTask → StartSession(JSON) → TaskRequest×N(Opus 20ms) → FinishSession
 *                回應：protobuf AsrResponse，message_type = TaskStarted / SessionStarted /
 *                  SessionFinished / TaskFailed / SessionFailed，欄位 7 是結果 JSON。
 *
 * 不需要登入帳號，裝置註冊是匿名的；憑證會快取在 credentialPath。
 *
 * 走這條路的條件跟 Scribe 一樣看 model 名稱：含 "doubao" 就來這裡。
 * 對外介面也刻意跟 elevenlabs.mjs 一致：吃 24 kHz mono s16le 的 async iterable，
 * 內部降到 16 kHz 再編成 Opus。
 */

import { createHash, randomUUID, randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { homedir } from "node:os";

import { normalizeTranscript } from "./text.mjs";

export const DOUBAO_MODEL = "doubao_ime";
export const isDoubaoModel = (model) => /doubao/i.test(model || "");

// ── 客戶端常數（照抄官方 Android 客戶端） ─────────────────────────────
const AID = 401734;
const VERSION_CODE = 100_502_008;
const VERSION_NAME = "1.5.2";
const UA = `com.bytedance.android.doubaoime/${VERSION_CODE} (Linux; U; Android 16; en_US; Pixel 7 Pro; Build/BP2A.250605.031.A2; Cronet/TTNetVersion:94cf429a 2025-11-17 QuicVersion:1f89f732 2025-05-08)`;

const REGISTER_URL = "https://log.snssdk.com/service/2/device_register/";
const SETTINGS_URL = "https://is.snssdk.com/service/settings/v3/";
const WS_URL = "wss://frontier-audio-ime-ws.doubao.com/ocean/api/v1/ws";

const APP_NAME = "oime";
const APP_PACKAGE = "com.bytedance.android.doubaoime";
const CHANNEL = "official";

const DEVICE = {
  device_platform: "android",
  os: "android",
  os_api: "34",
  os_version: "16",
  device_type: "Pixel 7 Pro",
  device_brand: "google",
  device_model: "Pixel 7 Pro",
  resolution: "1080*2400",
  dpi: "420",
  language: "zh",
  timezone: 8,
  access: "wifi",
  rom: "UP1A.231005.007",
  rom_version: "UP1A.231005.007",
};

// ── 串流參數 ───────────────────────────────────────────────────────
const IN_RATE = 24_000; // 進來的是 Voyager 那條路的音訊
const SR = 16_000; // 豆包只收 16 kHz
const FRAME_MS = 20;
const SPF = (SR * FRAME_MS) / 1000; // 320 samples
const BPF = SPF * 2; // 640 bytes

export const DEFAULT_CREDENTIAL_PATH = join(homedir(), ".config", "doubao-ime", "cred.json");

// ── 極簡 protobuf ──────────────────────────────────────────────────
function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}
const tag = (field, wire) => varint((field << 3) | wire);
const pbString = (field, s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([tag(field, 2), varint(b.length), b]);
};
const pbBytes = (field, b) => Buffer.concat([tag(field, 2), varint(b.length), b]);
const pbInt = (field, n) => Buffer.concat([tag(field, 0), varint(n)]);

export const FRAME_STATE = Object.freeze({ FIRST: 1, MIDDLE: 3, LAST: 9 });

/** AsrRequest：token=2 service_name=3 method_name=5 payload=6 audio_data=7 request_id=8 frame_state=9 */
export function encodeAsrRequest({ token, serviceName = "ASR", methodName, payload, audioData, requestId, frameState }) {
  const parts = [];
  if (token != null) parts.push(pbString(2, token));
  if (serviceName) parts.push(pbString(3, serviceName));
  if (methodName) parts.push(pbString(5, methodName));
  if (payload != null) parts.push(pbString(6, payload));
  if (audioData) parts.push(pbBytes(7, audioData));
  if (requestId) parts.push(pbString(8, requestId));
  if (frameState != null) parts.push(pbInt(9, frameState));
  return Buffer.concat(parts);
}

/** AsrResponse：request_id=1 task_id=2 service_name=3 message_type=4 status_code=5 status_message=6 result_json=7 */
export function decodeAsrResponse(buf) {
  const out = {};
  const textFields = new Set([1, 2, 3, 4, 6, 7]);
  let i = 0;
  const readVarint = () => {
    let r = 0;
    let shift = 0;
    let b;
    do {
      b = buf[i++];
      r += (b & 0x7f) * 2 ** shift;
      shift += 7;
    } while (b & 0x80);
    return r;
  };
  while (i < buf.length) {
    const key = readVarint();
    const field = key >> 3;
    const wire = key & 7;
    if (wire === 0) out[field] = readVarint();
    else if (wire === 2) {
      const len = readVarint();
      const slice = buf.subarray(i, i + len);
      i += len;
      out[field] = textFields.has(field) ? slice.toString("utf8") : slice;
    } else if (wire === 5) i += 4;
    else if (wire === 1) i += 8;
    else break;
  }
  return out;
}

// ── 24k → 16k（線性插值；演算法跟 protocol.mjs 的 Upsampler 同一套） ──
export class Resampler {
  constructor(inRate = IN_RATE, outRate = SR) {
    this.ratio = outRate / inRate; // 16/24 = 0.667
    this.step = 1 / this.ratio; // 1.5
    this.frac = 0;
    this.prev = 0;
    this.leftover = Buffer.alloc(0);
  }

  process(chunk) {
    let buf = chunk;
    if (this.leftover.length) buf = Buffer.concat([this.leftover, chunk]);
    // 只處理完整的 16-bit sample，剩下的留到下一批
    const odd = buf.length % 2;
    this.leftover = odd ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
    const samples = (buf.length - odd) / 2;
    if (samples === 0) return Buffer.alloc(0);

    const out = Buffer.alloc(Math.ceil(samples * this.ratio + 4) * 2);
    let o = 0;
    for (let i = 0; i < samples; i++) {
      const cur = buf.readInt16LE(i * 2);
      while (this.frac < 1) {
        // 註：prev 只在第一批是 0，之後就是上一個 sample 的值
        const v = this.prev + (cur - this.prev) * this.frac;
        out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(v))), o);
        o += 2;
        this.frac += this.step;
      }
      this.frac -= 1;
      this.prev = cur;
    }
    return o ? out.subarray(0, o) : Buffer.alloc(0);
  }
}

// ── 憑證 ───────────────────────────────────────────────────────────
async function registerDevice() {
  const cdid = randomUUID();
  const openudid = randomBytes(8).toString("hex");
  const clientudid = randomUUID();

  const header = {
    device_id: 0,
    install_id: 0,
    aid: AID,
    app_name: APP_NAME,
    version_code: VERSION_CODE,
    version_name: VERSION_NAME,
    manifest_version_code: VERSION_CODE,
    update_version_code: VERSION_CODE,
    channel: CHANNEL,
    package: APP_PACKAGE,
    ...DEVICE,
    openudid,
    clientudid,
    cdid,
    region: "CN",
    tz_name: "Asia/Shanghai",
    tz_offset: 28800,
    sim_region: "cn",
    carrier_region: "cn",
    cpu_abi: "arm64-v8a",
    build_serial: "unknown",
    not_request_sender: 0,
    sig_hash: "",
    google_aid: "",
    mc: "",
    serial_number: "",
  };

  const params = new URLSearchParams({
    device_platform: DEVICE.device_platform,
    os: DEVICE.os,
    ssmix: "a",
    _rticket: String(Date.now()),
    cdid,
    channel: CHANNEL,
    aid: String(AID),
    app_name: APP_NAME,
    version_code: String(VERSION_CODE),
    version_name: VERSION_NAME,
    manifest_version_code: String(VERSION_CODE),
    update_version_code: String(VERSION_CODE),
    resolution: DEVICE.resolution,
    dpi: DEVICE.dpi,
    device_type: DEVICE.device_type,
    device_brand: DEVICE.device_brand,
    language: DEVICE.language,
    os_api: DEVICE.os_api,
    os_version: DEVICE.os_version,
    ac: "wifi",
  });

  const res = await fetch(`${REGISTER_URL}?${params}`, {
    method: "POST",
    headers: { "user-agent": UA, "content-type": "application/json" },
    body: JSON.stringify({ magic_tag: "ss_app_log", header, _gen_time: Date.now() }),
  });
  if (!res.ok) throw Object.assign(new Error(`device_register HTTP ${res.status}`), { code: "doubao_register_failed" });
  const json = await res.json();
  if (!json?.device_id) throw Object.assign(new Error(`device_register: ${JSON.stringify(json).slice(0, 200)}`), { code: "doubao_register_failed" });

  return {
    device_id: String(json.device_id),
    install_id: String(json.install_id ?? ""),
    cdid,
    openudid,
    clientudid,
    token: "",
  };
}

async function fetchAsrToken(deviceId, cdid) {
  const params = new URLSearchParams({
    device_platform: DEVICE.device_platform,
    os: DEVICE.os,
    ssmix: "a",
    _rticket: String(Date.now()),
    cdid,
    channel: CHANNEL,
    aid: String(AID),
    app_name: APP_NAME,
    version_code: String(VERSION_CODE),
    version_name: VERSION_NAME,
    device_id: deviceId,
  });
  const body = "body=null";
  const stub = createHash("md5").update(body).digest("hex").toUpperCase();
  const res = await fetch(`${SETTINGS_URL}?${params}`, {
    method: "POST",
    headers: {
      "user-agent": UA,
      "x-ss-stub": stub,
      "content-type": "application/x-www-form-urlencoded",
    },
    body,
  });
  if (!res.ok) throw Object.assign(new Error(`settings HTTP ${res.status}`), { code: "doubao_token_failed" });
  const json = await res.json();
  const token = json?.data?.settings?.asr_config?.app_key;
  if (!token) throw Object.assign(new Error("settings: asr_config.app_key missing"), { code: "doubao_token_failed" });
  return token;
}

/**
 * 憑證管理：檔案不存在就註冊新裝置；token 空就抓一次。
 * 每次轉錄都重讀檔案，所以手動換 token 不用重啟（跟 muse 的 token 檔一樣的套路）。
 */
export async function ensureCredentials(credentialPath = DEFAULT_CREDENTIAL_PATH) {
  let cred = null;
  try {
    cred = JSON.parse(await readFile(credentialPath, "utf8"));
  } catch {}

  let dirty = false;
  if (!cred?.device_id) {
    cred = await registerDevice();
    dirty = true;
  }
  if (!cred.token) {
    cred.token = await fetchAsrToken(cred.device_id, cred.cdid ?? randomUUID());
    dirty = true;
  }
  if (dirty) {
    await mkdir(dirname(credentialPath), { recursive: true });
    await writeFile(credentialPath, JSON.stringify(cred, null, 2), { mode: 0o600 });
  }
  return cred;
}

// ── Opus 編碼器（純 JS，不需要編譯原生模組） ─────────────────────────
let opusModPromise = null;
async function loadOpus() {
  if (!opusModPromise) {
    opusModPromise = import("opusscript").then((m) => m.default ?? m);
  }
  return opusModPromise;
}

export async function createOpusEncoder(sampleRate = SR, channels = 1) {
  const OpusScript = await loadOpus();
  const encoder = new OpusScript(sampleRate, channels, OpusScript.Application.AUDIO);
  return {
    encode(frame, samples = SPF) {
      const out = encoder.encode(frame, samples);
      return Buffer.from(out);
    },
    close() {
      try {
        encoder.delete?.();
      } catch {}
    },
  };
}

// ── 主流程 ─────────────────────────────────────────────────────────
/** 單次嘗試：憑證已備妥，只負責連線、送音訊、收結果。 */
async function runOnce({ source, cred, onPartial, timeoutMs = 120_000, realtime = false, session = {} }) {
  const { default: WebSocket } = await import("ws");
  const encoder = await createOpusEncoder();

  const { token } = cred;
  const requestId = randomUUID();
  const sessionConfig = {
    audio_info: { channel: 1, format: "speech_opus", sample_rate: SR },
    enable_punctuation: true,
    enable_speech_rejection: false,
    extra: {
      app_name: "com.android.chrome",
      cell_compress_rate: 8,
      did: cred.device_id,
      enable_asr_threepass: true,
      enable_asr_twopass: true,
      input_mode: "tool",
    },
    ...session,
  };

  const url = `${WS_URL}?aid=${AID}&device_id=${cred.device_id}`;
  const ws = new WebSocket(url, {
    headers: { "User-Agent": UA, "proto-version": "v2", "x-custom-keepalive": "true" },
  });

  let finalText = "";
  let interimText = "";
  let started = false;
  let finished = false;
  let failure = null;
  let audioMs = 0;
  let chunksSent = 0;

  const done = new Promise((resolve) => {
    const finish = () => resolve();
    ws.on("close", finish);
    ws.on("error", (err) => {
      failure ??= err;
      finish();
    });
    setTimeout(finish, timeoutMs).unref?.();
  });

  const sendStart = () => ws.send(encodeAsrRequest({ token, methodName: "StartTask", requestId }));
  const sendSession = () =>
    ws.send(
      encodeAsrRequest({
        token,
        methodName: "StartSession",
        requestId,
        payload: JSON.stringify(sessionConfig),
      }),
    );

  ws.on("open", sendStart);

  ws.on("message", (data) => {
    let resp;
    try {
      resp = decodeAsrResponse(Buffer.from(data));
    } catch {
      return;
    }
    const type = resp[4];

    if (type === "TaskStarted") {
      sendSession();
      return;
    }

    if (type === "StartTask" || type === "StartSession") {
      // 舊版客戶端會用 message_type 回這兩個；這裡主要是保險
      if (!started && type === "StartSession") {
        started = true;
      }
      return;
    }

    if (type === "TaskFailed" || type === "SessionFailed") {
      failure = Object.assign(new Error(resp[6] || `doubao ${type} (${resp[5]})`), {
        code: resp[5] ? String(resp[5]) : "doubao_failed",
        status: resp[5] === 40200001 ? 401 : 502,
      });
      finished = true;
      try {
        ws.close();
      } catch {}
      return;
    }

    if (type === "SessionFinished") {
      finished = true;
      try {
        ws.close();
      } catch {}
      return;
    }

    // 欄位 7 是結果 JSON
    if (resp[7]) {
      let json;
      try {
        json = JSON.parse(resp[7]);
      } catch {
        return;
      }
      if (Number.isFinite(json?.extra?.duration)) audioMs = json.extra.duration * 1000;
      for (const item of json.results || []) {
        if (!item?.text) continue;
        if (item.is_interim === false) finalText = item.text;
        else interimText = item.text;
      }
      if (interimText && onPartial) onPartial(finalText || interimText);
    }
  });

  // 等 StartSession 回來才開始灌音訊
  const ready = new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(Object.assign(new Error("doubao: StartSession timeout"), { code: "doubao_timeout" })), 15_000);
    ws.on("message", (data) => {
      let resp;
      try {
        resp = decodeAsrResponse(Buffer.from(data));
      } catch {
        return;
      }
      if (resp[4] === "SessionStarted") {
        clearTimeout(timer);
        resolve();
      }
      if (resp[4] === "TaskFailed" || resp[4] === "SessionFailed") {
        clearTimeout(timer);
        reject(Object.assign(new Error(resp[6] || "doubao failed"), { code: String(resp[5] ?? "doubao_failed") }));
      }
    });
    ws.on("error", (err) => {
      clearTimeout(timer);
      reject(err);
    });
    ws.on("close", () => {
      clearTimeout(timer);
      reject(Object.assign(new Error("doubao: socket closed before session started"), { code: "doubao_closed" }));
    });
  });

  const down = new Resampler();
  let pending = Buffer.alloc(0);
  let index = 0;
  const t0 = Date.now();

  async function flushFrame(frame, isLast) {
    const state = index === 0 ? FRAME_STATE.FIRST : isLast ? FRAME_STATE.LAST : FRAME_STATE.MIDDLE;
    const opus = encoder.encode(frame, SPF);
    ws.send(
      encodeAsrRequest({
        methodName: "TaskRequest",
        requestId,
        payload: JSON.stringify({ extra: {}, timestamp_ms: t0 + index * FRAME_MS }),
        audioData: opus,
        frameState: state,
      }),
    );
    index += 1;
    chunksSent += 1;
    audioMs = index * FRAME_MS;
    if (realtime) await new Promise((r) => setTimeout(r, FRAME_MS));
  }

  try {
    await ready;

    const iter = Buffer.isBuffer(source)
      ? (async function* () {
          yield source;
        })()
      : source;

    for await (const chunk of iter) {
      const pcm16 = down.process(Buffer.from(chunk));
      pending = pending.length ? Buffer.concat([pending, pcm16]) : pcm16;
      while (pending.length >= BPF) {
        await flushFrame(pending.subarray(0, BPF), false);
        pending = pending.subarray(BPF);
      }
    }

    if (pending.length) {
      const padded = Buffer.concat([pending, Buffer.alloc(BPF - (pending.length % BPF || BPF))]);
      await flushFrame(padded.subarray(0, BPF), true);
    } else if (index > 0) {
      // 收尾一定要有一個 LAST 幀，不然伺服器不會結算
      await flushFrame(Buffer.alloc(BPF), true);
    }

    if (!finished) {
      ws.send(encodeAsrRequest({ token, methodName: "FinishSession", requestId }));
    }

    // 等 SessionFinished 或錯誤；AudioData 還在路上時會一直有回應
    await Promise.race([
      done,
      new Promise((r) => {
        const tick = setInterval(() => {
          if (finished) {
            clearInterval(tick);
            r();
          }
        }, 50);
        setTimeout(() => {
          clearInterval(tick);
          r();
        }, timeoutMs).unref?.();
      }),
    ]);
  } finally {
    encoder.close();
    try {
      ws.terminate();
    } catch {}
  }

  if (failure && !finalText) throw failure;

  return {
    text: finalText || interimText,
    audioMs,
    frames: chunksSent,
    requestId,
    deviceId: cred.device_id,
  };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 換一台「乾淨」的裝置（清掉憑證檔後重新註冊）。 */
export async function resetCredentials(credentialPath = DEFAULT_CREDENTIAL_PATH) {
  try {
    await writeFile(credentialPath, "{}", { mode: 0o600 });
  } catch {}
  return ensureCredentials(credentialPath);
}

/**
 * 對外入口（介面跟 transcribeElevenLabs 一致）。
 *
 * 失敗會自動處理兩種情況：
 *   - 40200001（token / session 過期或無效）→ 重抓 token 後重試
 *   - 50700000 / "service discovery failure"（這台裝置在後端沒被分配）→ 換裝置重試
 * 其他錯誤直接往上丟。
 *
 * @param {object} opts
 * @param {AsyncIterable<Buffer>|Buffer} opts.source 24 kHz mono s16le
 * @param {string} [opts.credentialPath]
 * @param {number} [opts.timeoutMs]
 * @param {number} [opts.retries] 重試次數（預設 1）
 */
export async function transcribeDoubao({
  source,
  credentialPath = process.env.DOUBAO_CREDENTIAL_PATH?.trim() || DEFAULT_CREDENTIAL_PATH,
  timeoutMs = Number(process.env.DOUBAO_TIMEOUT_MS || 180_000),
  retries = Number(process.env.DOUBAO_RETRIES ?? 1),
  session = {},
}) {
  const startedAt = Date.now();

  // 先把音訊收成 Buffer：重試（換裝置 / 換 token）要能重送同一段音訊
  const chunks = [];
  let bytes = 0;
  for await (const chunk of Buffer.isBuffer(source) ? [source] : source) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  if (!bytes) throw Object.assign(new Error("empty audio"), { status: 400, code: "empty_audio" });
  const pcm = chunks.length === 1 ? chunks[0] : Buffer.concat(chunks);
  const fallbackAudioMs = Math.round((pcm.length / 2 / 24_000) * 1000);

  let lastErr = null;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const cred = await ensureCredentials(credentialPath);
    try {
      const result = await runOnce({ source: pcm, cred, timeoutMs, session });
      const rawText = result.text ?? "";
      return {
        text: normalizeTranscript(rawText),
        rawText,
        audioMs: result.audioMs || fallbackAudioMs,
        sessionId: result.requestId,
        deviceId: result.deviceId,
        frames: result.frames,
        attempts: attempt + 1,
        timing: { totalMs: Date.now() - startedAt },
      };
    } catch (err) {
      lastErr = err;
      const code = String(err?.code ?? "");
      const transient = code === "50700000" || /service discovery failure/i.test(err?.message ?? "");
      const authExpired = code === "40200001";
      if (attempt === retries || (!transient && !authExpired)) throw err;
      if (authExpired) {
        // 只換 token，裝置留著
        await writeFile(credentialPath, JSON.stringify({ ...cred, token: "" }, null, 2), { mode: 0o600 });
      } else {
        await resetCredentials(credentialPath);
      }
      await sleep(400);
    }
  }
  throw lastErr;
}
