import { test } from "node:test";
import assert from "node:assert/strict";
import { DeclineLimiter, declineLine, declineMaxFromEnv } from "../src/persona/decline.ts";

const t0 = new Date("2026-10-30T12:00:00Z");
const at = (ms: number) => new Date(t0.getTime() + ms);
const HOUR = 3_600_000;

test("the limiter allows up to the max and counts remaining down", () => {
  const limiter = new DeclineLimiter(3);
  assert.equal(limiter.remaining(t0), 3);
  for (let i = 0; i < 3; i++) {
    assert.equal(limiter.allow(t0), true);
    limiter.record(t0);
  }
  assert.equal(limiter.allow(t0), false);
  assert.equal(limiter.remaining(t0), 0);
});

test("declines roll off after a rolling 60-minute window", () => {
  const limiter = new DeclineLimiter(2);
  limiter.record(at(0));
  limiter.record(at(20 * 60_000));
  assert.equal(limiter.allow(at(30 * 60_000)), false);

  // The first decline is 60 minutes old now, so one slot is free again.
  assert.equal(limiter.allow(at(HOUR)), true);
  assert.equal(limiter.remaining(at(HOUR)), 1);

  // Once the second one is also 60 minutes old, the full budget is back.
  assert.equal(limiter.remaining(at(HOUR + 20 * 60_000)), 2);
});

test("maxPerHour of zero or less disables declining", () => {
  for (const max of [0, -2]) {
    const limiter = new DeclineLimiter(max);
    assert.equal(limiter.allow(t0), false);
    limiter.record(t0);
    assert.equal(limiter.allow(t0), false);
    assert.equal(limiter.remaining(t0), 0);
  }
});

test("stored timestamps are capped at 50", () => {
  const limiter = new DeclineLimiter(100);
  for (let i = 0; i < 60; i++) limiter.record(t0);
  assert.equal(limiter.remaining(t0), 50);
});

test("declineLine collapses whitespace and newlines", () => {
  assert.equal(declineLine("  不想\n\n  講   欸\t"), "不想 講 欸");
});

test("declineLine strips markdown markers and angle brackets", () => {
  assert.equal(declineLine("**不想** _講_ `code`"), "不想 講 code");
  assert.equal(declineLine("<b>嗯</b>"), "b 嗯 /b");
  assert.doesNotMatch(declineLine("# 標題 ~~刪~~ > 引用 | 表 [連結](x)"), /[#~>|\[\]()*_`<]/);
  assert.equal(declineLine("- 清單項目"), "清單項目");
});

test("declineLine removes @mentions including @everyone", () => {
  assert.equal(declineLine("@everyone 我不想講"), "我不想講");
  assert.equal(declineLine("嗯 @here, 就是不想"), "嗯 就是不想");
  assert.doesNotMatch(declineLine("@everyone"), /@/);
});

test("declineLine removes URLs", () => {
  assert.equal(declineLine("看 http://x.y 就知道"), "看 就知道");
  assert.doesNotMatch(declineLine("see https://a.b/c?d=1 now"), /https?|\.b|www/);
  assert.doesNotMatch(declineLine("www.example.com 不想"), /www|example/);
});

test("declineLine clips to 30 characters", () => {
  const out = declineLine("字".repeat(50));
  assert.equal(Array.from(out).length, 30);
});

test("declineLine falls back when the reason is empty or unusable", () => {
  const fallback = "這個……我不想講。";
  assert.equal(declineLine(""), fallback);
  assert.equal(declineLine("   \n\t "), fallback);
  assert.equal(declineLine("@everyone http://x.y"), fallback);
  assert.equal(declineLine(undefined), fallback);
  assert.equal(declineLine(42), fallback);
});

test("declineMaxFromEnv defaults to 3 when unset, empty or invalid", () => {
  assert.equal(declineMaxFromEnv({}), 3);
  assert.equal(declineMaxFromEnv({ FISHD_DECLINE_MAX_PER_HOUR: "" }), 3);
  assert.equal(declineMaxFromEnv({ FISHD_DECLINE_MAX_PER_HOUR: "abc" }), 3);
  assert.equal(declineMaxFromEnv({ FISHD_DECLINE_MAX_PER_HOUR: "2.5" }), 3);
});

test("declineMaxFromEnv parses and clamps to 0..10", () => {
  const read = (v: string) => declineMaxFromEnv({ FISHD_DECLINE_MAX_PER_HOUR: v });
  assert.equal(read("5"), 5);
  assert.equal(read(" 7 "), 7);
  assert.equal(read("0"), 0);
  assert.equal(read("-4"), 0);
  assert.equal(read("99"), 10);
});
