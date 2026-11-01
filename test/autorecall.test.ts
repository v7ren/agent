import test from "node:test";
import assert from "node:assert/strict";
import { autoRecall, localQueries, parseRewrite, rewriteQueries } from "../src/memory/autorecall.ts";
import type { RecallSource } from "../src/memory/deeprecall.ts";
import type { Provider } from "../src/types.ts";

const U = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };

test("a rewrite reply is read even when wrapped in fences and talk", () => {
  const got = parseRewrite('好的\n```json\n{"queries":["許願 願望","<b>閉嘴</b>"]}\n```');
  assert.equal(got[0], "許願 願望");
  assert.ok(!got[1]!.includes("<") && got[1]!.includes("閉嘴"), "markup is stripped");
  assert.deepEqual(parseRewrite("沒有json"), []);
  assert.deepEqual(parseRewrite('{"queries":"x"}'), []);
  assert.equal(parseRewrite('{"queries":["a","b","c","d"]}').length, 3);
});

test("a vague message is searched by the model's words first, then by what came before", () => {
  const qs = localQueries({
    text: "我那時候想要什麼來著",
    recent: ["你可以許願", "要自己的行程表"],
    rewritten: ["許願 願望"],
  });
  const rewrite = qs.find((q) => q.q.includes("許願") && q.q.includes("願望"));
  const raw = qs.find((q) => q.q.includes("那時候"));
  assert.ok(rewrite && raw);
  assert.ok(rewrite.w > raw.w, "the rewrite outranks the filler words");
  assert.ok(qs.some((q) => q.q.includes("行程")), "recent lines are searched too");
});

function source(): RecallSource {
  const day = [
    "# 2026-10-31",
    "- 00:04 （私訊）[[people/1|ren]]：你可以許願我來當許願池隨便講",
    "　我：【記性】要自己的行程表。",
    "- 02:36 （#bot）[[people/1|ren]]：你記得我許了什麼嗎",
  ];
  return {
    search: (q) =>
      q.includes("許願")
        ? [
            { path: "journal/2026/10/2026-10-31.md", line: 2, score: 9, why: "x" },
            { path: "journal/2026/10/2026-10-31.md", line: 4, score: 8, why: "x" },
          ]
        : [],
    open: (_p, from = 1, count = 1) => day.slice(from - 1, from - 1 + count).join("\n"),
  };
}

test("every turn finds the old moment, not the question itself, and not what is already in her window", () => {
  const qs = localQueries({ text: "你記得我許了什麼嗎", recent: [], rewritten: ["許願"] });
  const found = autoRecall(source(), qs, { asked: "你記得我許了什麼嗎", seen: "" });
  assert.equal(found.count, 1);
  assert.match(found.text, /你可以許願.*行程表/);
  assert.ok(!found.text.includes("你記得我許了什麼嗎"), "the question is not its own answer");

  const again = autoRecall(source(), qs, { asked: "x", seen: "你可以許願我來當許願池隨便講|" });
  assert.equal(again.count, 0, "a line she can already see is not repeated");
});

test("the block stays small however much matches", () => {
  const big: RecallSource = {
    search: () =>
      Array.from({ length: 10 }, (_, i) => ({ path: `journal/2026/10/2026-10-${10 + i}.md`, line: 5, score: 9, why: "x" })),
    open: () => "- 01:00 ren：" + "許願".repeat(300),
  };
  const out = autoRecall(big, [{ q: "許願", w: 1 }], { asked: "a", seen: "" });
  assert.ok(out.text.length < 1300);
});

test("the rewrite never makes a reply wait longer than its limit, and a failure is just no rewrite", async () => {
  const slow: Provider = {
    name: "deepseek",
    chat: () => new Promise((r) => setTimeout(() => r({ text: '{"queries":["x"]}', usage: U, model: "m" }), 500)),
  };
  const t0 = Date.now();
  assert.deepEqual(await rewriteQueries(slow, "那個", [], 50), []);
  assert.ok(Date.now() - t0 < 300);
  const broken: Provider = { name: "deepseek", chat: async () => { throw new Error("boom"); } };
  assert.deepEqual(await rewriteQueries(broken, "那個", [], 1000), []);
  const ok: Provider = { name: "deepseek", chat: async () => ({ text: '{"queries":["許願 願望"]}', usage: U, model: "m" }) };
  assert.deepEqual(await rewriteQueries(ok, "那個", ["我想許願"], 1000), ["許願 願望"]);
  assert.deepEqual(await rewriteQueries(ok, "那個", [], 0), []);
});
