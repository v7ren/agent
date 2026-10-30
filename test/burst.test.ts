import { test } from "node:test";
import assert from "node:assert/strict";
import {
  inSettle,
  parseBudget,
  takeBudget,
  trimBurst,
} from "../src/channels/burst.ts";
import type { BurstItem } from "../src/channels/burst.ts";

const item = (id: string, at: number): BurstItem => ({
  id,
  author: "ren",
  authorId: "1",
  text: id,
  at,
  where: "#bot",
});

test("trimBurst keeps the newest within the window and the cap", () => {
  const now = 1_000_000;
  const items = [
    item("old", now - 700_000),
    item("a", now - 5000),
    item("b", now - 4000),
    item("c", now - 3000),
  ];

  const kept = trimBurst(items, now, 600_000, 2);
  assert.deepEqual(kept.map((i) => i.id), ["b", "c"]);
});

test("the whole rant stays in view, not just the last line", () => {
  const now = 1_000_000;
  const rant = Array.from({ length: 8 }, (_, i) => item(`m${i}`, now - (8 - i) * 40_000));
  const kept = trimBurst(rant, now, 600_000, 12);
  assert.equal(kept.length, 8);
});

test("budget blocks the fifth interjection in the window", () => {
  const now = 1_000_000;
  let stamps: number[] = [];

  for (let i = 0; i < 4; i++) {
    const result = takeBudget(stamps, now - i * 1000, 4, 30 * 60_000);
    assert.equal(result.ok, true);
    stamps = result.stamps;
  }

  const blocked = takeBudget(stamps, now, 4, 30 * 60_000);
  assert.equal(blocked.ok, false);
});

test("budget refills after the window", () => {
  const now = 2_000_000_000;
  const result = takeBudget([now - 31 * 60_000, now - 30 * 60_000], now, 4, 30 * 60_000);
  assert.equal(result.ok, true);
  assert.equal(result.stamps.length, 1);
});

test("settle window suppresses her", () => {
  assert.equal(inSettle(1000, 2000), true);
  assert.equal(inSettle(2000, 2000), false);
});

test("budget string parses, and bad input falls back", () => {
  assert.deepEqual(parseBudget("4/30"), { max: 4, minutes: 30 });
  assert.deepEqual(parseBudget(" 2 / 10 "), { max: 2, minutes: 10 });
  assert.deepEqual(parseBudget("nonsense"), { max: 4, minutes: 30 });
});
