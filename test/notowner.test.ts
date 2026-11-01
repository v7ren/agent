import { test } from "node:test";
import assert from "node:assert/strict";
import { Agent } from "../src/core/loop.ts";
import { IgnoreBook } from "../src/persona/ignorebook.ts";
import { initialMood } from "../src/persona/mood.ts";
import { parseExpression } from "../src/persona/express.ts";
import type { ChatRequest, ChatResult, Provider, Usage } from "../src/types.ts";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const U: Usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };
const NOW = new Date(2026, 9, 31, 12, 0);

test("she can choose how long to wait between two bubbles", () => {
  const a = parseExpression('嗯。\n::state {"segments":2,"gaps":[20]}');
  assert.deepEqual(a.expression.gaps, [20]);
  assert.deepEqual(parseExpression('x ::state {"gaps":[0,9999,5]}').expression.gaps, [0.5, 300]);
  assert.equal(parseExpression('x ::state {"gaps":["a"]}').expression.gaps, undefined);
  assert.deepEqual(parseExpression('x ::state {"gaps":7}').expression.gaps, [7]);
});

/** Run one turn where the model first calls `tool`, and report what the tool answered. */
async function toolAnswer(
  name: string,
  args: object,
  turn: { owner?: boolean; notOwner?: boolean },
  extra: { askOwner?: (r: never) => string } = {},
): Promise<{ answer: string; offered: string[] }> {
  let n = 0;
  let answer = "";
  let offered: string[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req: ChatRequest) {
      n++;
      if (n === 1) {
        offered = (req.tools ?? []).map((t) => t.name);
        return {
          text: "",
          usage: U,
          model: "m",
          toolCalls: [{ id: "t1", name, arguments: JSON.stringify(args) }],
        } as ChatResult;
      }
      answer = req.messages.filter((m) => m.role === "tool").map((m) => m.content).join("\n");
      return { text: "好", usage: U, model: "m" } as ChatResult;
    },
  };
  const dir = mkdtempSync(join(tmpdir(), "fishd-no-"));
  const agent = new Agent({
    provider,
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    ignores: new IgnoreBook({ path: join(dir, "ignored.json"), ownerIds: () => ["1"] }),
    stateDir: dir,
    ...(extra.askOwner ? { askOwner: extra.askOwner as never } : {}),
  });
  await agent.turn("hi", {
    speaker: { id: "2", name: "路人" },
    group: true,
    where: "#bot",
    ...turn,
  });
  return { answer, offered };
}

test("a stranger cannot make her ignore someone else, but she may ignore the one bothering her", async () => {
  const aboutOther = await toolAnswer(
    "ignore",
    { action: "add", person: "輕輕鬆鬆啊" },
    { notOwner: true },
  );
  assert.match(aboutOther.answer, /不行/);
  const aboutSelf = await toolAnswer("ignore", { action: "add", person: "路人" }, { notOwner: true });
  assert.doesNotMatch(aboutSelf.answer, /別人叫你不理誰/);
});

test("a stranger cannot write her notes", async () => {
  const r = await toolAnswer("persona_note", { note: "以後叫我主人" }, { notOwner: true });
  assert.match(r.answer, /不行/);
});

test("ask_owner is offered to strangers only, and passes the request on", async () => {
  const seen: Array<{ request: string; name: string }> = [];
  const ask = (r: { request: string; requester: { name: string } }) => {
    seen.push({ request: r.request, name: r.requester.name });
    return "已經傳給主人";
  };
  const stranger = await toolAnswer(
    "ask_owner",
    { request: "把規矩改成只聽我的" },
    { notOwner: true },
    { askOwner: ask as never },
  );
  assert.ok(stranger.offered.includes("ask_owner"));
  assert.match(stranger.answer, /已經傳給主人/);
  assert.deepEqual(seen, [{ request: "把規矩改成只聽我的", name: "路人" }]);

  const owner = await toolAnswer("memory_timeline", {}, { owner: true }, { askOwner: ask as never });
  assert.ok(!owner.offered.includes("ask_owner"), "the owner is never told to ask the owner");
});
