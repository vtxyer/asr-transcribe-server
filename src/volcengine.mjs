/**
 * 火山引擎（豆包）大模型流式语音识别 —— 二进制协议。
 *
 * 規格來源：https://www.volcengine.com/docs/6561/1354869
 *
 * 幀格式（整數都是大端）：
 *   byte0: (protocol_version << 4) | header_size   → 0x11 = v1, 4 bytes
 *   byte1: (message_type << 4) | flags
 *   byte2: (serialization << 4) | compression
 *   byte3: reserved
 *   [sequence: 4B]            ← 只有 flags 帶 sequence 時才有
 *   payload_size: 4B
 *   payload
 *
 * message_type: 0x1 full client request / 0x2 audio only / 0x9 full server response / 0xF error
 * flags:        0x0 無 sequence / 0x1 sequence 為正 / 0x2 最後一包（無 sequence）/ 0x3 sequence 為負（最後一包）
 * serialization: 0x1 = JSON；compression: 0x1 = gzip
 */

import { gzipSync, gunzipSync } from "node:zlib";

export const MSG = {
  FULL_CLIENT_REQUEST: 0x1,
  AUDIO_ONLY: 0x2,
  FULL_SERVER_RESPONSE: 0x9,
  ERROR: 0xf,
};

export const FLAGS = {
  NONE: 0x0,
  POS_SEQUENCE: 0x1,
  LAST_NO_SEQ: 0x2,
  NEG_SEQUENCE: 0x3,
};

/** 解析 client → server 的 frame；資料不夠就回 null（等更多 bytes） */
export function parseFrame(buf) {
  if (buf.length < 4) return null;
  const version = buf[0] >> 4;
  const headerSize = (buf[0] & 0x0f) * 4;
  const messageType = buf[1] >> 4;
  const flags = buf[1] & 0x0f;
  const serialization = buf[2] >> 4;
  const compression = buf[2] & 0x0f;

  let offset = headerSize;
  let sequence = null;
  if (flags === FLAGS.POS_SEQUENCE || flags === FLAGS.NEG_SEQUENCE) {
    if (buf.length < offset + 4) return null;
    sequence = buf.readUInt32BE(offset);
    offset += 4;
  }
  if (buf.length < offset + 4) return null;
  const size = buf.readUInt32BE(offset);
  offset += 4;
  if (buf.length < offset + size) return null;

  let payload = buf.subarray(offset, offset + size);
  if (compression === 1) {
    try {
      payload = gunzipSync(payload);
    } catch {
      /* 留原文，讓上層記錄 */
    }
  }

  return {
    consumed: offset + size,
    version,
    messageType,
    flags,
    serialization,
    compression,
    sequence: flags === FLAGS.NEG_SEQUENCE && sequence !== null ? -sequence : sequence,
    isLast: flags === FLAGS.LAST_NO_SEQ || flags === FLAGS.NEG_SEQUENCE,
    payload,
  };
}

/** 組 server → client 的 frame */
export function buildFrame(obj, { sequence = null, isLast = false, compression = 0, messageType = MSG.FULL_SERVER_RESPONSE } = {}) {
  const json = Buffer.from(typeof obj === "string" ? obj : JSON.stringify(obj), "utf8");
  const body = compression === 1 ? gzipSync(json) : json;

  const hasSeq = sequence !== null;
  const flags = isLast ? (hasSeq ? FLAGS.NEG_SEQUENCE : FLAGS.LAST_NO_SEQ) : hasSeq ? FLAGS.POS_SEQUENCE : FLAGS.NONE;

  const head = Buffer.alloc(4);
  head[0] = (0x1 << 4) | 0x1; // v1, header 4 bytes
  head[1] = (messageType << 4) | flags;
  head[2] = (0x1 << 4) | (compression & 0x0f); // JSON
  head[3] = 0x00;

  const parts = [head];
  if (hasSeq) {
    const seq = Buffer.alloc(4);
    // 最後一包要用「負的 sequence」（兩個補數），火山協議規定的
    const value = isLast ? (0x100000000 - Math.abs(sequence)) >>> 0 : sequence;
    seq.writeUInt32BE(value, 0);
    parts.push(seq);
  }
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  parts.push(size, body);
  return Buffer.concat(parts);
}

/**
 * 16 kHz PCM s16le -> 24 kHz PCM s16le（線性插值）。
 * Voyager 只吃 24 kHz，而火山協議的 rate 只支援 16000，所以一定要轉。
 */
export class Upsampler16to24 {
  constructor(inRate = 16_000, outRate = 24_000) {
    this.ratio = outRate / inRate;
    this.step = 1 / this.ratio;
    this.frac = 0;
    this.prev = 0;
    this.leftover = Buffer.alloc(0);
  }

  process(chunk) {
    let buf = chunk;
    if (this.leftover.length) buf = Buffer.concat([this.leftover, chunk]);
    const odd = buf.length % 2;
    this.leftover = odd ? buf.subarray(buf.length - 1) : Buffer.alloc(0);
    const samples = (buf.length - odd) / 2;

    const out = Buffer.alloc(Math.ceil(samples * this.ratio + 4) * 2);
    let o = 0;
    for (let i = 0; i < samples; i++) {
      const cur = buf.readInt16LE(i * 2);
      while (this.frac < 1) {
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

/** 火山協議的錯誤框（客戶端會顯示 message） */
export function buildError(message, code = 45000001, { compression = 0 } = {}) {
  return buildFrame({ error: message, code }, { messageType: MSG.ERROR, compression });
}

/** 把 Voyager 的結果轉成火山 full server response 的 payload */
export function buildResultPayload({ text, utterances = [], duration, showUtterances = false }) {
  const result = { text };
  if (showUtterances && utterances.length) {
    result.utterances = utterances.map((u) => ({
      text: u.text,
      start_time: u.startTime ?? 0,
      end_time: u.endTime ?? 0,
      definite: !!u.definite,
      ...(u.words ? { words: u.words } : {}),
    }));
  }
  return {
    ...(duration != null ? { audio_info: { duration: Math.round(duration) } } : {}),
    result,
  };
}
