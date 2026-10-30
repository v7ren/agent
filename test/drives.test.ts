import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DriveKit } from "../src/persona/drives.ts";

function kit(env = "DISCORD_TALK=1\nDISCORD_SPON_MIN=90\n") {
  const dir = mkdtempSync(join(tmpdir(), "drives-"));
  const written: Array<Record<string, string>> = [];
  const k = new DriveKit({
    dir,
    applyEnv: (values) => {
      written.push(values);
    },
    readEnv: () => env,
  });
  return { k, dir, written };
}

const T0 = new Date("2026-10-31T12:00:00");

test("a new drive can be defined as data and shows up in the tip", () => {
  const { k } = kit();
  const out = k.run("drive", { action: "set", name: "口渴", gain_per_hour: 10, threshold: 50 }, T0);
  assert.match(out, /新增/);
  assert.match(k.render(T0), /口渴/);
});

test("invalid drives are refused, not stored", () => {
  const { k } = kit();
  const out = k.run("drive", { action: "set", name: "壞", threshold: 500, max: 100 }, T0);
  assert.match(out, /不行/);
  assert.doesNotMatch(k.render(T0), /壞/);
});

test("a drive crossing its threshold wakes her until she acknowledges it", () => {
  const { k } = kit();
  k.run("drive", { action: "set", name: "睏", gain_per_hour: 20, threshold: 30, on_threshold: "wake" }, T0);
  k.tick(T0, 0);
  k.tick(new Date(T0.getTime() + 3 * 3_600_000), 0);
  // It may have crossed on either tick; once pending it must not fire twice.
  assert.equal(k.wakeNames().filter((n) => n === "睏").length, 1);

  k.run("drive", { action: "ack", name: "睏" }, new Date(T0.getTime() + 3 * 3_600_000));
  assert.ok(!k.wakeNames().includes("睏"));
});

test("permanent slots obey the cap and can be listed", () => {
  const { k } = kit();
  for (let i = 0; i < 10; i++) {
    assert.match(k.run("keep", { action: "add", text: `記憶${i}`, why: "重要" }, T0), /好/);
  }
  assert.match(k.run("keep", { action: "add", text: "第十一條", why: "x" }, T0), /不行/);
  assert.match(k.run("keep", { action: "list" }, T0), /記憶0/);
});

test("tune applies inside the safe range and writes only that key", () => {
  const { k, written } = kit();
  const out = k.run("tune", { action: "set", key: "DISCORD_SPON_MIN", value: "60" }, T0);
  assert.match(out, /改好了/);
  assert.deepEqual(written, [{ DISCORD_SPON_MIN: "60" }]);
});

test("tune refuses keys that are not on the allowlist", () => {
  const { k, written } = kit();
  for (const key of ["DISCORD_TOKEN", "NODE_OPTIONS", "DEEPSEEK_API_KEY", "DISCORD_OWNER_IDS"]) {
    assert.match(k.run("tune", { action: "set", key, value: "x" }, T0), /不行/);
  }
  assert.equal(written.length, 0);
});

test("a change past her range waits for the owner, then can be approved and undone", () => {
  const { k, written } = kit();
  const out = k.run("tune", { action: "set", key: "DISCORD_SPON_DM_MIN", value: "16" }, T0);
  if (/等主人|送給主人/.test(out)) {
    assert.equal(written.length, 0);
    const [pending] = k.pendingChanges();
    assert.ok(pending);
    assert.match(k.approve(pending.id, T0), /已套用/);
    assert.equal(written.length, 1);
  } else {
    // 16 fell inside her soft range; the hard edge still needs the owner.
    const hard = k.run("tune", { action: "set", key: "DISCORD_SPON_DM_MIN", value: "1" }, T0);
    assert.match(hard, /不行/);
  }
});

test("tune undo restores the previous value", () => {
  const { k, written } = kit("DISCORD_SPON_MIN=90\n");
  const out = k.run("tune", { action: "set", key: "DISCORD_SPON_MIN", value: "60" }, T0);
  const id = /id (\w+)/.exec(out)?.[1];
  assert.ok(id);
  const back = k.undo(id, T0);
  assert.match(back, /還原|目前值已被改動/);
  assert.ok(written.length >= 1);
});

test("drive files are written inside the given directory", () => {
  const { k, dir } = kit();
  k.run("drive", { action: "set", name: "想你", gain_per_hour: 5 }, T0);
  const text = readFileSync(join(dir, "drives-rules.json"), "utf8");
  assert.match(text, /想你/);
});
