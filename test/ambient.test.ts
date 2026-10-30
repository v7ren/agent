import { test } from "node:test";
import assert from "node:assert/strict";
import { ambientChime, ambientCooldownElapsed } from "../src/channels/ambient.ts";
import type { AmbientInput } from "../src/channels/ambient.ts";

const base: AmbientInput = {
  text: "今天天氣真好",
  messageId: "m1",
  authorId: "a",
  lastSpokeAt: 0,
  now: 1_000_000,
  base: 0.12,
  names: ["大肥魚", "肥魚"],
};

test("cooldown blocks back-to-back ambient replies", () => {
  const now = 1_000_000;
  assert.equal(ambientCooldownElapsed(now, now - 10_000, 45), false);
  assert.equal(ambientCooldownElapsed(now, now - 46_000, 45), true);
  assert.equal(ambientCooldownElapsed(now, 0, 45), true);
  assert.equal(ambientCooldownElapsed(now, now - 1, 0), true, "0 disables it");
});

test("being called by name always gets through, even in cooldown", () => {  assert.equal(
    ambientChime({ ...base, text: "大肥魚你在嗎", lastSpokeAt: base.now - 1 }),
    true,
  );
});

test("short messages are ignored", () => {
  assert.equal(ambientChime({ ...base, text: "嗯" }), false);
  assert.equal(ambientChime({ ...base, text: "大肥魚你在嗎", base: 0 }), false);
});

test("cooldown suppresses her own recent replies", () => {
  const r = ambientChime({
    ...base,
    text: "這個好吃嗎",
    lastSpokeAt: base.now - 10_000,
  });
  assert.equal(r, false);
});

test("same message always decides the same way", () => {
  const input = { ...base, text: "今天吃什麼好呢" };
  const first = ambientChime(input);
  for (let i = 0; i < 20; i++) assert.equal(ambientChime(input), first);
});

test("questions are more likely to draw her in than statements", () => {
  const now = 10_000_000;
  let questions = 0;
  let statements = 0;
  for (let i = 0; i < 1200; i++) {
    if (ambientChime({ ...base, text: "今天要吃什麼", messageId: `q${i}`, now })) questions++;
    if (ambientChime({ ...base, text: "今天天氣真好", messageId: `s${i}`, now })) statements++;
  }
  assert.ok(questions > statements, `${questions} vs ${statements}`);
});

test("a human-to-human exchange is less likely to be interrupted", () => {
  const now = 10_000_000;
  let alone = 0;
  let midConversation = 0;
  for (let i = 0; i < 1200; i++) {
    if (ambientChime({ ...base, text: "今天天氣真好", messageId: `x${i}`, now })) alone++;
    if (
      ambientChime({
        ...base,
        text: "今天天氣真好",
        messageId: `x${i}`,
        now,
        prevAuthor: "someone-else",
      })
    ) {
      midConversation++;
    }
  }
  assert.ok(midConversation <= alone);
});
