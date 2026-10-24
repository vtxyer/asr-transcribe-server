import test from "node:test";
import assert from "node:assert/strict";
import { BYTES_PER_CHUNK } from "../src/protocol.mjs";

/** Minimal stand-in for the browser/undici WebSocket used by VoyagerClient. */
class FakeWebSocket {
  static instances = [];
  constructor(url) {
    this.url = url;
    this.sent = [];
    this.listeners = new Map();
    this.binaryType = "blob";
    FakeWebSocket.instances.push(this);
  }
  addEventListener(type, fn) {
    if (!this.listeners.has(type)) this.listeners.set(type, []);
    this.listeners.get(type).push(fn);
  }
  send(data) {
    this.sent.push(data);
  }
  close(code = 1000, reason = "") {
    for (const fn of this.listeners.get("close") ?? []) fn({ code, reason });
  }
  emit(type, payload) {
    for (const fn of this.listeners.get(type) ?? []) fn(payload);
  }
  open() {
    this.emit("open", {});
  }
  text(str) {
    this.emit("message", { data: str });
  }
  get frames() {
    return this.sent.map((d) => (typeof d === "string" ? JSON.parse(d) : { binary: true, size: d.length }));
  }
}

function withFakeSocket(fn) {
  return async () => {
    const original = globalThis.WebSocket;
    FakeWebSocket.instances = [];
    globalThis.WebSocket = FakeWebSocket;
    try {
      await fn();
    } finally {
      globalThis.WebSocket = original;
      FakeWebSocket.instances = [];
    }
  };
}

const { VoyagerClient } = await import("../src/voyager.mjs");

test(
  "buffered audio survives an early endStream request (pre-ack)",
  withFakeSocket(async () => {
    const client = new VoyagerClient({ token: "T", model: "m", sessionId: "s1" });
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0];

    assert.equal(ws.url, "wss://shortwave.facebook.com/voyager/v1/asr/duplex?sessionId=s1");
    ws.open();
    assert.deepEqual(ws.frames[0], {
      mode: "PUSH_TO_TALK",
      authorization: { accessToken: "T" },
      audioEncoding: "PCM_24KHZ",
      model: "m",
    });

    // two frames of audio buffered before the ack, then stop requested immediately
    client.pushPcm(new Uint8Array(BYTES_PER_CHUNK).fill(1));
    client.pushPcm(new Uint8Array(BYTES_PER_CHUNK).fill(2));
    assert.equal(ws.sent.length, 1, "audio must be buffered before the ack");
    client.endStream();

    ws.text(JSON.stringify({ sessionId: "s1" }));
    await connected;

    // handshake, audio x2, endStream — nothing dropped
    const kinds = ws.sent.map((d) => (typeof d === "string" ? "text" : "audio"));
    assert.deepEqual(kinds, ["text", "audio", "audio", "text"]);
    assert.deepEqual(ws.sent.at(-1) && JSON.parse(ws.sent.at(-1)), { endStream: {} });
    assert.equal(client.bytesSent, BYTES_PER_CHUNK * 2);
    assert.equal(client.audioMs, 40);
  }),
);

test(
  "ack is exposed and pre-ack drops are reported",
  withFakeSocket(async () => {
    const client = new VoyagerClient({ token: "T", model: "m", sessionId: "s2" });
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const dropped = [];
    client.on("audioDropped", (d) => dropped.push(d));
    // 5 s of audio: 4 s fits the pre-ack buffer, the rest is dropped
    for (let i = 0; i < 250; i++) client.pushPcm(new Uint8Array(BYTES_PER_CHUNK));
    assert.equal(dropped.length > 0, true);
    assert.equal(dropped.at(-1).beforeAck, true);

    ws.text(JSON.stringify({ sessionId: "s2" }));
    assert.equal(await connected, "s2");
    assert.equal(client.acked, true);
    assert.equal(client.pendingBytes, 0);
  }),
);

test(
  "server events are normalised",
  withFakeSocket(async () => {
    const client = new VoyagerClient({ token: "T", model: "m", sessionId: "s3" });
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0];
    ws.open();

    const seen = [];
    for (const ev of ["partial", "final", "speechStart", "speechEnd", "speechComplete"]) {
      client.on(ev, (m) => seen.push([ev, m.transcript ?? m.turnId]));
    }

    ws.text(JSON.stringify({ sessionId: "s3" }));
    await connected;
    ws.text(JSON.stringify({ transcript: { transcript: "hej", final: false } }));
    ws.text(JSON.stringify({ transcript: { transcript: "hej då", final: true } }));
    ws.text(JSON.stringify({ speechStart: { turnId: 1, audioProcessedMs: 120 } }));
    ws.text(JSON.stringify({ speechEnd: { turnId: 1, audioProcessedMs: 900 } }));
    ws.text(JSON.stringify({ speechComplete: { turnId: 1, transcript: "hej då" } }));

    assert.deepEqual(seen, [
      ["partial", "hej"],
      ["final", "hej då"],
      ["speechStart", 1],
      ["speechEnd", 1],
      ["speechComplete", "hej då"],
    ]);
  }),
);

test(
  "server error rejects the handshake promise",
  withFakeSocket(async () => {
    const client = new VoyagerClient({ token: "bad", model: "m", sessionId: "s4" });
    const connected = client.connect();
    const ws = FakeWebSocket.instances[0];
    client.on("error", () => {});
    ws.open();
    ws.text(
      JSON.stringify({
        error: { message: "Unauthorized", errorType: "authentication_error", errorCode: "invalid_api_key" },
      }),
    );
    await assert.rejects(connected, (err) => err.code === "invalid_api_key");
  }),
);
