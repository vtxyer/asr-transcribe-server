/**
 * Voyager ASR wire protocol constants + frame helpers.
 *
 * Recovered from Muse (com.facebook.aura) 13.0.0.4.159:
 *   com.facebook.aura.composer.dictation.voyager.*
 *
 * Transport : WSS, no transport-level auth, no subprotocols, no extra headers.
 *             HatchTransport.webSocket(HatchAuthScheme.META_UNAUTH) -> headers = emptyMap()
 * Uplink    : binary frames = raw PCM, 24 kHz, mono, signed 16-bit little endian.
 *             20 ms per frame  =>  480 samples  =>  960 bytes.
 * Downlink  : JSON text frames.
 */

export const WS_URL = "wss://shortwave.facebook.com/voyager/v1/asr/duplex";

/** VoyagerAsrSession.AUDIO_ENCODING */
export const AUDIO_ENCODING = "PCM_24KHZ";
/** VoyagerDictationEngine.DEFAULT_MODEL (mobile-config override: android_lobster_voice.voyager_dictation_model_name) */
export const DEFAULT_MODEL = "prod_hatch_android";

export const SAMPLE_RATE = 24_000;
export const CHANNELS = 1;
export const BYTES_PER_SAMPLE = 2;
/** VoyagerDictationEngine.BYTES_PER_AUDIO_SECOND = 48000 */
export const BYTES_PER_AUDIO_SECOND = SAMPLE_RATE * BYTES_PER_SAMPLE;
/** HatchDictationMicRecorder.CHUNK_DURATION_MS */
export const CHUNK_DURATION_MS = 20;
/** 480 samples * 2 bytes */
export const BYTES_PER_CHUNK = (SAMPLE_RATE * CHUNK_DURATION_MS) / 1000 * BYTES_PER_SAMPLE;
/** VoyagerAsrSession.MAX_PENDING_AUDIO_BYTES — app buffers 4 s of audio before the ack */
export const MAX_PENDING_AUDIO_BYTES = 192_000;
/** VoyagerAsrSession.START_TO_ACK_TIMEOUT_MS */
export const START_TO_ACK_TIMEOUT_MS = 10_000;

/** VoyagerAsrMode — only two wire values exist */
export const MODE = Object.freeze({
  PUSH_TO_TALK: "PUSH_TO_TALK",
  ENDPOINTING: "ENDPOINTING",
});

export function buildUrl(sessionId, base = WS_URL) {
  return `${base}?sessionId=${encodeURIComponent(sessionId)}`;
}

/**
 * VoyagerAsrJsonKt.encodeVoyagerAsrHandshake(
 *   accessToken, model, "PCM_24KHZ", mode, languageBias)
 *
 * kotlinx.serialization skips optional nulls, so languageBias disappears when empty.
 */
export function encodeHandshake({ token, model = DEFAULT_MODEL, mode = MODE.PUSH_TO_TALK, languageBias = [] }) {
  if (!token) throw new Error("encodeHandshake: token required");
  if (!model) throw new Error("encodeHandshake: model required");
  const payload = {
    mode,
    authorization: { accessToken: token },
    audioEncoding: AUDIO_ENCODING,
    model,
  };
  if (Array.isArray(languageBias) && languageBias.length > 0) {
    payload.languageBias = languageBias;
  }
  return JSON.stringify(payload);
}

/** VoyagerAsrEndStreamJson -> {"endStream":{}} */
export function encodeEndStream() {
  return JSON.stringify({ endStream: {} });
}

/**
 * Split a PCM byte stream into 20 ms frames, keeping a remainder buffer.
 * Mirrors HatchDictationMicRecorder emitting one onPcmChunk per 20 ms.
 */
export function createFrameSplitter(chunkBytes = BYTES_PER_CHUNK) {
  let rest = Buffer.alloc(0);
  return {
    push(buf) {
      rest = rest.length ? Buffer.concat([rest, buf]) : buf;
      const frames = [];
      while (rest.length >= chunkBytes) {
        frames.push(rest.subarray(0, chunkBytes));
        rest = rest.subarray(chunkBytes);
      }
      return frames;
    },
    flush() {
      const tail = rest;
      rest = Buffer.alloc(0);
      return tail.length ? [tail] : [];
    },
  };
}

/** Pad a trailing frame with silence so every uplink frame stays a full 20 ms. */
export function padToChunk(buf, chunkBytes = BYTES_PER_CHUNK) {
  if (buf.length >= chunkBytes) return buf;
  const padded = Buffer.alloc(chunkBytes);
  buf.copy(padded);
  return padded;
}

/** Decode one server JSON frame into a normalised event. */
export function decodeServerMessage(raw) {
  let msg;
  try {
    msg = JSON.parse(raw);
  } catch {
    return { type: "malformed", raw };
  }

  if (msg.error) {
    const e = msg.error;
    return {
      type: "error",
      errorType: e.errorType ?? null,
      errorCode: e.errorCode ?? null,
      message: typeof e === "string" ? e : (e.message ?? ""),
      sessionId: e.sessionId ?? null,
    };
  }
  if (typeof msg.sessionId === "string" && msg.sessionId.length > 0) {
    return { type: "ack", sessionId: msg.sessionId };
  }
  if (msg.speechStart) {
    return { type: "speechStart", turnId: msg.speechStart.turnId, audioProcessedMs: msg.speechStart.audioProcessedMs ?? null };
  }
  if (msg.speechEnd) {
    return { type: "speechEnd", turnId: msg.speechEnd.turnId, audioProcessedMs: msg.speechEnd.audioProcessedMs ?? null };
  }
  if (msg.speechComplete) {
    return {
      type: "speechComplete",
      turnId: msg.speechComplete.turnId,
      transcript: msg.speechComplete.transcript ?? "",
      audioProcessedMs: msg.speechComplete.audioProcessedMs ?? null,
    };
  }
  if (msg.transcript) {
    return {
      type: msg.transcript.final ? "final" : "partial",
      transcript: msg.transcript.transcript ?? "",
    };
  }
  return { type: "unknown", raw };
}
