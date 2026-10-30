import { test } from "node:test";
import assert from "node:assert/strict";
import { TypingTracker, renderAbandoned } from "../src/persona/typing.ts";

const T = 1_000_000;

test("typing then going quiet for 15s is reported as abandoned", () => {
  const t = new TypingTracker();
  t.typingStart("u1", "c1", T);
  t.typingStart("u1", "c1", T + 4_000);
  t.typingStart("u1", "c1", T + 9_000);

  assert.deepEqual(t.abandoned(T + 9_000 + 14_999), []);
  assert.deepEqual(t.abandoned(T + 9_000 + 15_000), [
    { userId: "u1", channelId: "c1", startedAt: T, lastTypedAt: T + 9_000, typedForMs: 9_000 },
  ]);
});

test("a message sent after typing clears the pending entry", () => {
  const t = new TypingTracker();
  t.typingStart("u1", "c1", T);
  t.typingStart("u1", "c1", T + 9_000);
  t.messageSent("u1", "c1", T + 10_000);
  assert.deepEqual(t.abandoned(T + 60_000), []);
});

test("a short blip of typing is ignored", () => {
  const t = new TypingTracker();
  t.typingStart("u1", "c1", T);
  t.typingStart("u1", "c1", T + 2_000);
  assert.deepEqual(t.abandoned(T + 20_000), []);
  assert.deepEqual(t.abandoned(T + 60_000), []);
});

test("an abandoned entry is reported only once", () => {
  const t = new TypingTracker();
  t.typingStart("u1", "c1", T);
  t.typingStart("u1", "c1", T + 9_000);
  assert.equal(t.abandoned(T + 25_000).length, 1);
  assert.deepEqual(t.abandoned(T + 30_000), []);
});

test("entries whose last typing is over 10 minutes old are dropped silently", () => {
  const t = new TypingTracker();
  t.typingStart("u1", "c1", T);
  t.typingStart("u1", "c1", T + 9_000);
  assert.deepEqual(t.abandoned(T + 9_000 + 600_001), []);
  assert.deepEqual(t.abandoned(T + 9_000 + 15_000), []);
});

test("at most 200 pairs are tracked, dropping the oldest", () => {
  const t = new TypingTracker();
  for (let i = 0; i <= 200; i++) {
    t.typingStart(`u${i}`, "c1", T);
    t.typingStart(`u${i}`, "c1", T + 9_000);
  }
  const reported = t.abandoned(T + 25_000);
  assert.equal(reported.length, 200);
  assert.ok(!reported.some((e) => e.userId === "u0"));
  assert.ok(reported.some((e) => e.userId === "u200"));
});

test("bad user or channel ids are rejected", () => {
  const t = new TypingTracker();
  const bad = ["", "a b", "x".repeat(65), "naïve", "line\nbreak"];
  for (const id of bad) {
    t.typingStart(id, "c1", T);
    t.typingStart("u1", id, T);
    t.typingStart(id, "c1", T + 9_000);
    t.messageSent(id, "c1", T + 9_500);
  }
  assert.deepEqual(t.abandoned(T + 60_000), []);

  const ok = "x".repeat(64);
  t.typingStart(ok, "c1", T);
  t.typingStart(ok, "c1", T + 9_000);
  assert.equal(t.abandoned(T + 25_000).length, 1);
});

test("renderAbandoned wording follows the typing length", () => {
  const now = T + 60_000;
  const line = (typedForMs: number) =>
    renderAbandoned({ typedForMs, lastTypedAt: now - 20_000 }, now);

  assert.equal(
    line(9_000),
    "（他剛剛好像打了幾秒的字，後來沒有送出來。不知道他想說什麼，別追問太兇，可以輕輕問一句。）",
  );
  assert.ok(line(30_000).includes("半分鐘"));
  assert.ok(line(90_000).includes("一兩分鐘"));
});

test("renderAbandoned returns empty when the last typing is over 10 minutes old", () => {
  const now = T + 20 * 60_000;
  assert.equal(renderAbandoned({ typedForMs: 9_000, lastTypedAt: T }, now), "");
  assert.notEqual(
    renderAbandoned({ typedForMs: 9_000, lastTypedAt: now - 600_000 }, now),
    "",
  );
});
