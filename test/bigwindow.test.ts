import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Agent, attributablePeople } from "../src/core/loop.ts";
import { initialMood } from "../src/persona/mood.ts";
import type { ChatRequest, ChatResult, Provider, Usage } from "../src/types.ts";

const U: Usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };
const NOW = new Date(2026, 9, 31, 2, 30);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const COMPACTION_JSON = JSON.stringify({
  summary: ["ren 一直在聊白飯配鹹魚", "大家聊得很開心"],
  threads: ["說好下次要一起吃飯"],
  people: [{ name: "ren", facts: [{ kind: "habit", text: "喜歡白飯配鹹魚" }] }],
});

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "bw-"));
  const stateDir = join(root, "state");
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      const isCompaction = (req.messages[0]?.content ?? "").includes("JSON");
      return { text: isCompaction ? COMPACTION_JSON : "好的，我記得喔", usage: U, model: "m" } as ChatResult;
    },
  };
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  const memory = {
    recall: () => null,
    log: () => {},
    search: () => [],
    timeline: () => [],
    diary: () => null,
    person: () => null,
    setPerson: (id: string, patch: Record<string, unknown>) => {
      patches.push({ id, patch });
      return {} as never;
    },
  };
  const make = () =>
    new Agent({
      provider,
      persona: [],
      mood: initialMood(NOW),
      now: () => NOW,
      strictPrefix: false,
      memory: memory as never,
      window: { limitTokens: 300, keepFraction: 0.3 },
      historyKey: "chan1",
      stateDir,
      sessionsDir: root,
      where: "#bot",
    });
  return { root, stateDir, requests, patches, make };
}

async function waitFor(check: () => boolean, ms = 3000): Promise<boolean> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return true;
    await sleep(25);
  }
  return check();
}

test("a long chat is compacted into a linked note, and what she learned goes to the person", async () => {
  const f = fixture();
  const agent = f.make();
  for (let i = 0; i < 14; i++) {
    await agent.turn(`這是第${i}句，我們一直在聊白飯和鹹魚，聊得很開心喔`, {
      speaker: { id: "1", name: "ren" },
      group: true,
      owner: true,
    });
  }
  const dir = join(f.root, "sessions");
  const found = await waitFor(() => existsSync(dir) && readdirSync(dir).length > 0);
  assert.ok(found, "a sessions folder should appear");

  const scope = readdirSync(dir)[0]!;
  const files = readdirSync(join(dir, scope));
  assert.ok(files.some((n) => /^cp-001\.md$/.test(n)));
  const doc = readFileSync(join(dir, scope, "cp-001.md"), "utf8");
  assert.match(doc, /ren 一直在聊白飯配鹹魚/);
  assert.match(doc, /## 還沒完成/);
  assert.match(doc, /\[\[journal\/2026\/10\/2026-10-31\]\]/);
  assert.match(doc, /\[\[nodes\/people\/1\]\]/);
  // The links section is the last thing in the file.
  assert.ok(doc.indexOf("## 關聯") > doc.indexOf("## 還沒完成"));

  assert.ok(f.patches.some((p) => p.id === "1" && p.patch["habit"] === "喜歡白飯配鹹魚"));
  assert.ok(agent.transcript.length < 28, "the raw history should have shrunk");
});

test("after a restart she still has the recent chat, the people, and her summary notes", async () => {
  const f = fixture();
  const first = f.make();
  for (let i = 0; i < 14; i++) {
    await first.turn(`這是第${i}句，我們一直在聊白飯和鹹魚，聊得很開心喔`, {
      speaker: { id: "1", name: "ren" },
      group: true,
      owner: true,
    });
  }
  await waitFor(() => existsSync(join(f.root, "sessions")) && readdirSync(join(f.root, "sessions")).length > 0);
  await sleep(100);
  assert.ok(existsSync(join(f.stateDir, "history")), "history is written to disk");

  const second = f.make();
  assert.ok(second.transcript.length > 0, "the chat comes back");
  assert.ok(second.turns > 0, "she is not a stranger again");

  f.requests.length = 0;
  await second.turn("我回來了", { speaker: { id: "1", name: "ren" }, group: true, owner: true });
  const system = f.requests[0]?.messages[0]?.content ?? "";
  assert.match(system, /<checkpoint n="1">/);
  assert.match(system, /ren 一直在聊白飯配鹹魚/);
  // The links section is for the vault, not for her prompt.
  assert.doesNotMatch(system, /\[\[journal/);
});

test("two DMs never read each other's summary notes", async () => {
  const f = fixture();
  const make = (key: string) =>
    new Agent({
      provider: {
        name: "deepseek",
        async chat(req) {
          const isCompaction = (req.messages[0]?.content ?? "").includes("JSON");
          return { text: isCompaction ? COMPACTION_JSON : "好的，我記得喔", usage: U, model: "m" } as ChatResult;
        },
      },
      persona: [],
      mood: initialMood(NOW),
      now: () => NOW,
      strictPrefix: false,
      window: { limitTokens: 300, keepFraction: 0.3 },
      historyKey: key,
      stateDir: f.stateDir,
      sessionsDir: f.root,
      // Every DM carries the same label, as it does in Discord.
      where: "私訊",
    });
  const alice = make("dm:111");
  for (let i = 0; i < 14; i++) {
    await alice.turn(`這是第${i}句，我們一直在聊白飯和鹹魚，聊得很開心喔`, {
      speaker: { id: "111", name: "ren" },
      group: false,
      owner: true,
    });
  }
  await waitFor(() => existsSync(join(f.root, "sessions")) && readdirSync(join(f.root, "sessions")).length > 0);
  await sleep(100);

  const bob = make("dm:222");
  assert.equal(bob.transcript.length, 0);
  const prompts: string[] = [];
  const probe = new Agent({
    provider: {
      name: "deepseek",
      async chat(req) {
        prompts.push(req.messages[0]?.content ?? "");
        return { text: "嗯", usage: U, model: "m" } as ChatResult;
      },
    },
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    window: { limitTokens: 300, keepFraction: 0.3 },
    historyKey: "dm:222",
    stateDir: f.stateDir,
    sessionsDir: f.root,
    where: "私訊",
  });
  await probe.turn("嗨", { speaker: { id: "222", name: "路人" }, group: false });
  assert.ok(!prompts[0]?.includes("白飯配鹹魚"), "Bob must not see Alice's note");

  // Alice, restarted, still has hers.
  const again = make("dm:111");
  assert.ok(again.transcript.length > 0);
});

test("compaction only attaches facts to people who spoke, and never to a shared name", () => {
  const roster = [
    { id: "1", name: "ren", lastAt: 1 },
    { id: "2", name: "Wennn", lastAt: 2 },
    { id: "3", name: "REN", lastAt: 3 },
    { id: "4", name: "路人", lastAt: 4 },
  ];
  const slice = [
    { role: "user" as const, content: "[Wennn] 嗨\n[ren → Wennn] 你好" },
    { role: "assistant" as const, content: "哼" },
    { role: "user" as const, content: "[REN] 我也在" },
  ];
  const got = attributablePeople(roster, slice).map((p) => p.id);
  // 'ren' and 'REN' are the same name to a reader, so neither is trusted.
  assert.deepEqual(got, ["2"]);
});

test("with the big window off, nothing is saved and the old behaviour stays", async () => {
  const f = fixture();
  const agent = new Agent({
    provider: { name: "deepseek", async chat() { return { text: "嗯", usage: U, model: "m" } as ChatResult; } },
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    stateDir: f.stateDir,
    historyKey: "chan1",
  });
  await agent.turn("嗨");
  assert.ok(!existsSync(join(f.stateDir, "history")));
});
