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

async function launch(t, { dotenv, overrides = {} } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "asr-config-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await cp(join(root, "server.mjs"), join(dir, "server.mjs"));
  await cp(join(root, "src"), join(dir, "src"), { recursive: true });
  await symlink(join(root, "node_modules"), join(dir, "node_modules"), "dir");
  if (dotenv !== undefined) await writeFile(join(dir, ".env"), dotenv, { mode: 0o600 });
  const env = { ...process.env };
  for (const name of Object.keys(env)) {
    if (/^(MUSE_|META_TOKEN$|HOST$|PORT$|OPENCC_TARGET$|NODE_OPTIONS$)/.test(name)) delete env[name];
  }
  Object.assign(env, { HOST: "127.0.0.1", PORT: "0" }, overrides);
  // Launch from another working directory to verify project-relative .env loading.
  const child = spawn(process.execPath, [join(dir, "server.mjs")], { cwd: tmpdir(), env });
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
