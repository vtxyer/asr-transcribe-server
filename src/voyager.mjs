/**
 * Minimal Voyager ASR client (Node >= 22, uses the built-in undici WebSocket).
 *
 * Behaviour mirrored from Muse's own client:
 *   - VoyagerAsrClient.start()  : wss://shortwave.facebook.com/voyager/v1/asr/duplex?sessionId=<uuid>
 *   - 10 s ack timeout, audio buffered up to 4 s before the ack arrives
 *   - binary = PCM frames, text = JSON control/transcript frames
 *   - end of speech = {"endStream":{}} then wait for the final transcript
 */

import { EventEmitter } from "node:events";
import {
  BYTES_PER_AUDIO_SECOND,
  MAX_PENDING_AUDIO_BYTES,
  MODE,
  START_TO_ACK_TIMEOUT_MS,
  buildUrl,
  decodeServerMessage,
  encodeEndStream,
  encodeHandshake,
} from "./protocol.mjs";

export class VoyagerClient extends EventEmitter {
  constructor({
    token,
    model,
    mode = MODE.PUSH_TO_TALK,
    languageBias = [],
    sessionId = crypto.randomUUID(),
    url,
    ackTimeoutMs = START_TO_ACK_TIMEOUT_MS,
    debug = false,
  } = {}) {
    super();
    this.token = token;
    this.model = model;
    this.mode = mode;
    this.languageBias = languageBias;
    this.sessionId = sessionId;
    this.url = buildUrl(sessionId, url);
    this.ackTimeoutMs = ackTimeoutMs;
    this.debug = debug;

    this.ws = null;
    this.acked = false;
    this.endStreamRequested = false;
    this.endStreamSent = false;
    this.closed = false;
    this.bytesSent = 0;
    this.pending = [];
    this.pendingBytes = 0;
    this.droppedBytes = 0;
    this.openedAt = 0;
    this.ackAt = 0;
  }

  get audioMs() {
    return Math.round((this.bytesSent / BYTES_PER_AUDIO_SECOND) * 1000);
  }

  log(...args) {
    if (this.debug) console.error("[voyager]", ...args);
  }

  /** Resolves with the server sessionId once the handshake is acknowledged. */
  connect() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      ws.binaryType = "arraybuffer";
      this.ws = ws;

      const ackTimer = setTimeout(() => {
        if (this.acked) return;
        const err = new Error("handshake timeout: no ack within " + this.ackTimeoutMs + "ms");
        err.code = "handshake_timeout";
        reject(err);
        this.close(1000);
      }, this.ackTimeoutMs);

      let done = false;
      const settle = (fn, arg) => {
        if (done) return;
        done = true;
        clearTimeout(ackTimer);
        fn(arg);
      };

      ws.addEventListener("open", () => {
        this.openedAt = Date.now();
        this.log("open");
        const handle = encodeHandshake({
          token: this.token,
          model: this.model,
          mode: this.mode,
          languageBias: this.languageBias,
        });
        this.log("handshake", handle.replace(/"accessToken":"[^"]*"/, '"accessToken":"<redacted>"'));
        ws.send(handle);
      });

      ws.addEventListener("message", (ev) => {
        if (typeof ev.data !== "string") {
          this.emit("binary", Buffer.from(ev.data));
          return;
        }
        const msg = decodeServerMessage(ev.data);
        this.log("recv", msg.type, msg.transcript ?? msg.errorCode ?? msg.sessionId ?? "");

        if (msg.type === "error") {
          const err = new Error(`voyager ${msg.errorType ?? "error"}: ${msg.message}`);
          err.code = msg.errorCode ?? "server_error";
          err.errorType = msg.errorType;
          this.emit("error", err);
          settle(reject, err);
          return;
        }

        if (msg.type === "ack" && !this.acked) {
          this.acked = true;
          this.ackAt = Date.now();
          this.emit("ack", { sessionId: msg.sessionId, openToAckMs: this.ackAt - this.openedAt });
          this.drain();
          settle(resolve, msg.sessionId);
          return;
        }

        this.emit(msg.type, msg);
      });

      ws.addEventListener("close", (ev) => {
        this.closed = true;
        this.log("close", ev.code, ev.reason);
        this.emit("close", { code: ev.code, reason: ev.reason, bytesSent: this.bytesSent, audioMs: this.audioMs });
        if (!this.acked) {
          const err = new Error(`websocket closed before ack (${ev.code} ${ev.reason})`);
          err.code = "closed_before_ack";
          settle(reject, err);
        }
      });

      ws.addEventListener("error", (ev) => {
        this.log("socket error", ev?.message ?? ev?.type);
      });
    });
  }

  /** Send raw PCM (24 kHz / mono / s16le). Buffers pre-ack audio like the app does. */
  pushPcm(chunk) {
    if (this.closed) return;
    if (this.acked) {
      this.sendBinary(chunk);
      return;
    }
    if (this.pendingBytes + chunk.length > MAX_PENDING_AUDIO_BYTES) {
      this.droppedBytes += chunk.length;
      this.emit("audioDropped", { bytes: chunk.length, beforeAck: true, totalDropped: this.droppedBytes });
      return;
    }
    this.pending.push(chunk);
    this.pendingBytes += chunk.length;
  }

  sendBinary(chunk) {
    // Only the *sent* endStream closes the audio path; a pending request must not
    // discard audio that was buffered before the ack arrived.
    if (this.closed || this.endStreamSent) return;
    const view = chunk instanceof Uint8Array ? chunk : new Uint8Array(chunk);
    this.ws.send(view);
    this.bytesSent += view.length;
  }

  drain() {
    while (this.pending.length) {
      const next = this.pending.shift();
      this.pendingBytes -= next.length;
      this.sendBinary(next);
    }
    if (this.endStreamRequested && this.acked) this.flushEndStream();
  }

  /** Signal end of audio; the server answers with the final transcript, then closes 1000. */
  endStream() {
    if (this.endStreamRequested || this.closed) return;
    this.endStreamRequested = true;
    if (this.acked) this.flushEndStream();
  }

  flushEndStream() {
    if (this.endStreamSent || this.closed) return;
    this.endStreamSent = true;
    this.log("send endStream", { audioMs: this.audioMs });
    this.ws.send(encodeEndStream());
  }

  close(code = 1000, reason = "") {
    if (this.ws && !this.closed) {
      try {
        this.ws.close(code, reason);
      } catch {}
    }
  }

  /** Wait for one named event, with timeout. (Named waitFor so EventEmitter.once stays intact.) */
  waitFor(event, timeoutMs) {
    return new Promise((resolve, reject) => {
      const t = timeoutMs
        ? setTimeout(() => {
            cleanup();
            reject(new Error(`timeout waiting for "${event}" (${timeoutMs}ms)`));
          }, timeoutMs)
        : null;
      const cleanup = () => {
        if (t) clearTimeout(t);
        super.removeListener(event, onEvent);
      };
      const onEvent = (payload) => {
        cleanup();
        resolve(payload);
      };
      super.once(event, onEvent);
    });
  }
}
