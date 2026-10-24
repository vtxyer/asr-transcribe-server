import test from "node:test";
import assert from "node:assert/strict";
import {
  BYTES_PER_AUDIO_SECOND,
  BYTES_PER_CHUNK,
  MODE,
  buildUrl,
  createFrameSplitter,
  decodeServerMessage,
  encodeEndStream,
  encodeHandshake,
} from "../src/protocol.mjs";

test("20 ms frame at 24 kHz mono s16le is 960 bytes", () => {
  assert.equal(BYTES_PER_CHUNK, 960);
  assert.equal(BYTES_PER_AUDIO_SECOND, 48000);
});

test("url carries the client session id", () => {
  assert.equal(
    buildUrl("a-b-c"),
    "wss://shortwave.facebook.com/voyager/v1/asr/duplex?sessionId=a-b-c",
  );
});

test("handshake matches the recovered schema", () => {
  const parsed = JSON.parse(encodeHandshake({ token: "T", model: "m" }));
  assert.deepEqual(parsed, {
    mode: MODE.PUSH_TO_TALK,
    authorization: { accessToken: "T" },
    audioEncoding: "PCM_24KHZ",
    model: "m",
  });
});

test("empty languageBias is omitted, non-empty is kept", () => {
  assert.equal("languageBias" in JSON.parse(encodeHandshake({ token: "T", model: "m", languageBias: [] })), false);
  assert.deepEqual(
    JSON.parse(encodeHandshake({ token: "T", model: "m", languageBias: ["en", "zh"] })).languageBias,
    ["en", "zh"],
  );
});

test("endStream frame", () => {
  assert.deepEqual(JSON.parse(encodeEndStream()), { endStream: {} });
});

test("frame splitter keeps the remainder", () => {
  const s = createFrameSplitter(4);
  const frames = s.push(Buffer.from([1, 2, 3, 4, 5, 6, 7]));
  assert.equal(frames.length, 1);
  assert.deepEqual([...frames[0]], [1, 2, 3, 4]);
  assert.deepEqual([...s.push(Buffer.from([8]))[0]], [5, 6, 7, 8]);
  assert.equal(s.push(Buffer.from([9])).length, 0);
  assert.deepEqual([...s.flush()[0]], [9]);
});

test("decodes server messages", () => {
  assert.equal(decodeServerMessage('{"sessionId":"abc"}').type, "ack");
  assert.deepEqual(decodeServerMessage('{"transcript":{"transcript":"hi","final":true}}'), {
    type: "final",
    transcript: "hi",
  });
  assert.equal(decodeServerMessage('{"transcript":{"transcript":"h","final":false}}').type, "partial");
  assert.deepEqual(decodeServerMessage('{"speechStart":{"turnId":2}}'), {
    type: "speechStart",
    turnId: 2,
    audioProcessedMs: null,
  });
  assert.equal(
    decodeServerMessage('{"speechComplete":{"turnId":1,"transcript":"done"}}').type,
    "speechComplete",
  );
  const err = decodeServerMessage(
    '{"error":{"message":"bad","errorType":"authentication_error","errorCode":"invalid_api_key"}}',
  );
  assert.equal(err.type, "error");
  assert.equal(err.errorCode, "invalid_api_key");
  assert.equal(decodeServerMessage("not json").type, "malformed");
});
