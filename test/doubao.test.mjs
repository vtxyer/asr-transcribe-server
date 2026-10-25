/** 豆包後端的離線單元測試：只驗 protobuf 編解碼跟重採樣，不打網路。 */

import test from "node:test";
import assert from "node:assert/strict";

import { encodeAsrRequest, decodeAsrResponse, Resampler, FRAME_STATE } from "../src/doubao.mjs";

test("AsrRequest: 欄位編碼正確", () => {
  const buf = encodeAsrRequest({
    token: "T",
    methodName: "StartTask",
    requestId: "R",
  });
  // token=2 → 0x12, service_name=3 → 0x1a, method_name=5 → 0x2a, request_id=8 → 0x42
  assert.equal(buf[0], 0x12);
  assert.ok(buf.includes(Buffer.from("T")));
  assert.ok(buf.includes(Buffer.from("StartTask")));
  assert.ok(buf.includes(Buffer.from("ASR")));
  assert.ok(buf.includes(Buffer.from("R")));
});

test("AsrRequest: 音訊幀與 frame_state", () => {
  const audio = Buffer.from([0xde, 0xad, 0xbe, 0xef]);
  const buf = encodeAsrRequest({
    methodName: "TaskRequest",
    requestId: "R",
    payload: '{"extra":{}}',
    audioData: audio,
    frameState: FRAME_STATE.LAST,
  });
  // audio_data=7 → 0x3a，frame_state=9 → 0x48
  assert.ok(buf.includes(Buffer.from([0x3a, 0x04, 0xde, 0xad, 0xbe, 0xef])));
  assert.ok(buf.includes(Buffer.from([0x48, 0x09])));
});

test("AsrResponse: 解出 message_type / status / result_json", () => {
  // 手工組一個 AsrResponse: 4:"SessionFinished", 5:20000000, 7:"{\"results\":[]}"
  const enc = (field, s) => {
    const b = Buffer.from(s);
    return Buffer.concat([Buffer.from([(field << 3) | 2, b.length]), b]);
  };
  const buf = Buffer.concat([
    enc(4, "SessionFinished"),
    Buffer.from([0x28, 0x80, 0xda, 0xc4, 0x09]), // field5 varint 20000000
    enc(7, '{"results":[]}'),
  ]);
  const r = decodeAsrResponse(buf);
  assert.equal(r[4], "SessionFinished");
  assert.equal(r[5], 20000000);
  assert.equal(r[7], '{"results":[]}');
});

test("Resampler: 24k → 16k 長度約 2/3", () => {
  const input = Buffer.alloc(24000 * 2); // 1 秒 24 kHz s16le
  const r = new Resampler(24000, 16000);
  const out = r.process(input);
  const samples = out.length / 2;
  assert.ok(Math.abs(samples - 16000) < 32, `got ${samples} samples, want ~16000`);
});

test("Resampler: 分批餵跟一次餵結果一致", () => {
  const sine = Buffer.alloc(4800 * 2);
  for (let i = 0; i < 4800; i++) {
    sine.writeInt16LE(Math.round(Math.sin((i / 4800) * Math.PI * 8) * 12000), i * 2);
  }
  const once = new Resampler(24000, 16000).process(sine);

  const r = new Resampler(24000, 16000);
  const parts = [];
  for (let i = 0; i < sine.length; i += 960) parts.push(r.process(sine.subarray(i, i + 960)));
  const chunked = Buffer.concat(parts);

  assert.ok(Math.abs(once.length - chunked.length) <= 4, `once=${once.length} chunked=${chunked.length}`);
  // 允許邊界處 1~2 個 sample 的差
  const cmp = Math.min(once.length, chunked.length);
  for (let i = 0; i < cmp; i += 2) {
    assert.ok(Math.abs(once.readInt16LE(i) - chunked.readInt16LE(i)) <= 2, `sample ${i / 2} mismatch`);
  }
});
