/**
 * macOS microphone capture -> raw PCM frames (24 kHz / mono / s16le), 20 ms each.
 *
 * The app does this with AudioRecord(ENCODING_PCM_16BIT, CHANNEL_IN_MONO, 24000)
 * and emits one 20 ms chunk (960 bytes) at a time (HatchDictationMicRecorder).
 * On macOS we shell out to ffmpeg's avfoundation input and re-chunk the byte
 * stream, which keeps the exact same framing without native modules.
 */

import { spawn } from "node:child_process";
import { open } from "node:fs/promises";
import { BYTES_PER_CHUNK, createFrameSplitter, padToChunk } from "./protocol.mjs";

export function listDevices() {
  return new Promise((resolve) => {
    const p = spawn("ffmpeg", ["-hide_banner", "-f", "avfoundation", "-list_devices", "true", "-i", ""], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (out += b));
    p.on("close", () => resolve(out));
    p.on("error", (err) => resolve(`ffmpeg not runnable: ${err.message}`));
  });
}

/**
 * @param {object} opts
 * @param {string} [opts.device] ffmpeg avfoundation audio device, default ":0"
 * @param {number} [opts.sampleRate] must stay 24000 for Voyager
 */
export function createMicCapture({ device = ":0", sampleRate = 24_000, ffmpegPath = "ffmpeg" } = {}) {
  const splitter = createFrameSplitter();
  let proc = null;
  let chunkCb = () => {};
  let exited = false;
  let stopping = null;

  const emitChunk = (frame) => {
    if (frame.length === 0) return;
    // never emit a short frame: the server expects fixed 20 ms windows
    chunkCb(padToChunk(frame, BYTES_PER_CHUNK));
  };

  const start = () => {
    exited = false;
    const args = [
      "-hide_banner",
      "-loglevel", "error",
      "-f", "avfoundation",
      "-i", device,
      "-ac", "1",
      "-ar", String(sampleRate),
      "-f", "s16le",
      "-",
    ];
    proc = spawn(ffmpegPath, args, { stdio: ["ignore", "pipe", "pipe"] });

    proc.stdout.on("data", (buf) => {
      for (const frame of splitter.push(buf)) emitChunk(frame);
    });
    proc.stderr.on("data", (b) => {
      const text = b.toString().trim();
      if (text) console.error("[ffmpeg]", text);
    });
    proc.on("error", (err) => {
      console.error("[ffmpeg] spawn failed:", err.message);
      exited = true;
    });
    proc.on("close", () => {
      exited = true;
      // flush the trailing partial frame after ffmpeg really stopped writing
      for (const frame of splitter.flush()) emitChunk(frame);
    });
  };

  const stop = () =>
    (stopping ??= new Promise((resolve) => {
      if (!proc || exited) return resolve();
      proc.once("close", () => resolve());
      proc.kill("SIGINT");
      // safety net: do not hang forever if ffmpeg ignores SIGINT
      setTimeout(() => {
        if (!exited) proc.kill("SIGKILL");
        resolve();
      }, 3000).unref();
    }));

  /** true once ffmpeg is gone, so callers can stop pacing loops */
  const getAlive = () => !!proc && !exited;

  return {
    onChunk: (cb) => {
      chunkCb = cb;
    },
    start,
    stop,
    getAlive,
  };
}

/**
 * Decode any audio file to the same PCM framing, useful for offline testing.
 * @returns {Promise<Buffer>} raw PCM bytes
 */
export function decodeFileToPcm(file, { sampleRate = 24_000, ffmpegPath = "ffmpeg" } = {}) {
  return new Promise((resolve, reject) => {
    const p = spawn(
      ffmpegPath,
      ["-hide_banner", "-loglevel", "error", "-i", file, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"],
      { stdio: ["ignore", "pipe", "pipe"] },
    );
    const chunks = [];
    let stderr = "";
    p.stdout.on("data", (b) => chunks.push(b));
    p.stderr.on("data", (b) => (stderr += b));
    p.on("close", (code) => {
      if (code !== 0) return reject(new Error(`ffmpeg failed (${code}): ${stderr.trim()}`));
      resolve(Buffer.concat(chunks));
    });
    p.on("error", reject);
  });
}

/**
 * 串流解碼：spawn ffmpeg，邊解邊吐 PCM chunk。
 * 這樣 decode 可以跟 WebSocket 上傳重疊，長音檔不用先等整段解完。
 * @returns {AsyncGenerator<Buffer>}
 */
export async function* decodeToPcmChunks(file, { sampleRate = 24_000, ffmpegPath = "ffmpeg", onStderr } = {}) {
  const p = spawn(
    ffmpegPath,
    ["-hide_banner", "-loglevel", "error", "-nostdin", "-i", file, "-ac", "1", "-ar", String(sampleRate), "-f", "s16le", "-"],
    { stdio: ["ignore", "pipe", "pipe"] },
  );
  let stderr = "";
  p.stderr.on("data", (b) => {
    stderr += b.toString();
    if (onStderr) onStderr(stderr);
  });
  const exited = new Promise((resolve) => p.on("close", (code) => resolve(code)));
  p.on("error", (err) => {
    stderr += String(err.message);
  });

  let stoppedEarly = false;
  try {
    for await (const chunk of p.stdout) {
      yield chunk;
    }
  } finally {
    // 消費者提早收手（例如伺服器關了連線）就別再讓 ffmpeg 寫進斷掉的 pipe
    if (p.exitCode === null) {
      stoppedEarly = true;
      p.kill("SIGKILL");
    }
    const code = await exited;
    if (!stoppedEarly && code !== 0) {
      throw new Error(`ffmpeg failed (${code}): ${stderr.trim().slice(0, 200)}`);
    }
  }
}

/**
 * WAV 直通：如果上傳的檔案本來就是 24 kHz / mono / 16-bit PCM，
 * 就不用 spawn ffmpeg（省掉 60~700 ms 的啟動成本），直接從 data chunk 開始串流。
 * @returns {Promise<{dataOffset:number, dataBytes:number}|null>}
 */
export async function pcmWavFastPath(file, { sampleRate = 24_000 } = {}) {
  const fh = await open(file, "r");
  try {
    const head = Buffer.alloc(12);
    await fh.read(head, 0, 12, 0);
    if (head.toString("ascii", 0, 4) !== "RIFF" || head.toString("ascii", 8, 12) !== "WAVE") return null;

    let offset = 12;
    let fmt = null;
    const size = (await fh.stat()).size;
    while (offset + 8 <= size) {
      const hdr = Buffer.alloc(8);
      await fh.read(hdr, 0, 8, offset);
      const id = hdr.toString("ascii", 0, 4);
      const len = hdr.readUInt32LE(4);
      if (id === "fmt ") {
        const b = Buffer.alloc(Math.min(len, 40));
        await fh.read(b, 0, b.length, offset + 8);
        fmt = {
          audioFormat: b.readUInt16LE(0),
          channels: b.readUInt16LE(2),
          sampleRate: b.readUInt32LE(4),
          bitsPerSample: b.readUInt16LE(14),
        };
      } else if (id === "data") {
        if (!fmt) return null;
        const isPcm = fmt.audioFormat === 1 || fmt.audioFormat === 0xfffe;
        if (!isPcm) return null;
        if (fmt.channels !== 1) return null;
        if (fmt.bitsPerSample !== 16) return null;
        if (fmt.sampleRate !== sampleRate) return null;
        return { dataOffset: offset + 8, dataBytes: Math.min(len, size - (offset + 8)) };
      }
      offset += 8 + len + (len % 2);
    }
    return null;
  } catch {
    return null;
  } finally {
    await fh.close();
  }
}
