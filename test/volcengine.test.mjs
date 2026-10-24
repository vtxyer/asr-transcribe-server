import test from "node:test";
import assert from "node:assert/strict";
import {
  FLAGS,
  MSG,
  Upsampler16to24,
  buildFrame,
  buildResultPayload,
  parseFrame,
} from "../src/volcengine.mjs";
import { gzipSync } from "node:zlib";

test("client frame roundtrip：full client request", () => {
  const cfg = { audio: { format: "pcm", rate: 16000 }, request: { model_name: "bigmodel" } };
  // 手工組一個 client 端 frame（header 0x11 / type 0x1 / flags 0x1 / JSON 無壓縮）
  const body = Buffer.from(JSON.stringify(cfg));
  const head = Buffer.from([0x11, 0x10 | FLAGS.POS_SEQUENCE, 0x10, 0x00]);
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(1, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length, 0);
  const raw = Buffer.concat([head, seq, size, body]);

  const f = parseFrame(raw);
  assert.equal(f.messageType, MSG.FULL_CLIENT_REQUEST);
  assert.equal(f.sequence, 1);
  assert.equal(f.compression, 0);
  assert.deepEqual(JSON.parse(f.payload.toString()), cfg);
  assert.equal(f.consumed, raw.length);
  assert.equal(f.isLast, false);
});

test("gzip payload 會自動解開", () => {
  const cfg = { hello: "世界" };
  const gz = gzipSync(Buffer.from(JSON.stringify(cfg)));
  const head = Buffer.from([0x11, 0x10 | FLAGS.POS_SEQUENCE, 0x11, 0x00]);
  const seq = Buffer.alloc(4);
  seq.writeUInt32BE(7, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(gz.length, 0);
  const f = parseFrame(Buffer.concat([head, seq, size, gz]));
  assert.equal(f.compression, 1);
  assert.deepEqual(JSON.parse(f.payload.toString()), cfg);
});

test("最後一包：negative sequence", () => {
  const buf = buildFrame({ ok: true }, { sequence: 5, isLast: true });
  const f = parseFrame(buf);
  assert.equal(f.isLast, true);
  // 負數以兩個補數表示
  assert.equal(buf.readUInt32BE(4), 0x100000000 - 5);
  assert.equal(f.messageType, MSG.FULL_SERVER_RESPONSE);
});

test("沒 sequence 的最後一包", () => {
  const buf = buildFrame({ ok: true }, { isLast: true, sequence: null });
  const f = parseFrame(buf);
  assert.equal(f.isLast, true);
  assert.equal(f.sequence, null);
});

test("16k -> 24k 取樣率轉換（長度 1.5 倍）", () => {
  const up = new Upsampler16to24();
  // 100 ms @16k = 1600 samples = 3200 bytes
  const input = Buffer.alloc(3200);
  for (let i = 0; i < 1600; i++) input.writeInt16LE(Math.round(1000 * Math.sin(i / 10)), i * 2);
  const out = up.process(input);
  const samples = out.length / 2;
  assert.ok(samples >= 2300 && samples <= 2450, `samples=${samples}`);
});

test("偶數字節會被保留（不會丟半個 sample）", () => {
  const up = new Upsampler16to24();
  const a = up.process(Buffer.alloc(3201, 1)); // 奇數長度
  assert.equal(a.length % 2, 0);
});

test("result payload 形狀", () => {
  const p = buildResultPayload({
    text: "你好",
    utterances: [{ text: "你好", startTime: 0, endTime: 900, definite: true }],
    duration: 900,
    showUtterances: true,
  });
  assert.equal(p.audio_info.duration, 900);
  assert.equal(p.result.text, "你好");
  assert.equal(p.result.utterances[0].definite, true);
  // 沒開 show_utterances 就不帶
  const q = buildResultPayload({ text: "x", utterances: [{ text: "x", definite: true }], showUtterances: false });
  assert.equal(q.result.utterances, undefined);
});
