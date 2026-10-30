import { test } from "node:test";
import assert from "node:assert/strict";
import {
  classifyError,
  recordDelivery,
  renderDelivery,
  type Delivery,
} from "../src/persona/delivery.ts";

test("classifyError maps permission codes and messages", () => {
  assert.equal(classifyError(new Error("Missing Permissions")), "permissions");
  assert.equal(classifyError(new Error("Missing Access")), "permissions");
  assert.equal(classifyError({ code: 50013 }), "permissions");
  assert.equal(classifyError({ code: 50001 }), "permissions");
  assert.equal(classifyError(50013), "permissions");
});

test("classifyError maps rate limits", () => {
  assert.equal(classifyError(new Error("HTTP 429 Too Many Requests")), "rate-limit");
  assert.equal(classifyError({ code: 429 }), "rate-limit");
  assert.equal(classifyError("You are being Rate Limit"), "rate-limit");
});

test("classifyError maps network failures", () => {
  assert.equal(classifyError({ code: "ECONNRESET" }), "network");
  assert.equal(classifyError(new Error("connect ETIMEDOUT 1.2.3.4")), "network");
  assert.equal(classifyError(new Error("getaddrinfo ENOTFOUND host")), "network");
  assert.equal(classifyError(new TypeError("fetch failed")), "network");
  assert.equal(classifyError("request timeout"), "network");
});

test("classifyError maps too-long messages", () => {
  assert.equal(classifyError({ code: 50035 }), "too-long");
  assert.equal(classifyError(new Error("Must be 2000 or fewer in length.")), "too-long");
});

test("classifyError falls back to unknown for everything else", () => {
  assert.equal(classifyError(new Error("something odd")), "unknown");
  assert.equal(classifyError("weird"), "unknown");
  assert.equal(classifyError(12345), "unknown");
  assert.equal(classifyError(null), "unknown");
  assert.equal(classifyError(undefined), "unknown");
  assert.equal(classifyError({ code: 404 }), "unknown");
  assert.equal(classifyError({ foo: 1 }), "unknown");
});

test("recordDelivery stores the reason, not the error", () => {
  const now = new Date(2026, 9, 31, 1, 20);
  const ok = recordDelivery(true, now);
  assert.deepEqual(ok, { at: now.toISOString(), ok: true, reason: "ok", segments: 1 });

  const failed = recordDelivery(false, now, { code: 50013 }, 3);
  assert.deepEqual(failed, { at: now.toISOString(), ok: false, reason: "permissions", segments: 3 });

  assert.equal(recordDelivery(false, now).reason, "unknown");
});

test("renderDelivery success line, with and without a reply", () => {
  const sent = new Date(2026, 9, 31, 1, 20);
  const d = recordDelivery(true, sent);
  const now = new Date(sent.getTime() + 30 * 60_000);
  assert.equal(
    renderDelivery(d, now, false),
    "（你上一句話在 01:20 已經送到聊天裡了；他之後還沒回。）",
  );
  assert.equal(
    renderDelivery(d, now, true),
    "（你上一句話在 01:20 已經送到聊天裡了；他之後有回了。）",
  );
});

test("renderDelivery failure line explains each reason", () => {
  const now = new Date(2026, 9, 31, 2, 0);
  const cases: Array<[unknown, string]> = [
    [{ code: 50013 }, "沒有發言權限"],
    [{ code: 429 }, "被限流"],
    [{ code: "ECONNRESET" }, "網路出問題"],
    [{ code: 50035 }, "太長"],
    [new Error("boom"), "原因不明"],
  ];
  for (const [err, label] of cases) {
    const d = recordDelivery(false, now, err);
    assert.equal(
      renderDelivery(d, now, false),
      `（你上一句話沒有送出去：${label}。他可能根本沒看到，不要當作他已經知道。）`,
    );
  }
});

test("renderDelivery is empty for null and for deliveries older than 12 hours", () => {
  const sent = new Date(2026, 9, 31, 1, 20);
  assert.equal(renderDelivery(null, sent, false), "");
  const d = recordDelivery(true, sent);
  assert.equal(renderDelivery(d, new Date(sent.getTime() + 12 * 3_600_000), false) !== "", true);
  assert.equal(renderDelivery(d, new Date(sent.getTime() + 12 * 3_600_000 + 1), false), "");
  const failed = recordDelivery(false, sent, new Error("x"));
  assert.equal(renderDelivery(failed, new Date(sent.getTime() + 13 * 3_600_000), false), "");
});

test("a raw error token never appears in the rendered output", () => {
  const sent = new Date(2026, 9, 31, 1, 20);
  const secret = "Bot abc.def.ghi";
  const errors: unknown[] = [
    new Error(`${secret} rejected`),
    `fetch failed: ${secret}`,
    { message: `${secret} Missing Permissions`, code: 50013 },
    { code: 99999, message: secret },
  ];
  for (const err of errors) {
    const rendered = renderDelivery(recordDelivery(false, sent, err), sent, true);
    assert.ok(rendered.length > 0);
    assert.equal(rendered.includes("abc.def.ghi"), false, rendered);
    assert.equal(rendered.includes("Bot"), false, rendered);
  }
  const stored: Delivery = recordDelivery(false, sent, new Error(secret));
  assert.equal(JSON.stringify(stored).includes("abc.def.ghi"), false);
});
