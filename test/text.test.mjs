import test from "node:test";
import assert from "node:assert/strict";
import { guessLanguage, hasCjk, normalizeTranscript, stripTrailingPeriods } from "../src/text.mjs";

test("簡體轉繁體（台灣用語）", () => {
  assert.equal(normalizeTranscript("这是一个测试"), "這是一個測試");
  assert.equal(normalizeTranscript("外部程序测试"), "外部程式測試"); // twp: 程序 -> 程式
  assert.equal(normalizeTranscript("软件和网络"), "軟體和網路");
});

test("結尾句點都砍掉", () => {
  assert.equal(normalizeTranscript("你好，這是一個測試。"), "你好，這是一個測試");
  assert.equal(normalizeTranscript("Hello world."), "Hello world");
  assert.equal(normalizeTranscript("重复。。"), "重複");
  assert.equal(normalizeTranscript("尾端有空白 。  "), "尾端有空白");
});

test("不是句點結尾就不動", () => {
  assert.equal(normalizeTranscript("這樣對嗎？"), "這樣對嗎？");
  assert.equal(normalizeTranscript("哇！"), "哇！");
  assert.equal(normalizeTranscript("pi is 3.14"), "pi is 3.14");
  assert.equal(normalizeTranscript("用 Node.js 寫"), "用 Node.js 寫");
});

test("中文句子裡的半形逗號換全形", () => {
  assert.equal(normalizeTranscript("你好, 這是測試"), "你好，這是測試");
  assert.equal(normalizeTranscript("a, b and c"), "a, b and c");
});

test("全形標點後面的空白去掉（英文句子不動）", () => {
  assert.equal(normalizeTranscript("你好。 這是一個測試。 用的是 Node.js"), "你好。這是一個測試。用的是 Node.js");
  assert.equal(normalizeTranscript("Hello. World."), "Hello. World");
});

test("空字串 / null 安全", () => {
  assert.equal(normalizeTranscript(""), "");
  assert.equal(normalizeTranscript(null), "");
  assert.equal(normalizeTranscript(undefined), "");
  assert.equal(normalizeTranscript("   "), "");
});

test("stripTrailingPeriods 只砍尾巴", () => {
  assert.equal(stripTrailingPeriods("a.b."), "a.b");
  assert.equal(stripTrailingPeriods("..."), "");
  assert.equal(stripTrailingPeriods("end"), "end");
});

test("language 猜測", () => {
  assert.equal(hasCjk("這是中文"), true);
  assert.equal(hasCjk("plain english"), false);
  assert.equal(guessLanguage("這是中文", undefined), "zh");
  assert.equal(guessLanguage("hello", undefined), "en");
  assert.equal(guessLanguage("hello", "zh-TW"), "zh");
});
