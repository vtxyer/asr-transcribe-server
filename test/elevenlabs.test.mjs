import assert from "node:assert/strict";
import test from "node:test";
import { transcribeElevenLabs } from "../src/elevenlabs.mjs";

const source = async function* () {
  yield Buffer.alloc(24_000);
  yield Buffer.alloc(24_000);
};

test("Scribe V2 uploads valid WAV, forwards language, and shares transcript post-processing", async (t) => {
  t.mock.method(globalThis, "fetch", async (url, options) => {
    assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
    assert.equal(options.method, "POST");
    assert.equal(options.headers["xi-api-key"], "test-token");
    assert.ok(options.signal instanceof AbortSignal);
    assert.equal(options.body.get("model_id"), "scribe_v2");
    assert.equal(options.body.get("language_code"), "zh");
    assert.equal(options.body.get("tag_audio_events"), "false");
    const file = options.body.get("file");
    assert.equal(file.type, "audio/wav");
    const wav = Buffer.from(await file.arrayBuffer());
    assert.equal(wav.toString("ascii", 0, 4), "RIFF");
    assert.equal(wav.readUInt32LE(4), wav.length - 8);
    assert.equal(wav.toString("ascii", 8, 16), "WAVEfmt ");
    assert.equal(wav.readUInt16LE(22), 1);
    assert.equal(wav.readUInt32LE(24), 24_000);
    assert.equal(wav.readUInt16LE(34), 16);
    assert.equal(wav.readUInt32LE(40), 48_000);
    assert.deepEqual(wav.subarray(44), Buffer.alloc(48_000));
    return Response.json({ text: "这是软件和网络测试。。  ", transcription_id: "scribe-session" });
  });
  const result = await transcribeElevenLabs({ source: source(), token: " test-token ", language: "zh-TW" });
  assert.equal(result.text, "這是軟體和網路測試");
  assert.equal(result.rawText, "这是软件和网络测试。。  ");
  assert.equal(result.audioMs, 1000);
  assert.equal(result.sessionId, "scribe-session");
});

test("Scribe allows automatic language detection and empty transcripts", async (t) => {
  t.mock.method(globalThis, "fetch", async (_url, { body }) => {
    assert.equal(body.has("language_code"), false);
    return Response.json({ text: "" });
  });
  const result = await transcribeElevenLabs({ source: source(), token: "test-token" });
  assert.equal(result.text, "");
  assert.equal(result.sessionId, null);
});

test("Scribe rejects missing credentials and empty or failed audio before uploading", async (t) => {
  const fetchMock = t.mock.method(globalThis, "fetch", () => assert.fail("must not upload"));
  await assert.rejects(transcribeElevenLabs({ source: source(), token: " " }), { status: 503, code: "no_elevenlabs_token" });
  await assert.rejects(transcribeElevenLabs({ source: [], token: "test-token" }), { status: 400, code: "empty_audio" });
  const failedSource = async function* () {
    yield Buffer.alloc(10);
    throw Object.assign(new Error("audio too long"), { status: 413, code: "audio_too_long" });
  };
  await assert.rejects(transcribeElevenLabs({ source: failedSource(), token: "test-token" }), { status: 413, code: "audio_too_long" });
  assert.equal(fetchMock.mock.callCount(), 0);
});

test("Scribe upstream errors preserve useful status without exposing response contents", async (t) => {
  for (const [upstream, status] of [[401, 401], [403, 403], [422, 422], [429, 429], [500, 502]]) {
    const mocked = t.mock.method(globalThis, "fetch", async () => new Response("secret-token", { status: upstream }));
    await assert.rejects(transcribeElevenLabs({ source: source(), token: "test-token" }), (err) => {
      assert.equal(err.status, status);
      assert.equal(err.code, "elevenlabs_error");
      assert.match(err.message, /ElevenLabs/);
      assert.doesNotMatch(err.message, /secret-token|Muse/);
      return true;
    });
    mocked.mock.restore();
  }
});

test("Scribe times out and rejects network failures or malformed upstream responses", async (t) => {
  const cases = [
    [async () => { throw new DOMException("timeout", "TimeoutError"); }, 504, "elevenlabs_timeout"],
    [async () => { throw new Error("secret-token"); }, 502, "elevenlabs_error"],
    [async () => new Response("not json"), 502, "elevenlabs_error"],
    [async () => Response.json({}), 502, "elevenlabs_error"],
  ];
  for (const [impl, status, code] of cases) {
    const mocked = t.mock.method(globalThis, "fetch", impl);
    await assert.rejects(transcribeElevenLabs({ source: source(), token: "test-token" }), { status, code });
    mocked.mock.restore();
  }
});
