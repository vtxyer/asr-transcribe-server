/**
 * 豆包串流（DoubaoStream + 火山相容 WS 的 doubao 路線）離線測試：
 * 起一個講 Doubao IME protobuf 的假上游，不打真網路。
 */

import test from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import WebSocket, { WebSocketServer } from "ws";

import { DoubaoStream } from "../src/doubao-stream.mjs";
import { attachVolcengineWs, selectBackend } from "../src/volcengine-ws.mjs";
import { MSG, buildFrame, parseFrame } from "../src/volcengine.mjs";
import { FRAME_STATE } from "../src/doubao.mjs";

// ── protobuf（測試端：解 AsrRequest、編 AsrResponse） ─────────────────
function decodeRequest(buf) {
  const out = {};
  let i = 0;
  const rv = () => {
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
    const key = rv();
    const f = key >> 3;
    const w = key & 7;
    if (w === 0) out[f] = rv();
    else if (w === 2) {
      const len = rv();
      const sl = buf.subarray(i, i + len);
      i += len;
      out[f] = f === 7 ? sl : sl.toString("utf8");
    }
  }
  return { token: out[2], method: out[5], payload: out[6], audio: out[7], requestId: out[8], frameState: out[9] };
}
function varint(n) {
  const o = [];
  let v = n;
  while (v > 0x7f) {
    o.push((v % 128) | 0x80);
    v = Math.floor(v / 128);
  }
  o.push(v);
  return Buffer.from(o);
}
const pbStr = (f, s) => {
  const b = Buffer.from(s, "utf8");
  return Buffer.concat([varint((f << 3) | 2), varint(b.length), b]);
};
function encodeResponse({ type, status = 20000000, message = "OK", result }) {
  const parts = [];
  if (type) parts.push(pbStr(4, type));
  parts.push(Buffer.concat([varint(5 << 3), varint(status)]));
  parts.push(pbStr(6, message));
  if (result) parts.push(pbStr(7, JSON.stringify(result)));
  return Buffer.concat(parts);
}
const interim = (text, st, durMs, extra = {}) => ({
  results: [{ text, start_time: st, end_time: 0, is_interim: true, index: 0, ...extra }],
  extra: { audio_duration: durMs },
});

/**
 * 假上游。script({ session, frames, frameState, ws, send }) 在每個音訊幀後被呼叫；
 * onStart(session) 可以讓 StartTask 失敗。
 */
async function fakeDoubao(t, { script = () => {}, onStart = () => null, onFinish } = {}) {
  const wss = new WebSocketServer({ port: 0, host: "127.0.0.1" });
  await once(wss, "listening");
  t.after(() => new Promise((r) => wss.close(r)));
  const state = { sessions: [], tokens: [] };
  wss.on("connection", (ws) => {
    const session = { n: state.sessions.length + 1, frames: 0, states: [], finished: false };
    state.sessions.push(session);
    const send = (o) => ws.readyState === ws.OPEN && ws.send(encodeResponse(o));
    ws.on("message", (data) => {
      const req = decodeRequest(Buffer.from(data));
      if (req.method === "StartTask") {
        state.tokens.push(req.token);
        const fail = onStart(session, req);
        if (fail) return send(fail);
        return send({ type: "TaskStarted" });
      }
      if (req.method === "StartSession") return send({ type: "SessionStarted" });
      if (req.method === "TaskRequest") {
        session.frames += 1;
        session.states.push(req.frameState);
        script({ session, frames: session.frames, frameState: req.frameState, ws, send });
        return;
      }
      if (req.method === "FinishSession") {
        session.finished = true;
        if (onFinish) onFinish({ session, send, ws });
        else send({ type: "SessionFinished" });
      }
    });
  });
  return { url: `ws://127.0.0.1:${wss.address().port}/ocean/api/v1/ws`, state };
}

const cred = { device_id: "123", token: "tok-A", cdid: "c" };
const frames = (n) => Buffer.alloc(640 * n); // n × 20 ms @ 16 kHz

function collect(stream) {
  const ev = { partial: [], definite: [], rollover: [], error: [] };
  for (const k of Object.keys(ev)) stream.on(k, (e) => ev[k].push(e));
  return ev;
}

async function feed(stream, n, { chunk = 5, pace = 0 } = {}) {
  for (let i = 0; i < n; i += chunk) {
    stream.pushPcm16(frames(Math.min(chunk, n - i)));
    await delay(pace);
  }
}

async function waitFor(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (fn()) return;
    await delay(10);
  }
  throw new Error("waitFor timeout");
}

test("selectBackend: query model / X-Api-Resource-Id 選豆包，其餘 Muse", () => {
  const u = (q) => new URL(`http://x/api/v3/sauc/bigmodel${q}`);
  assert.equal(selectBackend(u("?model=doubao_ime"), {}), "doubao");
  assert.equal(selectBackend(u("?model=Doubao"), {}), "doubao");
  assert.equal(selectBackend(u(""), { "x-api-resource-id": "volc.doubao.sauc" }), "doubao");
  assert.equal(selectBackend(u(""), { "x-api-resource-id": "volc.bigasr.sauc.duration" }), "muse");
  assert.equal(selectBackend(u("?model=bigmodel"), {}), "muse");
  assert.equal(selectBackend(u(""), {}), "muse");
});

test("partial 與 definite：段內 interim → partial，新段開始 → 上一段 definite（帶 ms）", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ frames: f, send }) => {
      if (f === 10) send({ result: interim("你好", 0, 200) });
      if (f === 20) send({ result: interim("你好世界。", 0, 400) });
      if (f === 400) send({ result: interim("第二", 7.5, 8000) }); // start_time 往後跳 → 新段
      if (f === 410) send({ result: interim("第二段", 7.5, 8200) });
    },
  });
  const s = new DoubaoStream({ wsUrl: up.url, getCredentials: async () => cred, recover: async () => false, maxSessionMs: 0 });
  const ev = collect(s);
  s.start();
  await feed(s, 420);
  await waitFor(() => ev.partial.some((p) => p.text === "第二段"));
  assert.deepEqual(ev.partial.slice(0, 2).map((p) => p.text), ["你好", "你好世界。"]);
  assert.equal(ev.definite.length, 1);
  assert.deepEqual(ev.definite[0], { text: "你好世界。", startMs: 0, endMs: 400 });
  // 第一個上游幀要是 FIRST，之後 MIDDLE
  assert.equal(up.state.sessions[0].states[0], FRAME_STATE.FIRST);
  assert.equal(up.state.sessions[0].states[1], FRAME_STATE.MIDDLE);
  await s.finish();
  assert.equal(ev.definite.length, 2);
  assert.equal(ev.definite[1].text, "第二段");
  assert.equal(ev.definite[1].startMs, 7500);
  s.close();
});

test("is_interim=false 立即定稿；結尾送 LAST 幀 + FinishSession，上游 final 收得到", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ frames: f, frameState, send }) => {
      if (f === 5) send({ result: interim("一句", 0, 100) });
      if (frameState === FRAME_STATE.LAST) {
        send({ result: { results: [{ text: "一句話。", start_time: 0, is_interim: false, index: 0 }], extra: { audio_duration: 220 } } });
      }
    },
  });
  const s = new DoubaoStream({ wsUrl: up.url, getCredentials: async () => cred, recover: async () => false });
  const ev = collect(s);
  s.start();
  await feed(s, 10);
  s.pushPcm16(Buffer.alloc(100)); // 不滿一幀的尾巴也要送出
  await s.finish();
  const sess = up.state.sessions[0];
  assert.equal(sess.finished, true);
  assert.equal(sess.states.at(-1), FRAME_STATE.LAST);
  assert.equal(sess.frames, 12); // 10 + 尾巴補滿 1 + LAST
  assert.deepEqual(ev.definite.map((d) => d.text), ["一句話。"]);
});

test("end-of-stream：上游只給 interim 就結束，最後一句仍定稿不丟", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ frames: f, send }) => {
      if (f === 5) send({ result: interim("最後一句還在講", 0, 100) });
    },
    onFinish: ({ ws }) => setTimeout(() => ws.close(), 20), // 不給 final、直接關
  });
  const s = new DoubaoStream({ wsUrl: up.url, getCredentials: async () => cred, recover: async () => false });
  const ev = collect(s);
  s.start();
  await feed(s, 10);
  await waitFor(() => ev.partial.length > 0);
  await s.finish();
  assert.deepEqual(ev.definite.map((d) => d.text), ["最後一句還在講"]);
  assert.equal(ev.rollover.length, 0); // 收尾時的關線不算換線
});

test("session rollover：上游中途斷線 → 新 session 重送目前段落音訊，進行中句子不掉", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ session, frames: f, ws, send }) => {
      if (session.n === 1) {
        if (f === 10) send({ result: interim("第一段完成", 0, 200) });
        if (f === 300) send({ result: interim("第二段講到", 6, 6000) }); // 段落邊界
        if (f === 350) ws.close(); // 上游掉線（例如 session 上限）
      } else {
        // 新 session：重送的音訊從第二段開頭往前 3 s 起算
        if (f === 200) send({ result: interim("第二段講到一半接著講完", 3, 4000) });
      }
    },
  });
  const s = new DoubaoStream({
    wsUrl: up.url,
    getCredentials: async () => cred,
    recover: async () => false,
    maxSessionMs: 0,
    replayLeadMs: 3000,
  });
  const ev = collect(s);
  s.start();
  await feed(s, 360, { chunk: 10, pace: 1 });
  await waitFor(() => up.state.sessions.length === 2);
  await feed(s, 100, { chunk: 10, pace: 1 });
  await waitFor(() => ev.partial.some((p) => p.text.includes("接著講完")));
  await s.finish();

  assert.equal(ev.rollover.length, 1);
  assert.equal(up.state.sessions.length, 2);
  // 新 session 從第二段開頭（6 s = 第 300 幀）往前 3 s（150 幀）重送 → 從第 150 幀開始
  const s2 = up.state.sessions[1];
  assert.equal(s2.states[0], FRAME_STATE.FIRST);
  assert.ok(s2.frames >= 460 - 150, `session 2 got ${s2.frames} frames`);
  assert.deepEqual(ev.definite.map((d) => d.text), ["第一段完成", "第二段講到一半接著講完"]);
  // 時間軸接續在全域時間上（offset 150 幀 = 3000 ms + start_time 3 s = 6000 ms）
  assert.equal(ev.definite[1].startMs, 6000);
  assert.ok(ev.definite[1].endMs >= 9000);
  assert.equal(ev.error.length, 0);
});

test("max session：段落邊界時主動換線", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ session, frames: f, send }) => {
      if (session.n === 1) {
        if (f === 5) send({ result: interim("舊的一段", 0, 100) });
        if (f === 60) send({ result: { results: [{ text: "新", start_time: 0.8, is_interim: true, index: 1 }], extra: { audio_duration: 1200 } } }); // index 變 → 新段
      } else if (f === 30) send({ result: interim("新段", 1, 600) }); // 重送從 0.8 s − 3 s → 0 起
    },
  });
  const s = new DoubaoStream({ wsUrl: up.url, getCredentials: async () => cred, recover: async () => false, maxSessionMs: 1 });
  const ev = collect(s);
  s.start();
  await feed(s, 80, { chunk: 5, pace: 2 });
  await waitFor(() => up.state.sessions.length === 2);
  await feed(s, 40, { chunk: 5, pace: 2 });
  await waitFor(() => ev.partial.some((p) => p.text === "新段"));
  await s.finish();
  assert.ok(ev.rollover.some((r) => r.reason === "max_session"));
  assert.deepEqual(ev.definite.map((d) => d.text), ["舊的一段", "新段"]);
});

test("auth reject：40200001 → recoverCredentials 換 token 後重試一次", async (t) => {
  const up = await fakeDoubao(t, {
    onStart: (session, req) => (req.token === "bad" ? { type: "TaskFailed", status: 40200001, message: "invalid token" } : null),
    script: ({ frames: f, send }) => f === 3 && send({ result: interim("好了", 0, 60) }),
  });
  let current = { ...cred, token: "bad" };
  let recovers = 0;
  const s = new DoubaoStream({
    wsUrl: up.url,
    getCredentials: async () => current,
    recover: async (err) => {
      recovers += 1;
      assert.equal(err.code, "40200001");
      current = { ...cred, token: "good" };
      return true;
    },
  });
  const ev = collect(s);
  s.start();
  await feed(s, 5);
  await waitFor(() => ev.partial.length > 0);
  await s.finish();
  assert.equal(recovers, 1);
  assert.deepEqual(up.state.tokens, ["bad", "good"]);
  assert.deepEqual(ev.definite.map((d) => d.text), ["好了"]);
});

test("auth reject：一直失敗 → error 事件（不會無限重試）", async (t) => {
  const up = await fakeDoubao(t, {
    onStart: () => ({ type: "TaskFailed", status: 40200001, message: "invalid token" }),
  });
  let recovers = 0;
  const s = new DoubaoStream({
    wsUrl: up.url,
    getCredentials: async () => cred,
    recover: async () => (++recovers, true),
    maxReconnects: 0,
  });
  const ev = collect(s);
  s.start();
  await waitFor(() => ev.error.length > 0);
  assert.equal(ev.error[0].code, "40200001");
  assert.equal(recovers, 1);
  assert.equal(up.state.sessions.length, 2); // 原本 + 重試一次
  s.close();
});

// ── 火山相容 WS 端到端（doubao 路線） ─────────────────────────────────
function clientFrame(obj, { type = MSG.FULL_CLIENT_REQUEST, last = false } = {}) {
  const body = Buffer.isBuffer(obj) ? obj : Buffer.from(JSON.stringify(obj));
  const head = Buffer.from([0x11, (type << 4) | (last ? 0x2 : 0x0), type === MSG.AUDIO_ONLY ? 0x00 : 0x10, 0]);
  const size = Buffer.alloc(4);
  size.writeUInt32BE(body.length);
  return Buffer.concat([head, size, body]);
}

async function volcServer(t, upUrl, { apiKey = "k" } = {}) {
  const dir = await mkdtemp(join(tmpdir(), "doubao-ws-test-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const credentialPath = join(dir, "cred.json");
  await writeFile(credentialPath, JSON.stringify(cred));
  const server = createServer();
  const logs = [];
  attachVolcengineWs(server, {
    getToken: async () => "muse",
    model: "m",
    apiKey,
    log: (l) => logs.push(JSON.parse(l)),
    doubaoOptions: { wsUrl: upUrl, credentialPath, maxSessionMs: 0 },
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  t.after(() => new Promise((r) => server.close(r)));
  return { base: `ws://127.0.0.1:${server.address().port}`, logs };
}

test("WS ?model=doubao_ime：partial + 最後 definite utterances（OpenCC twp）", async (t) => {
  const up = await fakeDoubao(t, {
    script: ({ frames: f, frameState, send }) => {
      if (f === 5) send({ result: interim("这个软件", 0, 100) });
      if (f === 400) send({ result: interim("第二句", 6.5, 8000) });
      if (frameState === FRAME_STATE.LAST) send({ result: { results: [{ text: "第二句结束。", start_time: 6.5, is_interim: false, index: 0 }], extra: { audio_duration: 9000 } } });
    },
  });
  const { base, logs } = await volcServer(t, up.url);
  const ws = new WebSocket(`${base}/api/v3/sauc/bigmodel?model=doubao_ime`, { headers: { "X-Api-Key": "k" } });
  const msgs = [];
  ws.on("message", (d) => msgs.push(parseFrame(Buffer.from(d))));
  await once(ws, "open");
  ws.send(clientFrame({ audio: { format: "pcm", rate: 16000, bits: 16, channel: 1 }, request: { show_utterances: true } }));
  for (let i = 0; i < 45; i++) {
    ws.send(clientFrame(frames(10), { type: MSG.AUDIO_ONLY }));
    await delay(2);
  }
  await waitFor(() => msgs.length > 0);
  ws.send(clientFrame(Buffer.alloc(0), { type: MSG.AUDIO_ONLY, last: true }));
  await once(ws, "close");

  const payloads = msgs.map((m) => JSON.parse(m.payload.toString()));
  assert.equal(payloads[0].result.text, "這個軟體");
  assert.equal(payloads[0].result.utterances[0].definite, false);
  const last = payloads.at(-1);
  assert.equal(msgs.at(-1).isLast, true);
  assert.deepEqual(
    last.result.utterances.map((u) => [u.text, u.start_time, u.definite]),
    [["這個軟體", 0, true], ["第二句結束", 6500, true]],
  );
  assert.equal(last.result.text, "這個軟體 第二句結束");
  assert.ok(logs.some((l) => l.ws === "open" && l.backend === "doubao"));
  assert.ok(logs.some((l) => l.ws === "done" && l.reason === "upstream_final"));
});

test("WS doubao 路線：API key 錯 → auth-reject，不連上游", async (t) => {
  const up = await fakeDoubao(t);
  const { base, logs } = await volcServer(t, up.url);
  const ws = new WebSocket(`${base}/api/v3/sauc/bigmodel?model=doubao_ime`, { headers: { "X-Api-Key": "wrong" } });
  const msgs = [];
  ws.on("message", (d) => msgs.push(parseFrame(Buffer.from(d))));
  const [code] = await once(ws, "close");
  assert.equal(code, 1008);
  assert.equal(msgs[0].messageType, MSG.ERROR);
  assert.ok(logs.some((l) => l.ws === "auth-reject" && l.backend === "doubao"));
  assert.equal(up.state.sessions.length, 0);
});

test("WS doubao 路線：上游憑證一直被拒 → client 收到錯誤框", async (t) => {
  const up = await fakeDoubao(t, { onStart: () => ({ type: "TaskFailed", status: 40000000, message: "nope" }) });
  const { base } = await volcServer(t, up.url);
  const ws = new WebSocket(`${base}/api/v3/sauc/bigmodel`, { headers: { "X-Api-Key": "k", "X-Api-Resource-Id": "doubao_ime" } });
  const msgs = [];
  ws.on("message", (d) => msgs.push(parseFrame(Buffer.from(d))));
  await once(ws, "open");
  ws.send(clientFrame({ audio: { format: "pcm", rate: 16000 }, request: {} }));
  const [code] = await once(ws, "close");
  assert.equal(code, 1011);
  assert.equal(msgs.at(-1).messageType, MSG.ERROR);
  assert.match(JSON.parse(msgs.at(-1).payload.toString()).error, /upstream failed/);
});
