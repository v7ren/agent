import test from "node:test";
import assert from "node:assert/strict";
import { hesitates, olderIndex, slip, statusText, typingMs } from "../src/persona/human.ts";
import { parseExpression } from "../src/persona/express.ts";

test("typing takes longer for longer lines and for a sleepy fish", () => {
  const short = typingMs("嗯", "genki", 1);
  const long = typingMs("今天真的好累喔我想要吃白飯然後直接睡覺", "genki", 1);
  assert.ok(long > short);
  assert.ok(typingMs("今天真的好累喔我想要吃白飯", "sleepy", 5) > typingMs("今天真的好累喔我想要吃白飯", "genki", 5));
  assert.ok(typingMs("字".repeat(500), "sleepy", 3) <= 5500);
});

test("only a long line is ever hesitated over, and not often", () => {
  assert.equal(hesitates("嗯", 1), false);
  const long = "這是一句比較長的話，用來測試有沒有猶豫";
  const hits = Array.from({ length: 400 }, (_, i) => hesitates(long, i * 7919)).filter(Boolean).length;
  assert.ok(hits > 5 && hits < 120, `hits=${hits}`);
});

test("a slip swaps two neighbouring characters and keeps the right text to put back", () => {
  const text = "我今天想要吃白飯配蛋";
  let found: ReturnType<typeof slip> = null;
  for (let i = 1; i < 2000 && !found; i++) found = slip(text, i * 104729);
  assert.ok(found);
  assert.equal(found.fix, text);
  assert.notEqual(found.typo, text);
  assert.equal([...found.typo].sort().join(""), [...text].sort().join(""));
  assert.equal(slip("嗯", 1), null);
  assert.equal(slip("看 https://example.com/abc 這個", 1), null);
});

test("an older message is picked by counting back from the latest", () => {
  assert.equal(olderIndex(4, 1), 3);
  assert.equal(olderIndex(4, 4), 0);
  assert.equal(olderIndex(2, 5), null);
  assert.equal(olderIndex(4, undefined), null);
});

test("her status follows mood and the hour", () => {
  const night = new Date(2026, 9, 31, 3, 0);
  assert.match(statusText("genki", night, 1), /夢裡吃白飯|熬夜的魚/);
  const noon = new Date(2026, 9, 31, 12, 0);
  assert.equal(statusText("hungry", noon, 1), "午餐時間，在想吃什麼");
  assert.ok(statusText("tsundere", new Date(2026, 9, 31, 15, 0), 1).length > 0);
});

test("a reaction-only reply and an older reply target both parse", () => {
  const r = parseExpression('::state {"react":"👍"}');
  assert.equal(r.text, "");
  assert.equal(r.expression.react, "👍");
  assert.equal(parseExpression('好\n::state {"replyBack":2}').expression.replyBack, 2);
  assert.equal(parseExpression('好\n::state {"replyBack":0}').expression.replyBack, undefined);
  assert.equal(parseExpression('好\n::state {"replyBack":99}').expression.replyBack, undefined);
});

test("a doubled state block and a 'wait, redo it' draft never reach the room", () => {
  const raw =
    '"See — the foreigner said something nice."\n\n:::state {"mood":"tsundere","feel":"proud","segments":1}\n:::react 🐋\n\n' +
    'Wait, format — I should just say the line. Let me keep it clean.「總算講了句人話。」（尾巴晃了一下）\n::state {"feel":"proud"}';
  const r = parseExpression(raw);
  assert.ok(!r.text.includes(":::") && !r.text.includes("state") && !r.text.includes("See"));
  assert.ok(!r.text.startsWith("Wait"));
  assert.match(r.text, /^「總算講了句人話。」/);
  assert.equal(r.expression.mood, "tsundere");
  assert.equal(r.expression.feel, "proud");
  assert.equal(parseExpression('嗯\n:::state {"feel":"shy"}').text, "嗯");
});

import { appendNote } from "../src/persona/notes.ts";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("a note she dated herself is not dated twice", () => {
  const dir = mkdtempSync(join(tmpdir(), "notes-"));
  const line = appendNote(dir, "2026-11-01：英文對話被擠掉", new Date(2026, 10, 1));
  assert.equal(line, "- 2026-11-01 英文對話被擠掉");
  assert.ok(!/2026-11-01.*2026-11-01/.test(readFileSync(join(dir, "notes.md"), "utf8")));
});
