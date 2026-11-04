/**
 * 豆包輸入法 ASR 的「即時串流」session，給火山相容 WS（volcengine-ws.mjs）用。
 *
 *   client 16 kHz PCM16 ──▶ 20 ms 切幀 ──▶ Opus ──▶ Doubao IME (TaskRequest FIRST/MIDDLE/LAST)
 *
 * 上游行為（2026-11 實測）：
 *   - 一個 session 內結果切成「段」（約 20–25 s，靠上游 VAD / vad_timeout 切）。
 *     每次回應只帶目前這段的完整文字（is_interim=true），而且會回頭改前面的字，
 *     所以段內文字不能當成穩定的；段換了（start_time 往後跳、index 變、
 *     或收到 is_interim=false）才把上一段的最後文字當 definite。
 *   - start_time 是 session 內的秒數；end_time 不可靠，不用。
 *     extra.audio_duration 是上游已處理的 ms。
 *
 * 長會議：上游斷線 / SessionFailed / 單一 session 超過 maxSessionMs 時，
 * 換一個新的上游 session，並把「目前這段開頭前 replayLeadMs 起」的音訊重送，
 * 進行中的句子不會掉；換線期間 client 送來的音訊先排隊。
 * 憑證失效（40200001 / 50700000）沿用 doubao.mjs 的 recoverCredentials，重試一次。
 *
 * 事件：
 *   partial  { text }                         目前這段的暫定文字（原文，未正規化）
 *   definite { text, startMs, endMs }         一段定稿
 *   rollover { reason, sessions }             換了上游 session
 *   error    Error                            無法恢復
 */

import { EventEmitter } from "node:events";
import { randomUUID } from "node:crypto";

import {
  DEFAULT_CREDENTIAL_PATH,
  FRAME_STATE,
  UA,
  WS_URL,
  AID,
  buildSessionConfig,
  createOpusEncoder,
  decodeAsrResponse,
  encodeAsrRequest,
  ensureCredentials,
  recoverCredentials,
} from "./doubao.mjs";

const FRAME_MS = 20;
const SPF = 320; // 16 kHz × 20 ms
const BPF = SPF * 2;

const envNum = (name, dflt) => {
  const v = Number(process.env[name]);
  return Number.isFinite(v) && process.env[name]?.trim() !== "" ? v : dflt;
};

export class DoubaoStream extends EventEmitter {
  /**
   * @param {object} [opts]
   * @param {string} [opts.credentialPath]
   * @param {string} [opts.wsUrl]          測試用：指到假上游
   * @param {(path:string)=>Promise<object>} [opts.getCredentials]
   * @param {(err:Error, cred:object, path:string)=>Promise<boolean>} [opts.recover]
   * @param {number} [opts.maxSessionMs]   單一上游 session 上限，到了在段落邊界換線（0 = 不主動換）
   * @param {number} [opts.replayLeadMs]   換線時從目前段落開頭再往前重送多少音訊
   * @param {number} [opts.maxBufferMs]    重送緩衝上限
   * @param {number} [opts.finishTimeoutMs]
   * @param {number} [opts.connectTimeoutMs]
   * @param {number} [opts.maxReconnects]  連續換線失敗上限
   */
  constructor(opts = {}) {
    super();
    this.credentialPath = opts.credentialPath ?? (process.env.DOUBAO_CREDENTIAL_PATH?.trim() || DEFAULT_CREDENTIAL_PATH);
    this.wsUrl = opts.wsUrl ?? (process.env.DOUBAO_WS_URL?.trim() || WS_URL);
    this.getCredentials = opts.getCredentials ?? ensureCredentials;
    this.recover = opts.recover ?? recoverCredentials;
    this.maxSessionMs = opts.maxSessionMs ?? envNum("DOUBAO_STREAM_MAX_SESSION_SEC", 1800) * 1000;
    this.replayLeadMs = opts.replayLeadMs ?? 3000;
    this.maxBufferMs = opts.maxBufferMs ?? 60_000;
    this.finishTimeoutMs = opts.finishTimeoutMs ?? 8000;
    this.connectTimeoutMs = opts.connectTimeoutMs ?? 15_000;
    this.maxReconnects = opts.maxReconnects ?? 3;
    this.retries = opts.retries ?? envNum("DOUBAO_RETRIES", 1);

    this.pending = Buffer.alloc(0); // 不滿一幀的尾巴
    this.frames = []; // 重送緩衝：{ pos, pcm }，pos = 全域幀序號
    this.nextPos = 0; // 下一個進來的幀序號
    this.session = null;
    this.sessions = 0;
    this.connecting = null;
    this.failures = 0;
    this.ending = false;
    this.ended = false;
    this.closed = false;

    // 目前這段
    this.seg = null; // { text, st, index, firstPos, lastDurMs, offsetMs }
    this.lastEndMs = 0;
  }

  get audioMs() {
    return this.nextPos * FRAME_MS;
  }

  /** 開第一個上游 session（不等它好；音訊會先排隊） */
  start() {
    this.#ensureSession("start");
    return this;
  }

  /** 餵 16 kHz mono s16le */
  pushPcm16(chunk) {
    if (this.ending || this.closed || !chunk?.length) return;
    let buf = this.pending.length ? Buffer.concat([this.pending, chunk]) : Buffer.from(chunk);
    let off = 0;
    for (; off + BPF <= buf.length; off += BPF) this.#addFrame(Buffer.from(buf.subarray(off, off + BPF)));
    this.pending = buf.subarray(off);
  }

  /** client 說最後一包了：送 LAST 幀 + FinishSession，等上游結算，再把最後一段定稿。 */
  async finish() {
    if (this.ending) return this.#finished;
    this.ending = true;
    this.#finished = (async () => {
      if (this.pending.length) {
        const pcm = Buffer.concat([this.pending, Buffer.alloc(BPF - this.pending.length)]);
        this.pending = Buffer.alloc(0);
        this.#addFrame(pcm, { force: true });
      }
      try {
        if (this.connecting) await this.connecting.catch(() => {});
        const s = this.session;
        if (s && s.ready && !s.dead) {
          this.#sendFrame(s, Buffer.alloc(BPF), FRAME_STATE.LAST);
          s.ws.send(encodeAsrRequest({ token: s.cred.token, methodName: "FinishSession", requestId: s.requestId }));
          await Promise.race([s.finished, new Promise((r) => setTimeout(r, this.finishTimeoutMs).unref?.())]);
        }
      } finally {
        this.#commit(this.audioMs);
        this.ended = true;
        this.close();
      }
    })();
    return this.#finished;
  }
  #finished = null;

  close() {
    if (this.closed) return;
    this.closed = true;
    this.#dropSession(this.session);
    this.session = null;
  }

  // ── 音訊 ─────────────────────────────────────────────────────────
  #addFrame(pcm, { force = false } = {}) {
    if (this.ending && !force) return;
    const pos = this.nextPos++;
    this.frames.push({ pos, pcm });
    // 緩衝只留「目前段落開頭 − replayLeadMs」之後，且不超過 maxBufferMs
    const keepFrom = Math.max(
      this.#replayStartPos(),
      this.nextPos - Math.ceil(this.maxBufferMs / FRAME_MS),
    );
    let drop = 0;
    while (drop < this.frames.length && this.frames[drop].pos < keepFrom) drop++;
    if (drop) this.frames.splice(0, drop);

    const s = this.session;
    if (s && s.ready && !s.dead && s.nextPos === pos) {
      this.#sendFrame(s, pcm);
      s.nextPos = pos + 1;
    } else if (!s && !this.connecting && !this.closed && !this.ending) {
      // 上游掉了且還沒在重連（例如之前的重連都失敗後又來音訊）
      this.#ensureSession("reconnect");
    }
  }

  #replayStartPos() {
    const lead = Math.ceil(this.replayLeadMs / FRAME_MS);
    const segPos = this.seg ? this.seg.firstPos : this.nextPos;
    return Math.max(0, segPos - lead);
  }

  #sendFrame(s, pcm, state) {
    const frameState = state ?? (s.index === 0 ? FRAME_STATE.FIRST : FRAME_STATE.MIDDLE);
    const opus = s.encoder.encode(pcm, SPF);
    s.ws.send(
      encodeAsrRequest({
        methodName: "TaskRequest",
        requestId: s.requestId,
        payload: JSON.stringify({ extra: {}, timestamp_ms: s.t0 + s.index * FRAME_MS }),
        audioData: opus,
        frameState,
      }),
    );
    s.index += 1;
  }

  // ── 上游 session ─────────────────────────────────────────────────
  #ensureSession(reason) {
    if (this.connecting || this.closed) return this.connecting;
    this.connecting = this.#connectWithRetry(reason)
      .then((s) => {
        this.connecting = null;
        if (this.closed) {
          this.#dropSession(s);
          return;
        }
        this.session = s;
        this.failures = 0;
        this.sessions += 1;
        if (this.sessions > 1) this.emit("rollover", { reason, sessions: this.sessions });
        // 重送：從緩衝最前面（= 段落開頭往前一點）送到目前
        const startPos = this.frames.length ? this.frames[0].pos : this.nextPos;
        s.offsetMs = startPos * FRAME_MS;
        s.nextPos = startPos;
        for (const f of this.frames) {
          this.#sendFrame(s, f.pcm);
          s.nextPos = f.pos + 1;
        }
      })
      .catch((err) => {
        this.connecting = null;
        this.failures += 1;
        if (this.failures > this.maxReconnects || this.ending) {
          this.emit("error", err);
          return;
        }
        setTimeout(() => this.#ensureSession(reason), 300 * this.failures).unref?.();
      });
    return this.connecting;
  }

  async #connectWithRetry(reason) {
    let lastErr;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      const cred = await this.getCredentials(this.credentialPath);
      try {
        return await this.#connect(cred);
      } catch (err) {
        lastErr = err;
        if (attempt === this.retries || !(await this.recover(err, cred, this.credentialPath))) throw err;
      }
    }
    throw lastErr;
  }

  async #connect(cred) {
    const { default: WebSocket } = await import("ws");
    const encoder = await createOpusEncoder();
    const requestId = randomUUID();
    const sep = this.wsUrl.includes("?") ? "&" : "?";
    const ws = new WebSocket(`${this.wsUrl}${sep}aid=${AID}&device_id=${cred.device_id}`, {
      headers: { "User-Agent": UA, "proto-version": "v2", "x-custom-keepalive": "true" },
      family: 4, // VPS 沒有 IPv6 路由
    });
    const s = {
      ws,
      cred,
      encoder,
      requestId,
      index: 0,
      nextPos: 0,
      offsetMs: 0,
      t0: Date.now(),
      startedAt: Date.now(),
      ready: false,
      dead: false,
      finishedResolve: null,
    };
    s.finished = new Promise((r) => (s.finishedResolve = r));

    const fail = (code, message) => Object.assign(new Error(message), { code: String(code) });

    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(fail("doubao_timeout", "doubao: StartSession timeout")), this.connectTimeoutMs);
      let settled = false;
      const settle = (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (err) {
          s.dead = true;
          try {
            ws.terminate();
          } catch {}
          encoder.close();
          reject(err);
        } else resolve();
      };
      ws.on("open", () => ws.send(encodeAsrRequest({ token: cred.token, methodName: "StartTask", requestId })));
      ws.on("error", (err) => {
        if (!s.ready) settle(err);
        else this.#onSessionDown(s, err);
      });
      ws.on("close", () => {
        s.finishedResolve();
        if (!s.ready) settle(fail("doubao_closed", "doubao: socket closed before session started"));
        else this.#onSessionDown(s, null);
      });
      ws.on("message", (data) => {
        let resp;
        try {
          resp = decodeAsrResponse(Buffer.from(data));
        } catch {
          return;
        }
        const type = resp[4];
        if (type === "TaskStarted") {
          ws.send(
            encodeAsrRequest({
              token: cred.token,
              methodName: "StartSession",
              requestId,
              payload: JSON.stringify(buildSessionConfig(cred)),
            }),
          );
          return;
        }
        if (type === "SessionStarted") {
          s.ready = true;
          settle();
          return;
        }
        if (type === "TaskFailed" || type === "SessionFailed") {
          const err = Object.assign(fail(resp[5] ?? "doubao_failed", resp[6] || `doubao ${type} (${resp[5]})`), {
            status: resp[5] === 40200001 ? 401 : 502,
          });
          if (!s.ready) settle(err);
          else this.#onSessionDown(s, err);
          return;
        }
        if (type === "SessionFinished") {
          s.finishedResolve();
          if (!this.ending) this.#onSessionDown(s, null);
          return;
        }
        if (resp[7] && s.ready && !s.dead) {
          let json;
          try {
            json = JSON.parse(resp[7]);
          } catch {
            return;
          }
          this.#onResult(s, json);
        }
      });
    });
    return s;
  }

  #dropSession(s) {
    if (!s || s.dead) return;
    s.dead = true;
    try {
      s.ws.terminate();
    } catch {}
    s.encoder.close();
  }

  /** 上游中途掉線 / 失敗：換一條新的，重送目前段落的音訊 */
  #onSessionDown(s, err) {
    if (s.dead || s !== this.session) return;
    this.#dropSession(s);
    this.session = null;
    if (this.ending || this.closed) return;
    if (err && this.retries > 0) {
      // 憑證問題先修再連（recover 內部判斷錯誤碼；不是憑證問題就什麼都不做）
      this.recover(err, s.cred, this.credentialPath)
        .catch(() => false)
        .finally(() => this.#ensureSession(err ? `upstream_error:${err.code}` : "upstream_closed"));
      return;
    }
    this.#ensureSession(err ? `upstream_error:${err.code}` : "upstream_closed");
  }

  // ── 結果對應 ─────────────────────────────────────────────────────
  #onResult(s, json) {
    const durMs = Number.isFinite(json?.extra?.audio_duration) ? json.extra.audio_duration : null;
    let boundary = false;
    for (const item of json?.results || []) {
      const text = item?.text || "";
      if (!text) continue;
      const st = Number.isFinite(item.start_time) ? item.start_time : null;
      const index = item.index ?? 0;
      const cur = this.seg;

      const newSegment =
        cur &&
        (cur.session !== s ||
          index !== cur.index ||
          (st != null && cur.st != null && st - cur.st > 5));
      if (newSegment) {
        // 新段的起點（全域 ms）就是上一段的結尾
        const startMs = st != null ? s.offsetMs + st * 1000 : this.audioMs;
        if (cur.session === s) {
          this.#commit(Math.min(startMs, cur.lastEndMs ?? startMs));
          boundary = true;
        }
        else {
          // 換線後的第一個結果：舊 session 的 tail 被新 session 重新辨識取代
          this.seg = null;
        }
      }

      if (!this.seg) {
        const posMs = st != null ? s.offsetMs + st * 1000 : this.audioMs;
        this.seg = {
          session: s,
          text,
          st,
          index,
          startMs: Math.max(this.lastEndMs, Math.round(posMs)),
          // 段落開頭的幀位置；換線時從這裡往前 replayLeadMs 重送
          firstPos: Math.max(0, Math.min(this.nextPos, Math.floor(posMs / FRAME_MS))),
          lastEndMs: null,
        };
      } else {
        this.seg.text = text;
      }
      if (durMs != null) this.seg.lastEndMs = s.offsetMs + durMs;

      if (item.is_interim === false) {
        this.#commit(this.seg.lastEndMs ?? this.audioMs);
        boundary = true;
      } else {
        this.emit("partial", { text });
      }
    }

    // 剛過段落邊界 + session 太老 → 主動換線（新段剛開始，重送量最小）
    if (boundary && this.maxSessionMs > 0 && !this.ending && s === this.session && Date.now() - s.startedAt > this.maxSessionMs) {
      this.#dropSession(s);
      this.session = null;
      this.#ensureSession("max_session");
    }
  }

  #commit(endMs) {
    const seg = this.seg;
    if (!seg || !seg.text) {
      this.seg = null;
      return;
    }
    const startMs = Math.max(this.lastEndMs, seg.startMs);
    const end = Math.max(startMs, Math.round(endMs ?? this.audioMs));
    this.lastEndMs = end;
    this.seg = null;
    this.emit("definite", { text: seg.text, startMs, endMs: end });
  }
}
