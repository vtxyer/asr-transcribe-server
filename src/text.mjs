/**
 * Transcript post-processing.
 *
 * Meta 的 ASR 回的是簡體中文，而且句尾常常帶「。」（甚至重複的「。。」）。
 * 這裡統一：簡→繁（台灣用語）＋ 去掉結尾句點。
 */

import * as OpenCC from "opencc-js";

/** tw = 繁體字形、twp = 繁體 + 台灣用語（程序→程式）、hk、none = 不轉 */
const TARGET = (process.env.OPENCC_TARGET || "twp").toLowerCase();

const convert =
  TARGET === "none"
    ? (s) => s
    : OpenCC.Converter({ from: "cn", to: TARGET === "twp" ? "twp" : TARGET === "hk" ? "hk" : "tw" });

// 結尾的句點、逗號、分號都不要（語音輸入直接貼進輸入框時，結尾標點很礙眼）
const TRAILING_PERIODS = /[\s。．.｡，、；：,;:]+$/u;

/** 只砍結尾的句點/空白，中間的標點不動；"Node.js." -> "Node.js"、"3.14" 不受影響 */
export function stripTrailingPeriods(s) {
  return String(s).replace(TRAILING_PERIODS, "");
}

/** 半形逗號在中文句子裡很醜，換成全形（只在 CJK 旁邊換） */
function tidyPunctuation(s) {
  return s
    .replace(/(?<=[\u3400-\u9fff])\s*,\s*/gu, "，")
    .replace(/(?<=[\u3400-\u9fff])\s*\?\s*/gu, "？")
    .replace(/(?<=[\u3400-\u9fff])\s*!\s*/gu, "！")
    .replace(/(?<=[\u3400-\u9fff])\s*;\s*/gu, "；")
    .replace(/(?<=[\u3400-\u9fff])\s*:\s*/gu, "：")
    // 全形標點後面不該有空白（ASR 常常回 "你好。 這是…"）
    .replace(/(?<=[。，？！；：、」』）])\s+(?=[\u3400-\u9fff])/gu, "")
    .replace(/[ \t]{2,}/g, " ");
}

/** ASR 原文 -> 要回給 client 的文字 */
export function normalizeTranscript(raw) {
  if (raw == null) return "";
  let text = String(raw).normalize("NFC").trim();
  if (!text) return "";
  text = convert(text);
  text = tidyPunctuation(text).trim();
  return stripTrailingPeriods(text);
}

/** 句子裡有沒有中日韓字（用來猜 language 欄位） */
export function hasCjk(text) {
  return /[\u3400-\u9fff\u3040-\u30ff\uac00-\ud7af]/u.test(text || "");
}

/** 猜一個 OpenAI verbose_json 要的 language 值 */
export function guessLanguage(text, requested) {
  if (requested) return String(requested).split(/[-_]/)[0].toLowerCase();
  return hasCjk(text) ? "zh" : "en";
}
