import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { once } from "node:events";
import { cp, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import test from "node:test";
import WebSocket from "ws";

const root = fileURLToPath(new URL("../", import.meta.url));

async function launch(t, { dotenv, overrides = {}, preload } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "asr-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(root, "server.mjs"), join(dir, "server.mjs"));
  await cp(join(root, "src"), join(dir, "src"), { recursive: true });
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  if (dotenv !== undefined) await writeFile(join(dir, ".env"), dotenv, { mode: 0o600 });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MUSE_|ELEVENLABS_|META_TOKEN$|HOST$|PORT$|OPENCC_TARGET$|NODE_OPTIONS$)/.test(name)) delete env[name];
  }
  Object.assign(env, { HOST: "127.0.0.1", PORT: "0" }, overrides);
  // Launch from another working directory to verify project-relative .env loading.
  const args = [];
  if (preload) {
    await writeFile(join(dir, "preload.mjs"), preload);
    args.push("--import", join(dir, "preload.mjs"));
  }
  const child = spawn(process.execPath, [...args, join(dir, "server.mjs")], { cwd: tmpdir(), env });
  let output = "";
  child.stdout.on("data", (data) => { output += data; });
  child.stderr.on("data", (data) => { output += data; });
  const exited = once(child, "exit");
  t.after(async () => {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
    await exited;
  });
  return { child, exited, output: () => output };
}

async function waitForServer(run) {
  for (let i = 0; i < 150; i++) {
    for (const line of run.output().split("\n")) {
      try {
        const event = JSON.parse(line);
        if (event.msg === "listening") return `http://${event.host}:${event.port}`;
      } catch {}
    }
    if (run.child.exitCode !== null) throw new Error(run.output());
    await delay(20);
  }
  throw new Error("server did not start");
}

test("startup rejects missing and blank API keys", { timeout: 10000 }, async (t) => {
  for (const overrides of [{}, { MUSE_API_KEY: "   " }]) {
    const run = await launch(t, { overrides });
    const [code] = await run.exited;
    assert.notEqual(code, 0);
    assert.match(run.output(), /MUSE_API_KEY must be set/);
    assert.doesNotMatch(run.output(), /"msg":"listening"/);
  }
});

test(".env supports HTTP and WebSocket authentication without logging credentials", { timeout: 10000 }, async (t) => {
  const key = randomBytes(24).toString("hex");
  const token = randomBytes(24).toString("hex");
  const run = await launch(t, { dotenv: `MUSE_API_KEY=${key}\nMUSE_TOKEN=${token}\n` });
  const base = await waitForServer(run);
  const health = await (await fetch(`${base}/health`)).json();
  assert.equal(health.service, "asr-transcribe-server");
  assert.equal(health.token, "present");
  assert.equal((await fetch(`${base}/v1/models`)).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer incorrect" } })).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${key}` } })).status, 200);

  const rejected = new WebSocket(base.replace("http:", "ws:") + "/api/v3/sauc/bigmodel");
  const rejectedClose = once(rejected, "close");
  const [packet] = await once(rejected, "message");
  assert.match(packet.toString(), /authentication failed/);
  assert.equal((await rejectedClose)[0], 1008);

  const accepted = new WebSocket(base.replace("http:", "ws:") + "/api/v3/sauc/bigmodel", { headers: { "X-Api-Key": key } });
  const acceptedClose = once(accepted, "close");
  const packets = [];
  accepted.on("message", (data) => packets.push(data));
  await once(accepted, "open");
  await delay(30);
  assert.equal(accepted.readyState, WebSocket.OPEN);
  assert.equal(packets.length, 0);
  accepted.close(1000);
  await acceptedClose;
  run.child.kill("SIGTERM");
  await run.exited;
  assert.ok(!run.output().includes(key));
  assert.ok(!run.output().includes(token));
});

test("environment API key takes precedence over .env", { timeout: 10000 }, async (t) => {
  const fileKey = randomBytes(24).toString("hex");
  const envKey = randomBytes(24).toString("hex");
  const run = await launch(t, { dotenv: `MUSE_API_KEY=${fileKey}\n`, overrides: { MUSE_API_KEY: envKey } });
  const base = await waitForServer(run);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${fileKey}` } })).status, 401);
  assert.equal((await fetch(`${base}/v1/models`, { headers: { authorization: `Bearer ${envKey}` } })).status, 200);
});

// A valid short WAV exercises the real HTTP upload and ffmpeg decoder.
function audioFile() {
  const wav = Buffer.alloc(44 + 9600);
  wav.write("RIFF");
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write("WAVEfmt ", 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(1, 22);
  wav.writeUInt32LE(24_000, 24);
  wav.writeUInt32LE(48_000, 28);
  wav.writeUInt16LE(2, 32);
  wav.writeUInt16LE(16, 34);
  wav.write("data", 36);
  wav.writeUInt32LE(9600, 40);
  return new Blob([wav], { type: "audio/wav" });
}

async function upload(base, { model, format = "json" } = {}) {
  const body = new FormData();
  body.set("file", audioFile(), "test.wav");
  if (model !== undefined) body.set("model", model);
  body.set("response_format", format);
  return fetch(`${base}/v1/audio/transcriptions`, {
    method: "POST", headers: { authorization: "Bearer test-key" }, body,
  });
}

test("HTTP model names containing scribe use Scribe V2 without a Muse token, in every response format", { timeout: 15000 }, async (t) => {
  const run = await launch(t, {
    overrides: { MUSE_API_KEY: "test-key", ELEVENLABS_API_KEY: "test-elevenlabs", MUSE_TOKEN_FILE: "/missing/token" },
    preload: `
      import assert from "node:assert/strict";
      globalThis.fetch = async (url, { body, headers }) => {
        assert.equal(url, "https://api.elevenlabs.io/v1/speech-to-text");
        assert.equal(headers["xi-api-key"], "test-elevenlabs");
        assert.equal(body.get("model_id"), "scribe_v2");
        assert.equal(body.get("file").size, 9644);
        return Response.json({ text: "这是软件测试。。  " });
      };
    `,
  });
  const base = await waitForServer(run);
  const models = await (await fetch(`${base}/v1/models`, { headers: { authorization: "Bearer test-key" } })).json();
  assert.ok(models.data.some((m) => m.id === "scribe_v2" && m.owned_by === "elevenlabs"));
  const model = await (await fetch(`${base}/v1/models/Custom-SCRIBE-alias`, { headers: { authorization: "Bearer test-key" } })).json();
  assert.equal(model.owned_by, "elevenlabs");
  for (const [requested, format] of [["scribe", "json"], ["SCRIBE_V2", "text"], ["custom-ScRiBe-alias", "verbose_json"], ["scribe_v2", "srt"], ["Scribe V2", "vtt"], ["gpt-4o-transcribe", "json"]]) {
    const response = await upload(base, { model: requested, format });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal(response.headers.get("x-muse-audio-ms"), "200");
    if (format === "json" || format === "verbose_json") {
      const result = await response.json();
      assert.equal(result.text, "這是軟體測試");
      if (format === "verbose_json") assert.equal(result.duration, 0.2);
    } else {
      const text = await response.text();
      assert.match(text, /這是軟體測試\n$/u);
      assert.doesNotMatch(text, /[。.]\n$/u);
    }
  }
  for (const requested of [undefined, "whisper-1", "unrelated-model"]) {
    const response = await upload(base, { model: requested });
    assert.equal(response.status, 503);
    assert.equal((await response.json()).error.code, "no_token");
  }
  assert.ok(!run.output().includes("test-elevenlabs"));
});

test("Scribe credentials are independent from Muse and duration limits apply before upload", { timeout: 10000 }, async (t) => {
  const run = await launch(t, { overrides: { MUSE_API_KEY: "test-key", MUSE_TOKEN: "test-muse" } });
  const response = await upload(await waitForServer(run), { model: "SCRIBE" });
  assert.equal(response.status, 503);
  const error = (await response.json()).error;
  assert.equal(error.code, "no_elevenlabs_token");
  assert.match(error.message, /ELEVENLABS_API_KEY/);

  const limited = await launch(t, {
    overrides: { MUSE_API_KEY: "test-key", ELEVENLABS_API_KEY: "test-elevenlabs", MUSE_MAX_AUDIO_SECONDS: "0.1" },
    preload: `globalThis.fetch = () => { throw new Error("must not upload audio over the limit"); };`,
  });
  const tooLong = await upload(await waitForServer(limited), { model: "scribe_v2" });
  assert.equal(tooLong.status, 413);
  assert.equal((await tooLong.json()).error.code, "audio_too_long");
});

test("other and omitted model names keep the configured Muse model and shared post-processing", { timeout: 15000 }, async (t) => {
  const run = await launch(t, {
    overrides: { MUSE_API_KEY: "test-key", MUSE_TOKEN: "test-muse", MUSE_MODEL: "existing-muse-model", MUSE_SPEED: "100" },
    preload: `
      import assert from "node:assert/strict";
      globalThis.WebSocket = class {
        addEventListener(name, handler) { this["on" + name] = handler; }
        constructor() {
          this.readyState = 0;
          setImmediate(() => { this.readyState = 1; this.onopen?.(); });
        }
        send(data) {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.authorization) {
            assert.equal(message.model, "existing-muse-model");
            assert.equal(message.authorization.accessToken, "test-muse");
            setImmediate(() => this.onmessage?.({ data: JSON.stringify({ sessionId: "muse-session" }) }));
          }
          if (message.endStream) {
            this.onmessage?.({ data: JSON.stringify({ transcript: { transcript: "这是软件测试。。", final: true } }) });
            this.close(1000);
          }
        }
        close(code) { this.readyState = 3; this.onclose?.({ code, reason: "done" }); }
      };
      globalThis.fetch = () => { throw new Error("Muse must not call ElevenLabs"); };
    `,
  });
  const base = await waitForServer(run);
  for (const model of [undefined, "whisper-1", "unknown"]) {
    const response = await upload(base, { model });
    assert.equal(response.status, 200, await response.clone().text());
    assert.equal((await response.json()).text, "這是軟體測試");
    assert.equal(response.headers.get("x-muse-session"), "muse-session");
  }
});

function clientFrame(type, flags, payload, sequence) {
  const head = Buffer.from([0x11, (type << 4) | flags, type === 0x1 ? 0x10 : 0x00, 0x00]);
  const seq = Buffer.alloc(4);
  seq.writeInt32BE(sequence, 0);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(payload.length, 0);
  return Buffer.concat([head, seq, size, payload]);
}

function serverPayload(buf) {
  let offset = (buf[0] & 0x0f) * 4;
  const flags = buf[1] & 0x0f;
  if (flags === 0x1 || flags === 0x3) offset += 4;
  const size = buf.readUInt32BE(offset);
  return { isLast: flags === 0x2 || flags === 0x3, json: JSON.parse(buf.subarray(offset + 4, offset + 4 + size).toString("utf8")) };
}

test("streaming finish keeps the sentence still in progress without waiting for speechComplete", { timeout: 15000 }, async (t) => {
  const run = await launch(t, {
    overrides: { MUSE_API_KEY: "test-key", MUSE_TOKEN: "test-muse" },
    preload: `
      globalThis.WebSocket = class {
        addEventListener(name, handler) { this["on" + name] = handler; }
        constructor() {
          this.readyState = 0;
          setImmediate(() => { this.readyState = 1; this.onopen?.(); });
        }
        emit(obj) { this.onmessage?.({ data: JSON.stringify(obj) }); }
        send(data) {
          if (typeof data !== "string") return;
          const message = JSON.parse(data);
          if (message.authorization) {
            setImmediate(() => {
              this.emit({ sessionId: "muse-session" });
              // Segment one: upstream final, then speechComplete for the same text.
              this.emit({ transcript: { transcript: "first sentence", final: true } });
              this.emit({ speechComplete: { turnId: 1, transcript: "first sentence" } });
              this.emit({ transcript: { transcript: "second", final: false } });
            });
          }
          if (message.endStream) {
            // Segment two only gets its final; speechComplete never arrives.
            setImmediate(() => this.emit({ transcript: { transcript: "second sentence", final: true } }));
            setTimeout(() => this.close(1000), 1000);
          }
        }
        close(code) { if (this.readyState === 3) return; this.readyState = 3; this.onclose?.({ code, reason: "done" }); }
      };
    `,
  });
  const base = await waitForServer(run);
  const ws = new WebSocket(base.replace("http:", "ws:") + "/api/v3/sauc/bigmodel", { headers: { "X-Api-Key": "test-key" } });
  const frames = [];
  ws.on("message", (data) => frames.push(serverPayload(Buffer.from(data))));
  await once(ws, "open");
  const config = { audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 }, request: { model_name: "bigmodel", show_utterances: true } };
  ws.send(clientFrame(0x1, 0x1, Buffer.from(JSON.stringify(config)), 1));
  ws.send(clientFrame(0x2, 0x1, Buffer.alloc(3200), 2));
  await delay(200);
  const sentAt = Date.now();
  ws.send(clientFrame(0x2, 0x3, Buffer.alloc(0), -3));
  await once(ws, "close");
  const last = frames.at(-1);
  assert.equal(last.isLast, true);
  const definite = last.json.result.utterances.filter((u) => u.definite).map((u) => u.text);
  assert.deepEqual(definite, ["first sentence", "second sentence"]);
  assert.equal(last.json.result.text, "first sentence second sentence");
  // Answered on the upstream final, not after upstream close or the 6 s timer.
  assert.ok(Date.now() - sentAt < 900, `finish took ${Date.now() - sentAt}ms`);
});
