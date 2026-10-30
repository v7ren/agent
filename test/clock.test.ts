import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { pulse } from "../src/persona/clock.ts";
import { initialMood } from "../src/persona/mood.ts";
import { loadMood, loadSelf, saveMood, saveSelf } from "../src/persona/persona.ts";
import { emptySelf } from "../src/persona/self.ts";

test("one beat creates the body files and a later beat advances them", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-clock-"));
  try {
    const start = new Date("2026-10-30T12:00:00Z");
    const first = pulse(root, start);
    assert.equal(first.self.lastTick, start.toISOString());

    const later = pulse(root, new Date(start.getTime() + 60_000));
    assert.ok(later.self.longing > 0, `${later.self.longing}`);
    assert.notEqual(later.mood.energy, first.mood.energy);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a chosen sleep actually restores energy", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-clock-"));
  try {
    const start = new Date("2026-10-30T12:00:00Z");
    saveMood(root, { ...initialMood(start), energy: 30 });
    saveSelf(root, {
      ...emptySelf(),
      sleeping: true,
      sleepUntil: new Date(start.getTime() + 8 * 3_600_000).toISOString(),
      lastSeen: new Date(start.getTime() - 3_600_000).toISOString(),
      lastTick: start.toISOString(),
    });

    const after = pulse(root, new Date(start.getTime() + 3_600_000));
    assert.ok(after.mood.energy > 30, `${after.mood.energy}`);
    assert.equal(after.self.sleeping, true);

    const reloaded = loadMood(root);
    assert.ok(reloaded.energy > 30, `${reloaded.energy}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("the heartbeat keeps growing longing while nobody talks", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-clock-"));
  try {
    const start = new Date("2026-10-30T12:00:00Z");
    const self = {
      ...emptySelf(),
      lastSeen: new Date(start.getTime() - 60 * 60_000).toISOString(),
      lastTick: start.toISOString(),
    };
    saveSelf(root, self);

    pulse(root, new Date(start.getTime() + 60_000));
    const after = loadSelf(root);
    assert.ok(after.longing > 0, `${after.longing}`);
    assert.ok(after.longing < 1, `${after.longing}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
