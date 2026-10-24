import { BYTES_PER_AUDIO_SECOND } from "./protocol.mjs";
import { normalizeTranscript } from "./text.mjs";

export const SCRIBE_MODEL = "scribe_v2";
export const isScribeModel = (model) => /scribe/i.test(model || "");

// The shared decoder supplies 24 kHz mono s16le PCM. Wrap it in WAV for upload.
function wavHeader(bytes) {
  const header = Buffer.alloc(44);
  header.write("RIFF");
  header.writeUInt32LE(36 + bytes, 4);
  header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(24_000, 24);
  header.writeUInt32LE(BYTES_PER_AUDIO_SECOND, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write("data", 36);
  header.writeUInt32LE(bytes, 40);
  return header;
}

export async function transcribeElevenLabs({
  source,
  token,
  language,
  timeoutMs = Number(process.env.MUSE_TIMEOUT_MS || 120_000),
}) {
  if (!token?.trim()) {
    throw Object.assign(new Error("no ElevenLabs token configured (set ELEVENLABS_API_KEY)"), {
      status: 503,
      code: "no_elevenlabs_token",
    });
  }
  const startedAt = Date.now();
  const chunks = [];
  let bytes = 0;
  for await (const chunk of source) {
    chunks.push(chunk);
    bytes += chunk.length;
  }
  if (!bytes) {
    throw Object.assign(new Error("empty audio"), { status: 400, code: "empty_audio" });
  }

  const body = new FormData();
  body.set("model_id", SCRIBE_MODEL);
  body.set("file", new Blob([wavHeader(bytes), ...chunks], { type: "audio/wav" }), "audio.wav");
  body.set("tag_audio_events", "false");
  body.set("diarize", "false");
  if (language) body.set("language_code", String(language).split(/[-_]/)[0].toLowerCase());

  let data;
  try {
    const response = await fetch("https://api.elevenlabs.io/v1/speech-to-text", {
      method: "POST",
      headers: { "xi-api-key": token.trim() },
      body,
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (!response.ok) {
      // Do not expose upstream response bodies, which may contain credentials.
      await response.body?.cancel();
      throw Object.assign(new Error(`ElevenLabs transcription failed (HTTP ${response.status})`), {
        status: response.status >= 500 ? 502 : response.status,
        code: "elevenlabs_error",
      });
    }
    data = await response.json();
    if (typeof data?.text !== "string") throw new Error("invalid transcription response");
  } catch (err) {
    if (err.code === "elevenlabs_error") throw err;
    const timedOut = err.name === "TimeoutError" || err.name === "AbortError";
    throw Object.assign(new Error(timedOut ? "ElevenLabs transcription timed out" : "ElevenLabs transcription request failed"), {
      status: timedOut ? 504 : 502,
      code: timedOut ? "elevenlabs_timeout" : "elevenlabs_error",
    });
  }
  return {
    text: normalizeTranscript(data.text),
    rawText: data.text,
    audioMs: Math.round(bytes / BYTES_PER_AUDIO_SECOND * 1000),
    sessionId: data.transcription_id || null,
    timing: { totalMs: Date.now() - startedAt },
  };
}
