import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  conversationEnd,
  markAlive,
  markStart,
  markStop,
  renderOffline,
} from "../src/persona/presence.ts";

const MIN = 60_000;

test("first start has no offline info and writes a running file", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-presence-"));
  try {
    const { offline } = markStart(root, new Date(2026, 9, 31, 9, 0));
    assert.equal(offline, null);
    const file = JSON.parse(readFileSync(join(root, "presence.json"), "utf8"));
    assert.equal(file.running, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a short blip under three minutes is ignored", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-presence-"));
  try {
    const t0 = new Date(2026, 9, 31, 9, 0);
    markStart(root, t0);
    markAlive(root, new Date(t0.getTime() + MIN));
    const { offline } = markStart(root, new Date(t0.getTime() + 2 * MIN));
    assert.equal(offline, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a stopped run reports a clean gap, a crashed run an unclean one", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-presence-"));
  try {
    const t0 = new Date(2026, 9, 31, 1, 20);
    markStart(root, t0);
    markStop(root, new Date(t0.getTime() + 10 * MIN));
    const clean = markStart(root, new Date(t0.getTime() + 100 * MIN)).offline;
    assert.equal(clean?.clean, true);
    assert.equal(clean?.minutes, 90);

    markAlive(root, new Date(t0.getTime() + 105 * MIN));
    const unclean = markStart(root, new Date(t0.getTime() + 160 * MIN)).offline;
    assert.equal(unclean?.clean, false);
    assert.equal(unclean?.minutes, 55);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a corrupt presence file is treated as no history", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-presence-"));
  try {
    writeFileSync(join(root, "presence.json"), "{not json");
    const { offline } = markStart(root, new Date(2026, 9, 31, 9, 0));
    assert.equal(offline, null);
    const file = JSON.parse(readFileSync(join(root, "presence.json"), "utf8"));
    assert.equal(file.running, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("renderOffline shows the date only when the day differs and uses hours past 120 minutes", () => {
  const now = new Date(2026, 9, 31, 0, 35);
  const sameDay = renderOffline(
    {
      from: new Date(2026, 9, 30, 23, 10).toISOString(),
      to: new Date(2026, 9, 31, 0, 30).toISOString(),
      minutes: 80,
      clean: true,
    },
    now,
  );
  assert.ok(sameDay.includes("10/30 23:10"), sameDay);
  assert.ok(sameDay.includes("到 00:30"), sameDay);
  assert.ok(sameDay.includes("80 分鐘"), sameDay);
  assert.ok(sameDay.includes("正常關機"), sameDay);

  const long = renderOffline(
    {
      from: new Date(2026, 9, 30, 20, 0).toISOString(),
      to: new Date(2026, 9, 31, 0, 30).toISOString(),
      minutes: 210,
      clean: false,
    },
    now,
  );
  assert.ok(long.includes("3.5 小時"), long);
  assert.ok(long.includes("突然中斷"), long);

  assert.equal(renderOffline(null, now), "");
});

test("conversationEnd distinguishes a goodbye from a silent ending", () => {
  const now = new Date(2026, 9, 31, 9, 0);
  assert.equal(
    conversationEnd({ gapMinutes: 10, lastUserText: "晚安", lastBotText: "好", now }),
    "",
  );

  const bye = conversationEnd({ gapMinutes: 90, lastUserText: "晚安喔", lastBotText: "好", now });
  assert.ok(bye.includes("先離開"), bye);

  const silent = conversationEnd({
    gapMinutes: 240,
    lastUserText: "今天好累",
    lastBotText: "那你要好好休息喔，我等你回來",
    now,
  });
  assert.ok(silent.includes("那你要好好休息喔，我等你"), silent);
  assert.ok(!silent.includes("回來"), silent);
  assert.ok(silent.includes("4 小時"), silent);
});

test("an unwritable directory never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-presence-"));
  try {
    writeFileSync(join(root, "blocker"), "x");
    mkdirSync(join(root, "ok"));
    const dir = join(root, "blocker", "sub");
    const now = new Date(2026, 9, 31, 9, 0);
    assert.doesNotThrow(() => markAlive(dir, now));
    assert.doesNotThrow(() => markStop(dir, now));
    const { offline } = markStart(dir, now);
    assert.equal(offline, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
