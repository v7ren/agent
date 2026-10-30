import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { Agent } from "../src/core/loop.ts";
import { initialMood } from "../src/persona/mood.ts";
import type { ChatRequest, ChatResult, Provider, Usage } from "../src/types.ts";

const U: Usage = { promptTokens: 1, completionTokens: 1, cacheHitTokens: 0, cacheMissTokens: 1 };
const NOW = new Date(2026, 9, 31, 1, 20);

function agentWith(provider: Provider, extra: Record<string, unknown> = {}) {
  return new Agent({
    provider,
    persona: [],
    mood: initialMood(NOW),
    now: () => NOW,
    strictPrefix: false,
    ...extra,
  } as never);
}

/** First request asks for a tool; the follow-up answers with plain text. */
function toolThenText(toolName: string, args: unknown, finalText = "好"): {
  provider: Provider;
  requests: ChatRequest[];
} {
  const requests: ChatRequest[] = [];
  let n = 0;
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      n++;
      if (n === 1) {
        return {
          text: "",
          usage: U,
          model: "m",
          toolCalls: [{ id: "t1", name: toolName, arguments: JSON.stringify(args) }],
        } as ChatResult;
      }
      return { text: finalText, usage: U, model: "m" } as ChatResult;
    },
  };
  return { provider, requests };
}

const lastUserText = (req: ChatRequest | undefined): string =>
  [...(req?.messages ?? [])].reverse().find((m) => m.role === "user")?.content ?? "";

test("a silent decline sends nothing and shows a small face instead", async () => {
  const { provider } = toolThenText("decline", { silent: true }, "我才不要說");
  const res = await agentWith(provider).turn("你今天到底吃了什麼");
  assert.equal(res.declined, true);
  assert.equal(res.segments.filter((s) => s.trim() !== "").length, 0);
  assert.equal(res.react, "🙈");
});

test("a spoken decline replaces her answer with the short line", async () => {
  const { provider } = toolThenText("decline", { reason: "這個……我不想講。" }, "長長的回答");
  const res = await agentWith(provider).turn("說嘛");
  assert.equal(res.declined, true);
  assert.equal(res.segments.join(""), "這個……我不想講。");
});

test("declining has a brake: past the hourly limit she answers anyway", async () => {
  const prev = process.env.FISHD_DECLINE_MAX_PER_HOUR;
  process.env.FISHD_DECLINE_MAX_PER_HOUR = "1";
  try {
    let n = 0;
    const provider: Provider = {
      name: "deepseek",
      async chat(req) {
        n++;
        const sawResult = req.messages.some((m) => m.role === "tool");
        if (!sawResult) {
          return {
            text: "",
            usage: U,
            model: "m",
            toolCalls: [{ id: `d${n}`, name: "decline", arguments: JSON.stringify({ silent: true }) }],
          } as ChatResult;
        }
        return { text: "那好吧我回答", usage: U, model: "m" } as ChatResult;
      },
    };
    const agent = agentWith(provider);
    const first = await agent.turn("一");
    const second = await agent.turn("二");
    assert.equal(first.declined, true);
    assert.equal(second.declined, undefined);
    assert.equal(second.segments.join(""), "那好吧我回答");
  } finally {
    if (prev === undefined) delete process.env.FISHD_DECLINE_MAX_PER_HOUR;
    else process.env.FISHD_DECLINE_MAX_PER_HOUR = prev;
  }
});

test("she is told when her last message did not arrive", async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = agentWith(provider);
  await agent.turn("一");
  agent.noteDelivery(false, new Error("Missing Permissions"));
  await agent.turn("二");
  const tip = lastUserText(requests[1]);
  assert.match(tip, /沒有送出去/);
  assert.match(tip, /權限/);
  assert.doesNotMatch(tip, /Missing Permissions/);
});

test("she is told about the environment and how he seems, as guesses", async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  await agentWith(provider).turn("哈哈哈哈笑死！！！");
  const tip = lastUserText(requests[0]);
  assert.match(tip, /你的所在/);
  assert.match(tip, /猜/);
});

test("a non-owner is not called 主人, and the owner is still recognised", async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = agentWith(provider);
  await agent.turn("超好笑", {
    speaker: { id: "2", name: "輕輕鬆鬆啊" },
    group: true,
    notOwner: true,
  });
  const stranger = lastUserText(requests[0]);
  assert.match(stranger, /輕輕鬆鬆啊」，他不是你的主人/);
  assert.match(stranger, /不要叫他「主人」/);
  assert.doesNotMatch(stranger, /這是你的主人/);

  await agent.turn("我回來了", { speaker: { id: "1", name: "ren" }, group: true, owner: true });
  const owner = lastUserText(requests[1]);
  assert.match(owner, /這是你的主人/);
  assert.doesNotMatch(owner, /他不是你的主人/);

  // No owner configured anywhere: nobody gets told they are not the owner.
  await agent.turn("嗨", { speaker: { id: "3", name: "路人" }, group: true });
  assert.doesNotMatch(lastUserText(requests[2]), /他不是你的主人/);
});

test("a reply says who it answers, so 他 is not read as the speaker", async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  await agentWith(provider).turn("你是不是討厭他", {
    speaker: { id: "1", name: "ren" },
    group: true,
    owner: true,
    prior: [{ name: "輕輕鬆鬆啊", text: "這魚是真不喜歡我啊" }],
    replyTo: { name: "輕輕鬆鬆啊", text: "這魚是真不喜歡我啊", isMe: false },
  });
  const sent = lastUserText(requests[0]);
  assert.match(sent, /\[ren\]（回覆\[輕輕鬆鬆啊\]說的「這魚是真不喜歡我啊」） 你是不是討厭他/);
  assert.match(sent, /多人聊天室/);
});

test("a reply to her own message is marked as such", async () => {
  const requests: ChatRequest[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      requests.push(req);
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  await agentWith(provider).turn("為什麼", {
    speaker: { id: "1", name: "ren" },
    group: true,
    replyTo: { name: "藍色大肥魚", text: "才不告訴你", isMe: true },
  });
  assert.match(lastUserText(requests[0]), /回覆你說的「才不告訴你」/);
});

test("she can choose to ignore a non-owner, but never an owner", async () => {
  const { mkdtempSync } = await import("node:fs");
  const { tmpdir } = await import("node:os");
  const { IgnoreBook } = await import("../src/persona/ignorebook.ts");
  const book = new IgnoreBook({
    path: join(mkdtempSync(join(tmpdir(), "ig-")), "ignored.json"),
    ownerIds: () => ["1"],
  });

  const results: string[] = [];
  const provider: Provider = {
    name: "deepseek",
    async chat(req) {
      // Tool messages never enter history, so one here means we are mid-turn.
      const tool = [...req.messages].reverse().find((m) => m.role === "tool");
      if (tool) {
        results.push(tool.content);
        return { text: "嗯", usage: U, model: "m" } as ChatResult;
      }
      const last = [...req.messages].reverse().find((m) => m.role === "user")?.content ?? "";
      if (last.includes("再見")) {
        const call = last.includes("[ren]")
          ? { person: "ren", action: "add" }
          : { person: "輕輕鬆鬆啊", action: "add", minutes: 30, reason: "一直洗版" };
        return {
          text: "",
          usage: U,
          model: "m",
          toolCalls: [{ id: "i1", name: "ignore", arguments: JSON.stringify(call) }],
        } as ChatResult;
      }
      return { text: "嗯", usage: U, model: "m" } as ChatResult;
    },
  };
  const agent = agentWith(provider, { ignores: book });
  // Both people have spoken, so she knows who they are.
  await agent.turn("嗨", { speaker: { id: "2", name: "輕輕鬆鬆啊" }, group: true });
  await agent.turn("嗨", { speaker: { id: "1", name: "ren" }, group: true, owner: true });

  await agent.turn("再見", { speaker: { id: "2", name: "輕輕鬆鬆啊" }, group: true });
  assert.equal(book.isIgnored("2", NOW), true);
  assert.match(book.render(NOW), /一直洗版/);

  await agent.turn("再見", { speaker: { id: "1", name: "ren" }, group: true, owner: true });
  assert.equal(book.isIgnored("1", NOW), false);
  assert.ok(results.some((r) => /那是主人，不能不理/.test(r)));
});

test("a tool call written as DSML text still runs and is never shown", async () => {
  let n = 0;
  const provider: Provider = {
    name: "deepseek",
    async chat() {
      n++;
      if (n === 1) {
        return {
          text:
            '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="decline"> ' +
            '<｜｜DSML｜｜ parameter name="silent" string="false">true</｜｜DSML｜｜ parameter> ' +
            "</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>",
          usage: U,
          model: "m",
        } as ChatResult;
      }
      return { text: "不講", usage: U, model: "m" } as ChatResult;
    },
  };
  const res = await agentWith(provider).turn("說");
  assert.equal(res.declined, true);
  assert.ok(!res.segments.join("").includes("DSML"));
});
