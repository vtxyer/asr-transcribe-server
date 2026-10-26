/**
 * 火山引擎「大模型流式语音识别」相容層：
 *   客戶端  ──WSS 二進位框──▶  本檔  ──Voyager WSS──▶  Meta Muse ASR
 *
 * 客戶端送的是 16 kHz PCM（火山協議只支援 16000），
 * Voyager 只吃 24 kHz，所以中間用 Upsampler16to24 轉。
 *
 * 端點：/api/v3/sauc/bigmodel、/api/v3/sauc/bigmodel_nostream、/api/v3/sauc/bigmodel_async
 */

import { WebSocketServer } from "ws";
import { VoyagerClient } from "./voyager.mjs";
import { MODE, padToChunk, BYTES_PER_CHUNK } from "./protocol.mjs";
import { normalizeTranscript } from "./text.mjs";
import {
  MSG,
  Upsampler16to24,
  buildError,
  buildFrame,
  buildResultPayload,
  parseFrame,
} from "./volcengine.mjs";

const WS_PATHS = /^\/api\/v3\/sauc\/bigmodel(_nostream|_async)?\/?$/;

export function attachVolcengineWs(httpServer, { token, getToken, model, apiKey, log = console.log }) {
  const wss = new WebSocketServer({ noServer: true });

  httpServer.on("upgrade", (req, socket, head) => {
    const url = new URL(req.url, "http://localhost");
    if (!WS_PATHS.test(url.pathname)) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    const url = new URL(req.url, "http://localhost");
    const h = req.headers;
    const given = (h["x-api-key"] || h["x-api-access-key"] || h["x-api-app-key"] || url.searchParams.get("key") || "").toString();
    const startedAt = Date.now();
    const reqId = (h["x-api-request-id"] || "").toString();
    const resourceId = (h["x-api-resource-id"] || "").toString();
    const ua = (h["user-agent"] || "").toString().slice(0, 40);

    if (apiKey && given !== apiKey) {
      log(JSON.stringify({ t: new Date().toISOString(), ws: "auth-reject", path: url.pathname, hasKey: !!given, resourceId, ua }));
      ws.send(buildError("authentication failed: X-Api-Key mismatch", 45000001));
      ws.close(1008, "auth");
      return;
    }

    let voyager = null;
    let voyagerReady = false;
    let earlyAudio = [];
    let earlyBytes = 0;
    let upsampler = null;
    let showUtterances = false;
    let compression = 0;
    let seq = 0;
    let bytesIn = 0;
    let pcm24 = 0;
    let closed = false;
    let finalSent = false;
    let pending = Buffer.alloc(0);
    let utterances = [];
    let fullText = "";
    let lastEmit = 0;
    let audioMs = 0;
    let lastPartial = "";
    // Text of the segment still being spoken (partial or upstream final that
    // has not been followed by speechComplete yet). Folded into the definite
    // result on finish so the last sentence is never dropped.
    let tail = "";
    const composeText = () =>
      normalizeTranscript([...utterances.map((u) => u.text), tail].filter(Boolean).join(" "));
    const payloadUtterances = () =>
      tail ? [...utterances, { text: tail, startTime: utterances.at(-1)?.endTime ?? 0, endTime: audioMs, definite: false }] : utterances;

    const send = (payload, { isLast = false } = {}) => {
      if (closed || ws.readyState !== ws.OPEN) return;
      seq += isLast ? 0 : 1;
      ws.send(buildFrame(payload, { sequence: seq, isLast, compression }));
    };

    let lastSent = "";
    const emit = (force = false) => {
      const now = Date.now();
      if (!force && now - lastEmit < 100) return; // 最多每秒 10 次
      if (fullText === lastSent) return; // 文字沒變就不重送
      lastEmit = now;
      lastSent = fullText;
      send(buildResultPayload({ text: fullText, utterances: payloadUtterances(), duration: audioMs, showUtterances }));
    };

    let finishTimer = null;
    let endRequested = false;
    const finish = (reason = "client_last_packet") => {
      if (finalSent || closed) return;
      finalSent = true;
      if (finishTimer) clearTimeout(finishTimer);
      if (tail) {
        utterances.push({ text: tail, startTime: utterances.at(-1)?.endTime ?? 0, endTime: audioMs, definite: true });
        tail = "";
        fullText = composeText();
      }
      const text = fullText;
      if (!text) {
        send({ error: "no transcript", code: 20000003 }, { isLast: true });
      } else {
        send(buildResultPayload({ text, utterances, duration: audioMs, showUtterances }), { isLast: true });
      }
      log(
        JSON.stringify({
          t: new Date().toISOString(),
          ws: "done",
          path: url.pathname,
          reqId,
          resourceId,
          reason,
          audioSec: Number((audioMs / 1000).toFixed(2)),
          chars: text.length,
          bytesIn,
          ms: Date.now() - startedAt,
        }),
      );
      setTimeout(() => {
        closed = true;
        try {
          ws.close(1000, "done");
        } catch {}
      }, 50);
    };

    const startVoyager = async () => {
      const tok = getToken ? await getToken() : token;
      if (!tok) {
        ws.send(buildError("server has no Muse token configured", 55000031, { compression }));
        closed = true;
        ws.close(1011, "no-token");
        return;
      }
      voyager = new VoyagerClient({ token: tok, model, mode: MODE.ENDPOINTING });
      voyager.on("partial", (m) => {
        const t = normalizeTranscript(m.transcript || "");
        if (t) {
          lastPartial = t;
          tail = t;
          fullText = composeText();
          emit();
        }
      });
      voyager.on("speechStart", (m) => {
        if (typeof m.audioProcessedMs === "number") audioMs = Math.max(audioMs, m.audioProcessedMs);
      });
      voyager.on("speechEnd", (m) => {
        if (typeof m.audioProcessedMs === "number") audioMs = Math.max(audioMs, m.audioProcessedMs);
      });
      voyager.on("speechComplete", (m) => {
        const t = normalizeTranscript(m.transcript || "");
        const end = typeof m.audioProcessedMs === "number" ? m.audioProcessedMs : audioMs;
        if (t) {
          utterances.push({ text: t, startTime: utterances.length ? utterances.at(-1).endTime : 0, endTime: end, definite: true });
        }
        tail = "";
        fullText = composeText();
        audioMs = Math.max(audioMs, end);
        emit(true);
      });
      voyager.on("final", (m) => {
        const t = normalizeTranscript(m.transcript || "");
        // Upstream final is per segment; a duplicate of the segment that
        // speechComplete already committed must not be re-added as tail.
        if (t && !(tail === "" && utterances.at(-1)?.text === t)) {
          tail = t;
          fullText = composeText();
          emit(true);
        }
        // Upstream sends the final ~0.2 s after endStream but only closes the
        // socket ~1 s later; nothing arrives in between, so answer right away.
        if (endRequested) finish("upstream_final");
      });
      voyager.on("close", () => {
        if (!finalSent && !closed) finish("upstream_closed");
      });
      voyager.on("error", (err) => {
        log(JSON.stringify({ t: new Date().toISOString(), ws: "voyager-error", code: err.code, msg: err.message }));
        if (!closed && ws.readyState === ws.OPEN) {
          send({ error: err.message, code: 45000001 }, { isLast: true });
        }
        closed = true;
        try {
          ws.close(1011, "upstream error");
        } catch {}
      });
      voyager.connect().then(() => {
        voyagerReady = true;
        const queued = earlyAudio;
        earlyAudio = [];
        earlyBytes = 0;
        for (const buf of queued) pushPcm(buf);
      }).catch((err) => {
        log(JSON.stringify({ t: new Date().toISOString(), ws: "voyager-connect-fail", code: err.code, msg: err.message }));
        try {
          ws.send(buildError(`upstream connect failed: ${err.message}`, 55000031, { compression }));
          ws.close(1011, "upstream");
        } catch {}
        closed = true;
      });
    };

    log(JSON.stringify({ t: new Date().toISOString(), ws: "open", path: url.pathname, reqId, resourceId, ua }));

    ws.on("message", (data, isBinary) => {
      if (closed) return;
      if (!isBinary) {
        // 少數 client 會用 text frame 傳 JSON config
        try {
          handleConfig(JSON.parse(data.toString()));
        } catch {
          ws.send(buildError("bad config frame", 45000001, { compression }));
        }
        return;
      }
      pending = pending.length ? Buffer.concat([pending, data]) : Buffer.from(data);
      for (;;) {
        const frame = parseFrame(pending);
        if (!frame) break;
        pending = pending.subarray(frame.consumed);

        if (frame.messageType === MSG.FULL_CLIENT_REQUEST) {
          compression = frame.compression === 1 ? 1 : 0;
          try {
            handleConfig(JSON.parse(frame.payload.toString("utf8")));
          } catch (err) {
            ws.send(buildError(`bad json: ${err.message}`, 45000001));
          }
        } else if (frame.messageType === MSG.AUDIO_ONLY) {
          handleAudio(frame.payload);
        }
        if (frame.isLast) {
          handleAudio(Buffer.alloc(0));
          requestFinish();
        }
      }
    });

    function requestFinish() {
      if (finalSent || closed) return;
      endRequested = true;
      try {
        voyager?.endStream();
      } catch {}
      // 上游吐完 final 就會 close；保險起見 6 秒後硬收
      finishTimer = setTimeout(() => finish("timeout"), 6000);
    }

    function handleConfig(cfg) {
      const audio = cfg?.audio || {};
      const request = cfg?.request || {};
      showUtterances = !!request.show_utterances;
      const rate = Number(audio.rate || 16000);
      upsampler = rate === 16_000 ? new Upsampler16to24(16_000, 24_000) : null;
      startVoyager();
      log(
        JSON.stringify({
          t: new Date().toISOString(),
          ws: "config",
          format: audio.format,
          codec: audio.codec,
          rate,
          bits: audio.bits,
          channel: audio.channel,
          model: request.model_name,
          showUtterances,
          resultType: request.result_type,
        }),
      );
      if (!upsampler) {
        ws.send(buildError(`unsupported rate ${rate} (火山協議只支援 16000)`, 45000001));
        closed = true;
        ws.close(1008, "rate");
      }
    }

    function pushPcm(buf) {
      if (!voyager || closed) return;
      // Voyager 喜歡 20 ms 一包（960 bytes @ 24k）
      for (let off = 0; off < buf.length; off += BYTES_PER_CHUNK) {
        const frame = buf.subarray(off, off + BYTES_PER_CHUNK);
        voyager.pushPcm(frame.length === BYTES_PER_CHUNK ? frame : padToChunk(frame, BYTES_PER_CHUNK));
      }
    }

    function handleAudio(pcm16) {
      if (!upsampler || closed) return;
      bytesIn += pcm16.length;
      const up = upsampler.process(pcm16);
      if (!up.length) return;
      pcm24 += up.length;
      if (!voyagerReady) {
        // handshake 還沒完成前先排隊（上限 8 秒）
        if (earlyBytes + up.length > 24_000 * 2 * 8) return;
        earlyAudio.push(up);
        earlyBytes += up.length;
        return;
      }
      pushPcm(up);
    }

    ws.on("close", (code) => {
      const wasClosed = closed;
      closed = true;
      if (!wasClosed) {
        log(JSON.stringify({ t: new Date().toISOString(), ws: "client-close", code, audioSec: Number((pcm24 / 48000).toFixed(2)), chars: fullText.length }));
      }
      try {
        voyager?.close(1000);
      } catch {}
    });

    ws.on("error", () => {
      closed = true;
      try {
        voyager?.close(1000);
      } catch {}
    });
  });

  return wss;
}
