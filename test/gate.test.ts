import { test } from "node:test";
import assert from "node:assert/strict";
import {
  HeuristicGate,
  JevGate,
  LlmGate,
  buildGatePrompt,
  buildJevState,
  parseVerdict,
  scaledThreshold,
} from "../src/channels/gate.ts";
import type { Gate, GateInput } from "../src/channels/gate.ts";

const input: GateInput = {
  channel: "c1",
  messages: [
    { author: "小明", text: "今天要吃什麼", at: 0 },
    { author: "阿華", text: "火鍋好不好", at: 1 },
  ],
  names: ["大肥魚", "肥魚"],
  lastSpokeAt: 0,
  now: 600_000,
  base: 0.12,
  messageId: "m1",
};

const never: Gate = { name: "never", decide: async () => false };
const always: Gate = { name: "always", decide: async () => true };

test("parseVerdict accepts the obvious shapes", () => {
  assert.equal(parseVerdict("YES"), true);
  assert.equal(parseVerdict("yes, because rice"), true);
  assert.equal(parseVerdict("NO"), false);
  assert.equal(parseVerdict("No."), false);
  assert.equal(parseVerdict("是"), true);
  assert.equal(parseVerdict("不要"), false);
  assert.equal(parseVerdict("不是"), false);
  assert.equal(parseVerdict("不用了"), false);
  assert.equal(parseVerdict("安靜點"), null);
  assert.equal(parseVerdict("¯\\_(ツ)_/¯"), null);
});

test("gate prompt carries the room, the names, and the question", () => {
  const prompt = buildGatePrompt(input);
  assert.ok(prompt.includes("阿華：火鍋好不好"));
  assert.ok(prompt.includes("大肥魚"));
  assert.ok(prompt.includes("YES"));
});

test("llm gate returns the model's verdict", async () => {
  const gate = new LlmGate({
    complete: async () => "YES",
    fallback: never,
  });
  assert.equal(await gate.decide(input), true);
});

test("llm gate falls back when the model rambles", async () => {
  let called = false;
  const gate = new LlmGate({
    complete: async () => "hmm maybe?",
    fallback: {
      name: "spy",
      decide: async () => {
        called = true;
        return true;
      },
    },
  });
  assert.equal(await gate.decide(input), true);
  assert.equal(called, true);
});

test("llm gate falls back on network failure", async () => {
  const gate = new LlmGate({
    complete: async () => {
      throw new Error("502");
    },
    fallback: always,
  });
  assert.equal(await gate.decide(input), true);
});

test("llm gate falls back on timeout", async () => {
  const gate = new LlmGate({
    complete: (_p, signal) =>
      new Promise((_resolve, reject) => {
        signal.addEventListener("abort", () => reject(new Error("aborted")));
      }),
    fallback: always,
    timeoutMs: 20,
  });
  assert.equal(await gate.decide(input), true);
});

test("llm gate rate limit degrades to the heuristic", async () => {
  let calls = 0;
  const gate = new LlmGate({
    complete: async () => {
      calls++;
      return "YES";
    },
    fallback: never,
    maxPerMinute: 2,
  });
  await gate.decide(input);
  await gate.decide(input);
  assert.equal(await gate.decide(input), false);
  assert.equal(calls, 2);
});

test("heuristic gate stays silent on an unremarkable statement", async () => {
  const gate = new HeuristicGate();
  const verdict = await gate.decide({
    ...input,
    messages: [{ author: "小明", text: "嗯嗯原來是這樣", at: 0 }],
  });
  assert.equal(typeof verdict, "boolean");
});

const reply = (body: unknown, status = 200) =>
  (async () =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json" },
    })) as unknown as typeof fetch;

test("jev turns a probability into a decision", async () => {
  const yes = new JevGate({
    apiKey: "k",
    threshold: 0.55,
    fallback: never,
    fetchImpl: reply({ answers: { speak: { type: "noul", noul: 0.81 } } }),
  });
  assert.equal(await yes.decide(input), true);

  const no = new JevGate({
    apiKey: "k",
    threshold: 0.55,
    fallback: always,
    fetchImpl: reply({ answers: { speak: { type: "noul", noul: 0.21 } } }),
  });
  assert.equal(await no.decide(input), false);
});

test("jev falls back on http error or a missing answer", async () => {
  const broken = new JevGate({
    apiKey: "k",
    fallback: always,
    fetchImpl: reply({ error: "nope" }, 500),
  });
  assert.equal(await broken.decide(input), true);

  const empty = new JevGate({
    apiKey: "k",
    fallback: always,
    fetchImpl: reply({ answers: {} }),
  });
  assert.equal(await empty.decide(input), true);
});

test("being addressed lowers the bar, talking to others does not", async () => {
  const make = (speak: number, toMe: number) =>
    new JevGate({
      apiKey: "k",
      threshold: 0.5,
      fallback: never,
      toMeBonusFn: () => 1,
      fetchImpl: reply({
        answers: { speak: { type: "noul", noul: speak }, to_me: { type: "noul", noul: toMe } },
      }),
    });

  // threshold 0.5; addressed at 1.0 halves it to 0.25
  assert.equal(await make(0.3, 1).decide(input), true);
  assert.equal(await make(0.3, 0).decide(input), false);
  assert.equal(await make(0.6, 0).decide(input), true);
});

test("a missing to_me answer is treated as 'not addressed'", async () => {
  const gate = new JevGate({
    apiKey: "k",
    threshold: 0.4,
    fallback: never,
    toMeBonusFn: () => 1,
    fetchImpl: reply({ answers: { speak: { type: "noul", noul: 0.3 } } }),
  });
  assert.equal(await gate.decide(input), false);
});

test("bias makes her harder to convince, not silent by fiat", async () => {
  const make = (noul: number) =>
    new JevGate({
      apiKey: "k",
      threshold: 0.32,
      fallback: never,
      fetchImpl: reply({ answers: { speak: { type: "noul", noul } } }),
    });

  // 0.57 clears 0.32 but not 0.64
  assert.equal(await make(0.57).decide({ ...input, bias: 1 }), true);
  assert.equal(await make(0.57).decide({ ...input, bias: 2 }), false);
  assert.equal(await make(0.7).decide({ ...input, bias: 2 }), true);
});

test("jev state carries the room context", () => {
  const state = buildJevState(input);
  assert.ok(state.includes("阿華：火鍋好不好"));
  assert.ok(state.includes("大肥魚"));
  assert.ok(state.includes("最後一則") || state.includes("距離"));
});

test("talkativeness divides the threshold and stays in range", () => {
  assert.equal(scaledThreshold(0.32, 1), 0.32);
  assert.equal(scaledThreshold(0.32, 2), 0.16);
  assert.equal(scaledThreshold(0.32, 0.5), 0.64);
  assert.equal(scaledThreshold(0.32, 0), 0.32, "invalid factor falls back to 1");
  assert.equal(scaledThreshold(0.32, 100), 0.02, "never becomes 0");
  assert.equal(scaledThreshold(0.32, 0.1), 0.95, "never becomes 1");
});
