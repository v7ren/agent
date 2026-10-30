import test from "node:test";
import assert from "node:assert/strict";
import { aimedElsewhere } from "../src/channels/addressing.ts";
import { Agent, stripSpeakerTag } from "../src/core/loop.ts";
import { initialMood } from "../src/persona/mood.ts";
import type { ChatRequest, ChatResult, Provider } from "../src/types.ts";

const ME = "100";
const NAMES = ["大肥魚", "肥魚"];

test("an @ at someone else, with no call for her, is aimed elsewhere", () => {
  assert.equal(
    aimedElsewhere({ meId: ME, mentionedIds: ["200"], text: "@輕輕鬆鬆啊 你看他討厭你", names: NAMES }),
    true,
  );
});

test("a bare @name for someone else is aimed elsewhere too", () => {
  assert.equal(
    aimedElsewhere({ meId: ME, mentionedIds: ["200"], text: "@輕輕鬆鬆啊", names: NAMES }),
    true,
  );
});

test("calling her too (mention or name) makes it hers", () => {
  assert.equal(
    aimedElsewhere({ meId: ME, mentionedIds: ["200", ME], text: "你們兩個", names: NAMES }),
    false,
  );
  assert.equal(
    aimedElsewhere({ meId: ME, mentionedIds: ["200"], text: "@輕輕鬆鬆啊 問肥魚", names: NAMES }),
    false,
  );
});

test("no mentions at all is never aimed elsewhere", () => {
  assert.equal(aimedElsewhere({ meId: ME, mentionedIds: [], text: "哈哈", names: NAMES }), false);
});

test("only her own mention is not aimed elsewhere, and a missing bot id is safe", () => {
  assert.equal(aimedElsewhere({ meId: ME, mentionedIds: [ME], text: "嗨", names: NAMES }), false);
  assert.equal(aimedElsewhere({ meId: undefined, mentionedIds: ["200"], text: "嗨", names: [""] }), true);
});

function capture(): { provider: Provider; seen: () => string } {
  let last = "";
  const provider: Provider = {
    name: "deepseek",
    async chat(req: ChatRequest) {
      last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      return {
        text: "嗯",
        model: "m",
        usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 },
      } as ChatResult;
    },
  };
  return { provider, seen: () => last };
}

const NOW = new Date(2026, 9, 31, 1, 40);
const mk = (provider: Provider) =>
  new Agent({ provider, persona: [], mood: initialMood(NOW), now: () => NOW, strictPrefix: false });

test("her reply never starts with the prompt's own speaker label", async () => {
  const provider: Provider = {
    name: "deepseek",
    async chat() {
      return {
        text: "[ren → Wennn] 這個是對 Wennn 說的。",
        model: "m",
        usage: { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 },
      } as ChatResult;
    },
  };
  const res = await mk(provider).turn("@Wennn 你再刷一下", {
    speaker: { id: "1", name: "ren" },
    group: true,
    owner: true,
    aimedAt: ["Wennn"],
  });
  assert.ok(!res.segments.join("").includes("[ren"));
  assert.ok(!res.segments.join("").includes("→"));
});

test("only labels are stripped, not a reply that really starts with a bracket", () => {
  const names = ["ren", "Wennn"];
  assert.equal(stripSpeakerTag("[ren → Wennn] 嗯", names), "嗯");
  assert.equal(stripSpeakerTag("[ren] 嗯", names), "嗯");
  assert.equal(stripSpeakerTag("[笑] 嗯", names), "[笑] 嗯");
  assert.equal(stripSpeakerTag("嗯 [ren] 嗯", names), "嗯 [ren] 嗯");
});

test("a line aimed at someone else is tagged in the speaker, with the text untouched", async () => {
  const { provider, seen } = capture();
  await mk(provider).turn("@輕輕鬆鬆啊", {
    speaker: { id: "1", name: "ren" },
    group: true,
    owner: true,
    aimedAt: ["輕輕鬆鬆啊"],
    prior: [{ name: "輕輕鬆鬆啊", text: "怎麼不鳥我" }],
  });
  const sent = seen();
  assert.match(sent, /\[ren → 輕輕鬆鬆啊\] @輕輕鬆鬆啊/);
  // The text carries no instructions of its own.
  assert.doesNotMatch(sent, /不是對你說話/);
  assert.doesNotMatch(sent, /<@/);
});

test("earlier lines keep who they were for", async () => {
  const { provider, seen } = capture();
  await mk(provider).turn("好笑", {
    speaker: { id: "2", name: "輕輕鬆鬆啊" },
    group: true,
    prior: [{ name: "ren", text: "@輕輕鬆鬆啊 你看他", to: ["輕輕鬆鬆啊"] }],
  });
  assert.match(seen(), /\[ren → 輕輕鬆鬆啊\] @輕輕鬆鬆啊 你看他/);
});
