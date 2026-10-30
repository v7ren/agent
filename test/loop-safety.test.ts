import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent, withScopeLock } from "../src/core/loop.ts";
import { CacheLog, ratesFor } from "../src/core/cache.ts";
import { assemble } from "../src/core/assemble.ts";
import { fitTail } from "../src/core/assemble.ts";
import { DEFAULT_BUDGET, estimateTokens } from "../src/core/budget.ts";
import { initialMood } from "../src/persona/mood.ts";
import type { ChatRequest, ChatResult, Provider, Usage } from "../src/types.ts";

const U: Usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };
const NOW = new Date("2026-10-31T10:00:00Z");
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function agentWith(provider: Provider, memory?: unknown) {
  return new Agent({
    provider,
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    memory: memory as never,
  });
}

test("every tool call gets a result; calls past the cap get a stub", async () => {
  const calls: ChatRequest[] = [];
  let n = 0;
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      calls.push(req);
      n++;
      if (n === 1) {
        const toolCalls = Array.from({ length: 6 }, (_, i) => ({
          id: `c${i}`,
          name: "memory_timeline",
          arguments: "{}",
        }));
        return { text: "", usage: U, model: "m", toolCalls } as ChatResult;
      }
      return { text: "好", usage: U, model: "m" } as ChatResult;
    },
  };
  const memory = { timeline: () => [], recall: () => null, log: () => {} };
  const agent = agentWith(provider, memory);
  const res = await agent.turn("hello");
  assert.equal(res.segments.join(""), "好");

  const followUp = calls[1]!.messages.filter((m) => m.role === "tool");
  assert.equal(followUp.length, 6);
  assert.deepEqual(
    followUp.map((m) => m.toolCallId),
    ["c0", "c1", "c2", "c3", "c4", "c5"],
  );
  assert.equal(followUp[4]!.content, "skipped: too many calls");
  assert.equal(followUp[5]!.content, "skipped: too many calls");
});

test("a throwing tool becomes a tool result and the turn survives", async () => {
  const calls: ChatRequest[] = [];
  let n = 0;
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      calls.push(req);
      n++;
      if (n === 1) {
        return {
          text: "",
          usage: U,
          model: "m",
          toolCalls: [{ id: "x1", name: "memory_search", arguments: '{"query":"q"}' }],
        } as ChatResult;
      }
      return { text: "好", usage: U, model: "m" } as ChatResult;
    },
  };
  const memory = {
    search: () => {
      throw new Error("boom");
    },
    recall: () => null,
    log: () => {},
  };
  const agent = agentWith(provider, memory);
  const res = await agent.turn("hello");
  assert.equal(res.segments.join(""), "好");
  const tool = calls[1]!.messages.find((m) => m.role === "tool");
  assert.equal(tool?.content, "工具出錯：boom");
});

test("turns in one scope run strictly in order", async () => {
  const events: string[] = [];
  let n = 0;
  const provider: Provider = {
    name: "deepseek",
    async chat() {
      const id = ++n;
      events.push(`start${id}`);
      await sleep(id === 1 ? 30 : 0);
      events.push(`end${id}`);
      return { text: "ok", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = agentWith(provider);
  await Promise.all([agent.turn("a"), agent.turn("b")]);
  assert.deepEqual(events, ["start1", "end1", "start2", "end2"]);
});

test("withScopeLock does not serialise different scopes", async () => {
  const done: string[] = [];
  const slow = withScopeLock("room-a", async () => {
    await sleep(40);
    done.push("a");
  });
  const fast = withScopeLock("room-b", async () => {
    done.push("b");
  });
  await Promise.all([slow, fast]);
  assert.deepEqual(done, ["b", "a"]);
});

test("history keeps the raw user text, not the volatile tip", async () => {
  const provider: Provider = {
    name: "deepseek",
    async chat() {
      return { text: "好", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = agentWith(provider);
  await agent.turn("hello there");
  assert.equal(agent.transcript[0]?.content, "hello there");
  assert.ok(!agent.transcript[0]?.content.includes("現在："));
});

test("fitTail keeps the newest end of an oversized tip", () => {
  const head = "舊".repeat(500);
  const tail = "NEWEST-MOOD";
  const cut = fitTail(head + tail, 50);
  assert.ok(estimateTokens(cut) <= 50);
  assert.ok(cut.endsWith(tail));
});

test("assemble enforces budget.tip and records the drop", () => {
  const p = assemble(
    {
      static: [],
      stable: [],
      chain: [],
      hot: [{ role: "user", content: "hi" }],
      tip: { id: "tip", volatility: 4, content: "時鐘".repeat(800) + "END" },
    },
    { budget: { ...DEFAULT_BUDGET, tip: 100 } },
  );
  const last = p.messages[p.messages.length - 1]!;
  assert.ok(last.content.endsWith("END"));
  const tipPart = last.content.slice(last.content.indexOf("\n\n") + 2);
  assert.ok(estimateTokens(tipPart) <= 100);
  assert.ok(p.dropped.includes("tip"));
});

test("cache cost is unknown for providers without a known price", () => {
  assert.equal(ratesFor("openai", "gpt-4o"), null);
  const log = new CacheLog(ratesFor("openai", "gpt-4o"));
  log.record(U);
  assert.equal(log.costKnown, false);
  assert.equal(log.stat.costUsd, 0);
  assert.match(log.formatLast(U), /turn unknown/);

  const ds = new CacheLog(ratesFor("deepseek", "deepseek-chat"));
  assert.equal(ds.costKnown, true);
});
