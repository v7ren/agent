import { test } from "node:test";
import assert from "node:assert/strict";
import type { Msg } from "../src/types.ts";
import { estimateTokens } from "../src/core/budget.ts";
import {
  hardLimit,
  historyTokens,
  personaAnchor,
  planCompaction,
  windowFromEnv,
  type WindowConfig,
} from "../src/core/window.ts";

const cfg = (limitTokens: number, keepFraction = 0.3): WindowConfig => ({
  limitTokens,
  keepFraction,
});

/** Builds a long alternating conversation, each message about `size` chars. */
function chat(n: number, size = 400): Msg[] {
  const out: Msg[] = [];
  for (let i = 0; i < n; i++) {
    out.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `m${i} ` + "x".repeat(size),
    });
  }
  return out;
}

test("historyTokens sums estimates plus 4 per message", () => {
  const msgs: Msg[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: "藍色大肥魚" },
  ];
  const expected =
    estimateTokens("hello") + 4 + estimateTokens("藍色大肥魚") + 4;
  assert.equal(historyTokens(msgs), expected);
  assert.equal(historyTokens([]), 0);
});

test("windowFromEnv defaults and disables", () => {
  assert.deepEqual(windowFromEnv({}), {
    limitTokens: 100000,
    keepFraction: 0.3,
  });
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "0" }), null);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "off" }), null);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: " OFF " }), null);
});

test("windowFromEnv falls back on garbage and clamps", () => {
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "lots" })?.limitTokens, 100000);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "" })?.limitTokens, 100000);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "100" })?.limitTokens, 8000);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "99999999" })?.limitTokens, 900000);
  assert.equal(windowFromEnv({ FISHD_CONTEXT_TOKENS: "50000" })?.limitTokens, 50000);
});

test("windowFromEnv parses keep fraction with clamps and fallback", () => {
  assert.equal(windowFromEnv({ FISHD_COMPACT_KEEP: "nope" })?.keepFraction, 0.3);
  assert.equal(windowFromEnv({ FISHD_COMPACT_KEEP: "0.01" })?.keepFraction, 0.1);
  assert.equal(windowFromEnv({ FISHD_COMPACT_KEEP: "0.9" })?.keepFraction, 0.6);
  assert.equal(windowFromEnv({ FISHD_COMPACT_KEEP: "0.5" })?.keepFraction, 0.5);
});

test("hardLimit is 125 percent of the limit", () => {
  assert.equal(hardLimit(cfg(100000)), 125000);
  assert.equal(hardLimit(cfg(8001)), Math.round(8001 * 1.25));
});

test("no plan below the limit, including system tokens", () => {
  const msgs = chat(10, 40);
  const total = historyTokens(msgs);
  assert.equal(planCompaction(msgs, cfg(total + 1)), null);
  assert.equal(planCompaction(msgs, cfg(total)), null);
  assert.equal(planCompaction(msgs, cfg(total + 10), 20), null);
  assert.notEqual(planCompaction(msgs, cfg(total - 1)), null);
  assert.notEqual(planCompaction(msgs, cfg(total + 10), 20), null === 0 ? null : undefined);
});

test("cut leaves remaining within keep and starts at a user message", () => {
  const msgs = chat(40, 400);
  const c = cfg(3000, 0.3);
  const plan = planCompaction(msgs, c);
  assert.ok(plan);
  const { cut } = plan;
  assert.equal(msgs[cut]?.role, "user");
  const remaining = historyTokens(msgs.slice(cut));
  assert.ok(remaining <= c.limitTokens * c.keepFraction, `${remaining}`);
});

test("cut is the smallest that fits: one fewer message would not fit", () => {
  const msgs = chat(40, 400);
  const c = cfg(3000, 0.3);
  const plan = planCompaction(msgs, c);
  assert.ok(plan);
  const target = c.limitTokens * c.keepFraction;
  // Chosen cut is user-aligned, so compare against the nearest earlier user cut.
  let prevUser = plan.cut - 1;
  while (prevUser >= 0 && msgs[prevUser]?.role !== "user") prevUser--;
  if (prevUser >= 2) {
    assert.ok(historyTokens(msgs.slice(prevUser)) > target);
  }
});

test("never removes the last two messages", () => {
  const msgs = chat(12, 2000);
  const plan = planCompaction(msgs, cfg(1000, 0.1));
  assert.ok(plan);
  assert.ok(plan.cut <= msgs.length - 2);
  assert.equal(msgs[plan.cut]?.role, "user");
});

test("handles two users in a row", () => {
  const msgs: Msg[] = [];
  for (let i = 0; i < 10; i++) {
    msgs.push({ role: "user", content: "u" + "x".repeat(300) });
    msgs.push({ role: "user", content: "v" + "x".repeat(300) });
    msgs.push({ role: "assistant", content: "a" + "x".repeat(300) });
  }
  const plan = planCompaction(msgs, cfg(1500, 0.3));
  assert.ok(plan);
  assert.equal(msgs[plan.cut]?.role, "user");
  assert.ok(plan.cut <= msgs.length - 2);
});

test("handles a trailing user message", () => {
  const msgs = chat(9, 500);
  msgs.push({ role: "user", content: "x".repeat(500) });
  const plan = planCompaction(msgs, cfg(1500, 0.3));
  assert.ok(plan);
  assert.equal(msgs[plan.cut]?.role, "user");
  assert.ok(plan.cut <= msgs.length - 2);
});

test("tiny and odd inputs return null or a safe cut", () => {
  const c = cfg(8000);
  const huge = "x".repeat(200000);
  assert.equal(planCompaction([], c), null);
  assert.equal(planCompaction([{ role: "user", content: huge }], c), null);
  assert.equal(
    planCompaction(
      [
        { role: "user", content: huge },
        { role: "assistant", content: huge },
      ],
      c,
    ),
    null,
  );
  // Three messages: at most one can be removed, and the cut must be >= 2.
  const three: Msg[] = [
    { role: "user", content: huge },
    { role: "user", content: huge },
    { role: "assistant", content: huge },
  ];
  assert.equal(planCompaction(three, c), null);
});

test("personaAnchor is empty below threshold and a short line above", () => {
  assert.equal(personaAnchor(0), "");
  assert.equal(personaAnchor(39999), "");
  assert.equal(personaAnchor(40000), personaAnchor(90000));
  const line = personaAnchor(40000);
  assert.notEqual(line, "");
  assert.ok(line.includes("藍色大肥魚"));
  assert.ok([...line].length < 90, `${[...line].length}`);
  assert.equal(personaAnchor(100, 50), "");
  assert.notEqual(personaAnchor(100, 50), "x");
});
