import { test } from "node:test";
import assert from "node:assert/strict";
import { canSpeakNow, inHush, nextDelayMs, parseHush } from "../src/channels/spontaneous.ts";
import type { SpontaneousPlan } from "../src/channels/spontaneous.ts";

const plan: SpontaneousPlan = {
  minMinutes: 90,
  maxMinutes: 240,
  quietMinutes: 20,
  hushFrom: 1,
  hushTo: 6,
};

test("hush covers 01:00-06:00", () => {
  assert.equal(inHush(0.5, plan), false);
  assert.equal(inHush(1, plan), true);
  assert.equal(inHush(3.5, plan), true);
  assert.equal(inHush(6, plan), false);
  assert.equal(inHush(15, plan), false);
});

test("parseHush understands ranges and 'off'", () => {
  assert.deepEqual(parseHush("1-6"), { from: 1, to: 6 });
  assert.deepEqual(parseHush(" 23 - 7 "), { from: 23, to: 7 });
  assert.deepEqual(parseHush("off"), { from: 0, to: 0 });
  assert.deepEqual(parseHush(""), { from: 0, to: 0 });
  assert.deepEqual(parseHush(undefined), { from: 0, to: 0 });
  assert.deepEqual(parseHush("garbage"), { from: 1, to: 6 });
});

test("hush window can wrap past midnight", () => {  const wrap = { ...plan, hushFrom: 23, hushTo: 7 };
  assert.equal(inHush(23.5, wrap), true);
  assert.equal(inHush(2, wrap), true);
  assert.equal(inHush(8, wrap), false);
  assert.equal(inHush(22, wrap), false);
});

test("delay stays inside the configured window", () => {
  assert.equal(nextDelayMs(plan, 0), 90 * 60_000);
  assert.equal(nextDelayMs(plan, 1), 240 * 60_000);
  const mid = nextDelayMs(plan, 0.5);
  assert.ok(mid > 90 * 60_000 && mid < 240 * 60_000);
});

test("swapped or invalid bounds still produce a sane delay", () => {
  const swapped = { ...plan, minMinutes: 300, maxMinutes: 60 };
  const d = nextDelayMs(swapped, 0.5);
  assert.ok(d >= 60 * 60_000 && d <= 300 * 60_000);
  assert.equal(nextDelayMs(plan, Number.NaN), 90 * 60_000);
});

test("she waits for the room to go quiet", () => {
  const now = Date.now();
  assert.equal(canSpeakNow({ now, lastMessageAt: now - 60_000, hour: 15, plan }), false);
  assert.equal(canSpeakNow({ now, lastMessageAt: now - 21 * 60_000, hour: 15, plan }), true);
  assert.equal(canSpeakNow({ now, lastMessageAt: 0, hour: 15, plan }), true);
});

test("quiet hours win over a quiet room", () => {
  const now = Date.now();
  assert.equal(canSpeakNow({ now, lastMessageAt: 0, hour: 3, plan }), false);
});
