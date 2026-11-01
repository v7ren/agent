import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/core/loop.ts";
import { initialMood } from "../src/persona/mood.ts";
import { keywordQuery, withoutAddressing } from "../src/memory/tokenize.ts";
import type { ChatResult, Provider, Usage } from "../src/types.ts";

const U: Usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };
const NOW = new Date(2026, 9, 31, 2, 40);

test("her own name and @mentions are not what a search is for", () => {
  assert.ok(!keywordQuery("@藍色大肥魚 你記得許願嗎").includes("大肥"));
  assert.ok(!keywordQuery("大肥魚 許願").includes("魚"));
  assert.ok(keywordQuery("@Wennn 白飯").includes("白飯"));
  assert.ok(!keywordQuery("@Wennn 白飯").includes("wennn"));
  assert.equal(withoutAddressing("本鯨 @ren 嗨").replace(/\s+/g, ""), "嗨");
});

function setup() {
  const seen: Array<{ kind: string; scope: unknown }> = [];
  const memory = {
    recall: (_t: string, _n: Date, scope?: unknown) => {
      seen.push({ kind: "recall", scope });
      return null;
    },
    search: (_q: string, _l?: number, scope?: unknown) => {
      seen.push({ kind: "search", scope });
      return [];
    },
    open: () => "",
    log: () => {},
    person: () => null,
    timeline: () => [],
    diary: () => null,
  };
  const provider: Provider = {
    name: "deepseek",
    async chat() {
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = new Agent({
    provider,
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    memory: memory as never,
    where: "#bot",
  });
  return { agent, seen };
}

test("the owner can recall a conversation from any room, not just the one he is in", async () => {
  const { agent, seen } = setup();
  await agent.turn("你記得許願的時候你許了甚麼嗎", {
    speaker: { id: "1", name: "ren" },
    group: true,
    owner: true,
    where: "#bot",
  });
  const lookups = seen.filter((s) => s.kind === "recall" || s.kind === "search");
  assert.ok(lookups.length >= 2, "both the quick and the deep recall ran");
  assert.ok(lookups.every((s) => s.scope === undefined), "no room limit for the owner");
});

test("everyone else still only recalls the room they are in", async () => {
  const { agent, seen } = setup();
  await agent.turn("你記得許願的時候你許了甚麼嗎", {
    speaker: { id: "2", name: "路人" },
    group: true,
    notOwner: true,
    where: "#bot",
  });
  const lookups = seen.filter((s) => s.kind === "recall" || s.kind === "search");
  assert.ok(lookups.length >= 2);
  assert.ok(lookups.every((s) => JSON.stringify(s.scope) === JSON.stringify({ room: "#bot" })));
});
