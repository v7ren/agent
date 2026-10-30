import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readLiveSettings } from "../src/live.ts";
import { reloadEnv } from "../src/env.ts";

function withEnv(overrides: Record<string, string>, run: () => void): void {
  const saved = new Map<string, string | undefined>();
  for (const key of Object.keys(overrides)) {
    saved.set(key, process.env[key]);
    process.env[key] = overrides[key];
  }

  try {
    run();
  } finally {
    for (const [key, value] of saved) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

test("live settings read the tuning knobs", () => {
  withEnv(
    {
      DISCORD_TALK: "2",
      DISCORD_AMBIENT_COOLDOWN: "90",
      DISCORD_BURST_MIN: "20",
      DISCORD_ARM_MS: "5000",
      DISCORD_SETTLE_MIN: "5",
      DISCORD_BUDGET: "6/60",
      DISCORD_SPONTANEOUS: "1",
      JEV_THRESHOLD: "0.4",
    },
    () => {
      const settings = readLiveSettings();
      assert.equal(settings.talk, 2);
      assert.equal(settings.ambientCooldown, 90);
      assert.equal(settings.burstMs, 20 * 60_000);
      assert.equal(settings.armMs, 5000);
      assert.equal(settings.settleMinutes, 5);
      assert.deepEqual(settings.budget, { max: 6, minutes: 60 });
      assert.equal(settings.spontaneous, true);
      assert.equal(settings.jevThreshold, 0.4);
    },
  );
});

test("garbage values fall back instead of becoming zero", () => {
  withEnv(
    {
      DISCORD_TALK: "",
      DISCORD_ARM_MS: "abc",
      DISCORD_SETTLE_MIN: "-5",
      DISCORD_BUDGET: "nonsense",
    },
    () => {
      const settings = readLiveSettings();
      assert.equal(settings.talk, 1);
      assert.equal(settings.armMs, 3000);
      assert.equal(settings.settleMinutes, 3);
      assert.deepEqual(settings.budget, { max: 4, minutes: 30 });
    },
  );
});

test("editing the file updates the environment without a restart", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishd-env-"));
  const file = join(dir, ".env");

  try {
    writeFileSync(file, "DISCORD_TALK=2\n", "utf8");
    assert.equal(reloadEnv(file), true);
    assert.equal(process.env["DISCORD_TALK"], "2");

    writeFileSync(file, "DISCORD_TALK=3\n", "utf8");
    assert.equal(reloadEnv(file), true);
    assert.equal(process.env["DISCORD_TALK"], "3");

    // unchanged bytes: no work, no change
    assert.equal(reloadEnv(file), false);
    assert.equal(process.env["DISCORD_TALK"], "3");
  } finally {
    delete process.env["DISCORD_TALK"];
    rmSync(dir, { recursive: true, force: true });
  }
});
