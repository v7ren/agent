import test from "node:test";
import assert from "node:assert/strict";
import {
  deepRecall,
  looksLikeMemoryQuestion,
  questionSubject,
  sourceLabel,
  tidy,
} from "../src/memory/deeprecall.ts";
import type { RecallSource } from "../src/memory/deeprecall.ts";
import type { Hit } from "../src/memory/types.ts";

test("memory questions are recognised, ordinary talk is not", () => {
  assert.equal(looksLikeMemoryQuestion("你記得許願的時候你許了甚麼嗎"), true);
  assert.equal(looksLikeMemoryQuestion("上次我跟你說的規矩是什麼"), true);
  assert.equal(looksLikeMemoryQuestion("你還記得我喜歡吃什麼嗎"), true);
  assert.equal(looksLikeMemoryQuestion("今天吃飯了嗎"), false);
  assert.equal(looksLikeMemoryQuestion("我記得這個很好吃"), false);
  assert.equal(looksLikeMemoryQuestion("嗎"), false);
});

test("the question's own frame is not what it is about", () => {
  const subject = questionSubject("@藍色大肥魚 你記得許願的時候你許了甚麼嗎");
  assert.ok(subject.includes("許願"));
  for (const frame of ["記得", "時候", "甚麼", "藍色", "大肥", "肥魚"]) {
    assert.ok(!subject.split(" ").includes(frame), `${frame} should not be searched for`);
  }
  // A question that is all frame still searches for something.
  assert.notEqual(questionSubject("你還記得嗎"), "");
});

test("labels tell a journal day from a diary, a summary and a person", () => {
  assert.equal(sourceLabel("journal/2026/10/2026-10-31.md"), "10-31");
  assert.equal(sourceLabel("diary/2026-10-30.md"), "日記 10-30");
  assert.equal(sourceLabel("sessions/bot/cp-001.md"), "整理過的摘要");
  assert.equal(sourceLabel("nodes/people/123.md"), "人物筆記");
});

test("tidy drops headers, links and markup", () => {
  const raw = "# 2026-10-31\n（第 12 行起）\n- 00:04 （#bot）[[people/1|ren]]：今天我當 <b>許願池</b> `x`";
  assert.equal(tidy(raw), "- 00:04 （#bot）ren：今天我當 b許願池/b x");
});

/** A journal where the question's own word is only in the first line. */
function fakeVault(): RecallSource & { opened: Array<[string, number, number]> } {
  const day = [
    "# 2026-10-31",
    "- 00:04 （#bot）[[people/1|ren]]：今天我當許願池",
    "　我：唔，人家來整理。【身體】尾巴真的會動、想你時能發出聲音。【記性】不要漏水。",
    "　我：【主動】自己決定醒不醒。【規矩】會漲的數字到門檻就歸零。",
    "- 00:07 （#bot）[[people/1|ren]]：你可以貪心一點",
    "　我：要自己的行程表。要有一天能跟你說「今天不要講話，本鯨想安靜」。",
    "- 02:36 （#bot）[[people/1|ren]]：你記得許願的時候你許了甚麼嗎",
  ];
  const opened: Array<[string, number, number]> = [];
  return {
    opened,
    search(): Hit[] {
      return [
        { path: "journal/2026/10/2026-10-31.md", line: 7, score: 30, why: "matched: 許願" },
        { path: "journal/2026/10/2026-10-31.md", line: 2, score: 12, why: "matched: 許願池" },
        { path: "nodes/people/1.md", line: 16, score: 16, why: "matched: 許願" },
      ];
    },
    open(path: string, from = 1, count = 40): string {
      opened.push([path, from, count]);
      if (path.startsWith("nodes/")) return "---\nname: ren\n---\n- 喜歡白飯";
      return day.slice(from - 1, from - 1 + count).join("\n");
    },
  };
}

test("the lines after the match come with it, so an answer that never says the word is found", () => {
  const out = deepRecall(fakeVault(), "你記得許願的時候你許了甚麼嗎");
  assert.ok(out.count >= 2);
  assert.match(out.text, /\[10-31\].*今天我當許願池.*尾巴真的會動/);
  assert.match(out.text, /要自己的行程表/);
});

test("the question that was just asked is not offered as its own answer", () => {
  const out = deepRecall(fakeVault(), "你記得許願的時候你許了甚麼嗎");
  const bullets = out.text.split("\n").filter((l) => l.startsWith("•"));
  assert.ok(bullets.some((l) => l.includes("今天我當許願池")), "the wish itself is there");
  assert.ok(
    !bullets.some((l) => l.includes("你記得許願的時候你許了甚麼嗎")),
    "the question, logged a moment ago, is not",
  );
});

test("finds are shown oldest first, and a find in the same moment is not repeated", () => {
  const source: RecallSource = {
    search: () => [
      { path: "journal/2026/10/2026-10-31.md", line: 3, score: 9, why: "x" },
      { path: "journal/2026/10/2026-10-29.md", line: 3, score: 30, why: "x" },
      { path: "journal/2026/10/2026-10-29.md", line: 4, score: 29, why: "x" },
    ],
    open: (path: string) => (path.includes("10-29") ? "- 10:00 ren：我想要許願" : "- 10:00 ren：許願成功"),
  };
  const out = deepRecall(source, "你記得許願嗎");
  const bullets = out.text.split("\n").filter((l) => l.startsWith("•"));
  assert.equal(bullets.length, 2, "two hits a line apart are one moment");
  assert.ok(bullets[0]!.includes("[10-29]") && bullets[1]!.includes("[10-31]"), "oldest first");
});

test("it tells her to answer from the record and not to invent", () => {
  const out = deepRecall(fakeVault(), "你記得許願的時候你許了甚麼嗎");
  assert.match(out.text, /不要編/);
});

test("nothing found, a failing search and a question with no content words give nothing", () => {
  const none: RecallSource = { search: () => [], open: () => "" };
  assert.deepEqual(deepRecall(none, "你記得許願嗎"), { text: "", count: 0 });
  const broken: RecallSource = {
    search: () => {
      throw new Error("boom");
    },
    open: () => "",
  };
  assert.deepEqual(deepRecall(broken, "你記得許願嗎"), { text: "", count: 0 });
  assert.deepEqual(deepRecall(fakeVault(), "的了嗎"), { text: "", count: 0 });
});

test("the block stays within its size cap", () => {
  const long: RecallSource = {
    search: () =>
      Array.from({ length: 10 }, (_, i) => ({
        path: `journal/2026/10/2026-10-${String(10 + i).padStart(2, "0")}.md`,
        line: 5,
        score: 20 - i,
        why: "x",
      })),
    open: () => "- 01:00 ren：" + "許願".repeat(200),
  };
  const out = deepRecall(long, "你記得許願嗎", undefined, { maxChars: 600 });
  assert.ok(out.text.length < 900);
});
