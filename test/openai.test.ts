import { test } from "node:test";
import assert from "node:assert/strict";
import { OpenAICompatProvider, callBudgetFromEnv, timeoutFromEnv } from "../src/core/openai.ts";
import type { FetchLike } from "../src/core/openai.ts";

const OK_BODY = {
  choices: [{ message: { content: "hi" }, finish_reason: "stop" }],
  usage: { prompt_tokens: 3, completion_tokens: 1 },
};

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

function scripted(responses: Array<() => Response | Promise<Response>>) {
  const sleeps: number[] = [];
  let calls = 0;
  const fetch: FetchLike = async () => {
    const step = responses[Math.min(calls, responses.length - 1)];
    calls++;
    if (!step) throw new Error("no scripted response");
    return step();
  };
  const make = (extra: Record<string, unknown> = {}) =>
    new OpenAICompatProvider({
      apiKey: "test-key",
      baseUrl: "https://example.test/v1",
      model: "m",
      name: "deepseek",
      fetch,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
      backoffMs: 500,
      ...extra,
    });
  return { make, sleeps, count: () => calls };
}

const REQ = { messages: [{ role: "user" as const, content: "yo" }], maxTokens: 10 };

test("retries 503 with exponential backoff, then succeeds", async () => {
  const s = scripted([
    () => json(503, { error: "busy" }),
    () => json(503, { error: "busy" }),
    () => json(200, OK_BODY),
  ]);
  const res = await s.make().chat(REQ);
  assert.equal(res.text, "hi");
  assert.equal(s.count(), 3);
  assert.deepEqual(s.sleeps, [500, 1000]);
});

test("429 honours Retry-After in seconds", async () => {
  const s = scripted([
    () => json(429, { error: "slow down" }, { "retry-after": "3" }),
    () => json(200, OK_BODY),
  ]);
  await s.make().chat(REQ);
  assert.equal(s.count(), 2);
  assert.deepEqual(s.sleeps, [3000]);
});

test("400 is not retried", async () => {
  const s = scripted([() => json(400, { error: "bad" })]);
  await assert.rejects(s.make().chat(REQ), /deepseek 400/);
  assert.equal(s.count(), 1);
  assert.deepEqual(s.sleeps, []);
});

test("network errors retry and then give up after the retry budget", async () => {
  const s = scripted([() => Promise.reject(new TypeError("fetch failed"))]);
  await assert.rejects(s.make({ retries: 2 }).chat(REQ), /fetch failed/);
  assert.equal(s.count(), 3);
  assert.deepEqual(s.sleeps, [500, 1000]);
});

test("a hung request is cut by the per-attempt timeout and never retried", async () => {
  let calls = 0;
  const hang: FetchLike = (_url, init) => {
    calls++;
    // AbortSignal.timeout timers are unref'd; keep the loop alive while waiting.
    const keep = setTimeout(() => {}, 2000);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keep);
        reject(init.signal?.reason);
      });
    });
  };
  const sleeps: number[] = [];
  const p = new OpenAICompatProvider({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    model: "m",
    fetch: hang,
    timeoutMs: 20,
    retries: 1,
    backoffMs: 500,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(p.chat(REQ), (err: unknown) => {
    return err instanceof Error && err.name === "TimeoutError";
  });
  assert.equal(calls, 1, "a timed-out request may already be billed, so it is not resent");
  assert.deepEqual(sleeps, []);
});

test("429 Retry-After is honoured but a single wait is capped at 10s", async () => {
  const s = scripted([
    () => json(429, { error: "slow down" }, { "retry-after": "60" }),
    () => json(200, OK_BODY),
  ]);
  await s.make().chat(REQ);
  assert.equal(s.count(), 2);
  assert.deepEqual(s.sleeps, [10_000]);
});

test("an abort seen on a retryable response returns without sleeping", async () => {
  const ac = new AbortController();
  let calls = 0;
  const fetch: FetchLike = async () => {
    calls++;
    ac.abort();
    return json(503, { error: "busy" });
  };
  const sleeps: number[] = [];
  const p = new OpenAICompatProvider({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    model: "m",
    fetch,
    retries: 2,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
  });
  await assert.rejects(p.chat({ ...REQ, signal: ac.signal }), (err: unknown) => {
    return (err as Error).name === "AbortError";
  });
  assert.equal(calls, 1);
  assert.deepEqual(sleeps, []);
});

test("the call budget caps wall-clock time across all attempts", async () => {
  let calls = 0;
  const slow: FetchLike = async () => {
    calls++;
    await new Promise((r) => setTimeout(r, 60));
    return json(503, { error: "busy" }, { "retry-after": "0" });
  };
  const p = new OpenAICompatProvider({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    model: "m",
    fetch: slow,
    retries: 5,
    callBudgetMs: 100,
    sleep: async () => {},
  });
  await assert.rejects(p.chat(REQ), /503/);
  // Timers jitter under load, so assert the budget stopped it well before
  // all 6 attempts rather than pinning an exact count.
  assert.ok(calls >= 1 && calls <= 3, `budget should stop retries early, got ${calls} calls`);
});

test("callBudgetFromEnv reads FISHD_CALL_BUDGET_MS and falls back to 90s", () => {
  assert.equal(callBudgetFromEnv({ FISHD_CALL_BUDGET_MS: "1500" }), 1500);
  assert.equal(callBudgetFromEnv({}), 90_000);
  assert.equal(callBudgetFromEnv({ FISHD_CALL_BUDGET_MS: "abc" }), 90_000);
  assert.equal(callBudgetFromEnv({ FISHD_CALL_BUDGET_MS: "0" }), 90_000);
});

test("the caller's own abort is never retried", async () => {
  let calls = 0;
  const ac = new AbortController();
  const hang: FetchLike = (_url, init) => {
    calls++;
    const keep = setTimeout(() => {}, 2000);
    return new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        clearTimeout(keep);
        reject(new Error("aborted by caller"));
      });
      ac.abort();
    });
  };
  const p = new OpenAICompatProvider({
    apiKey: "k",
    baseUrl: "https://example.test/v1",
    model: "m",
    fetch: hang,
    retries: 2,
    sleep: async () => {},
  });
  await assert.rejects(p.chat({ ...REQ, signal: ac.signal }), /aborted by caller/);
  assert.equal(calls, 1);
});

test("timeoutFromEnv reads FISHD_TIMEOUT_MS and falls back to 60s", () => {
  assert.equal(timeoutFromEnv({ FISHD_TIMEOUT_MS: "1500" }), 1500);
  assert.equal(timeoutFromEnv({}), 60_000);
  assert.equal(timeoutFromEnv({ FISHD_TIMEOUT_MS: "abc" }), 60_000);
  assert.equal(timeoutFromEnv({ FISHD_TIMEOUT_MS: "-5" }), 60_000);
});
