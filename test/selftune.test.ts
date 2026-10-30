import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TUNABLE,
  appendLog,
  approveChange,
  loadLog,
  proposeChange,
  renderTuneState,
  saveLog,
  undoChange,
  type Change,
} from "../src/persona/selftune.ts";
import { envMap } from "../src/web/envfile.ts";

const NOW = new Date("2026-10-31T12:00:00.000Z");
const ENV = [
  "# persona tuning",
  "DISCORD_TALK=1",
  "DISCORD_BUDGET=4/30",
  "DISCORD_SPON_HUSH=off",
  "# secret-looking comment kept",
  "DISCORD_TOKEN=test-token-xyz",
  "",
].join("\n");

/** Runs a proposal, stores it in the log and returns the env text to use next. */
function run(env: string, log: Change[], key: string, value: string, by: "self" | "owner", at: Date = NOW) {
  const r = proposeChange(env, key, value, at, by, log);
  return { change: r.change, log: appendLog(log, r.change), env: r.newEnvText ?? env, newEnvText: r.newEnvText };
}

function oldSelf(key: string, hoursAgo: number): Change {
  return {
    id: `old-${key}-${hoursAgo}`,
    key,
    from: "1",
    to: "2",
    at: new Date(NOW.getTime() - hoursAgo * 3600_000).toISOString(),
    by: "self",
    status: "applied",
  };
}

test("allowlist is exactly the fourteen tunable keys", () => {
  assert.deepEqual(Object.keys(TUNABLE).sort(), [
    "DISCORD_AMBIENT_COOLDOWN",
    "DISCORD_ARM_MS",
    "DISCORD_BUDGET",
    "DISCORD_BURST_MIN",
    "DISCORD_SETTLE_MIN",
    "DISCORD_SPON_DM_MAX",
    "DISCORD_SPON_DM_MIN",
    "DISCORD_SPON_HUSH",
    "DISCORD_SPON_MAX",
    "DISCORD_SPON_MIN",
    "DISCORD_SPON_QUIET",
    "DISCORD_TALK",
    "FISHD_WHISPER_P",
    "JEV_THRESHOLD",
  ]);
  for (const spec of Object.values(TUNABLE)) {
    assert.ok(spec.softMin >= spec.min && spec.softMax <= spec.max, "soft band inside hard band");
  }
});

test("talk boundaries: hard range 0.3 to 2.5", () => {
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "0.3", NOW, "owner", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "2.5", NOW, "owner", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "0.29", NOW, "owner", []).change.status, "rejected");
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "2.51", NOW, "owner", []).change.status, "rejected");
});

test("self change inside soft band is applied and written", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "1.2", NOW, "self", []);
  assert.equal(r.change.status, "applied");
  assert.ok(r.newEnvText);
  assert.equal(envMap(r.newEnvText)["DISCORD_TALK"], "1.2");
});

test("self change between soft and hard is pending with no env write", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "0.4", NOW, "self", []);
  assert.equal(r.change.status, "pending");
  assert.equal(r.newEnvText, undefined);
});

test("self change outside hard range is rejected", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "9", NOW, "self", []);
  assert.equal(r.change.status, "rejected");
  assert.equal(r.newEnvText, undefined);
});

test("every numeric key: soft ends applied, hard ends pending, outside rejected", () => {
  for (const [key, spec] of Object.entries(TUNABLE)) {
    if (spec.kind !== "number") continue;
    const fmt = (n: number) => String(n);
    const soft = proposeChange(ENV, key, fmt(spec.softMin), NOW, "self", []).change;
    assert.equal(soft.status, "applied", `${key} softMin`);
    const softTop = proposeChange(ENV, key, fmt(spec.softMax), NOW, "self", []).change;
    assert.equal(softTop.status, "applied", `${key} softMax`);
    const hardLow = proposeChange(ENV, key, fmt(spec.min), NOW, "self", []).change;
    const hardHigh = proposeChange(ENV, key, fmt(spec.max), NOW, "self", []).change;
    if (spec.min < spec.softMin) assert.equal(hardLow.status, "pending", `${key} min`);
    if (spec.max > spec.softMax) assert.equal(hardHigh.status, "pending", `${key} max`);
    assert.equal(proposeChange(ENV, key, fmt(spec.min - 0.01), NOW, "owner", []).change.status, "rejected", `${key} below`);
    assert.equal(proposeChange(ENV, key, fmt(spec.max + 0.01), NOW, "owner", []).change.status, "rejected", `${key} above`);
  }
});

test("owner may set any hard-range value directly", () => {
  const r = proposeChange(ENV, "DISCORD_SPON_MIN", "1440", NOW, "owner", []);
  assert.equal(r.change.status, "applied");
  assert.equal(envMap(r.newEnvText ?? "")["DISCORD_SPON_MIN"], "1440");
});

test("budget format n/m with n 1-10 and m 10-120", () => {
  assert.equal(proposeChange(ENV, "DISCORD_BUDGET", "1/10", NOW, "owner", []).change.to, "1/10");
  assert.equal(proposeChange(ENV, "DISCORD_BUDGET", "10/120", NOW, "owner", []).change.status, "applied");
  for (const bad of ["0/30", "11/30", "4/9", "4/121", "4", "4/30/1", "a/30", "4-30"]) {
    assert.equal(proposeChange(ENV, "DISCORD_BUDGET", bad, NOW, "owner", []).change.status, "rejected", bad);
  }
  assert.equal(proposeChange(ENV, "DISCORD_BUDGET", "4/30", NOW, "self", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_BUDGET", "9/30", NOW, "self", []).change.status, "pending");
});

test("hush accepts off and H-H hours 0-23 only", () => {
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "off", NOW, "owner", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "23-7", NOW, "self", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "0-0", NOW, "self", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "24-1", NOW, "owner", []).change.status, "rejected");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "5-24", NOW, "owner", []).change.status, "rejected");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "-1-5", NOW, "owner", []).change.status, "rejected");
  // turning hush off needs the owner
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "off", NOW, "self", []).change.status, "pending");
});

test("non-allowlisted keys are always rejected", () => {
  for (const key of [
    "DISCORD_TOKEN",
    "NODE_OPTIONS",
    "DISCORD_REPLY_ALL",
    "DISCORD_SPONTANEOUS",
    "DISCORD_SPON_DM",
    "FISHD_MODEL",
    "DISCORD_OWNER_ID",
    "__proto__",
    "constructor",
  ]) {
    const r = proposeChange(ENV, key, "1", NOW, "owner", []);
    assert.equal(r.change.status, "rejected", key);
    assert.equal(r.newEnvText, undefined, key);
  }
});

test("newline injection is rejected and never reaches the env", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "1\nNODE_OPTIONS=--inspect", NOW, "owner", []);
  assert.equal(r.change.status, "rejected");
  assert.equal(r.newEnvText, undefined);
  assert.ok(!r.change.to.includes("\n"));

  const r2 = proposeChange(ENV, "DISCORD_TALK", "1\r\nX=1", NOW, "self", []);
  assert.equal(r2.change.status, "rejected");
  assert.equal(r2.newEnvText, undefined);
});

test("self applied changes are capped at 6 per rolling 24h", () => {
  let log: Change[] = [];
  let env = ENV;
  const keys = ["DISCORD_TALK", "DISCORD_AMBIENT_COOLDOWN", "DISCORD_BURST_MIN", "DISCORD_ARM_MS", "DISCORD_SETTLE_MIN", "DISCORD_SPON_MIN"];
  const values = ["1", "60", "10", "3000", "5", "100"];
  for (let i = 0; i < 6; i++) {
    const r = run(env, log, keys[i] ?? "", values[i] ?? "", "self");
    assert.equal(r.change.status, "applied", keys[i]);
    log = r.log;
    env = r.env;
  }
  const seventh = run(env, log, "DISCORD_SPON_QUIET", "20", "self");
  assert.equal(seventh.change.status, "rejected");
  assert.equal(seventh.newEnvText, undefined);
  // owner is not limited
  assert.equal(run(env, log, "DISCORD_SPON_QUIET", "20", "owner").change.status, "applied");
});

test("same key at most 2 self changes per rolling 24h", () => {
  const first = run(ENV, [], "DISCORD_TALK", "1.1", "self");
  const second = run(first.env, first.log, "DISCORD_TALK", "1.2", "self");
  assert.equal(second.change.status, "applied");
  const third = run(second.env, second.log, "DISCORD_TALK", "1.3", "self");
  assert.equal(third.change.status, "rejected");
  assert.match(third.change.reason ?? "", /同一設定/);
});

test("rate window ignores changes older than 24h", () => {
  const log: Change[] = [1, 2, 3, 4, 5, 6].map((h) => oldSelf(`DISCORD_ARM_MS`, 25 + h));
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "1.1", NOW, "self", log).change.status, "applied");
  const recent: Change[] = [1, 2, 3, 4, 5, 6].map((h) => oldSelf("DISCORD_SPON_QUIET", h));
  assert.equal(proposeChange(ENV, "DISCORD_TALK", "1.1", NOW, "self", recent).change.status, "rejected");
});

test("pending change is applied only when the owner approves", () => {
  const p = run(ENV, [], "DISCORD_TALK", "0.4", "self");
  assert.equal(p.change.status, "pending");
  assert.equal(p.newEnvText, undefined);

  const approved = approveChange(ENV, p.log, p.change.id, NOW);
  assert.equal(approved.change?.status, "applied");
  assert.equal(envMap(approved.newEnvText ?? "")["DISCORD_TALK"], "0.4");

  const again = approveChange(approved.newEnvText ?? ENV, appendLog(p.log, approved.change!), p.change.id, NOW);
  assert.deepEqual(again, {});
  assert.deepEqual(approveChange(ENV, p.log, "missing", NOW), {});
});

test("undo restores from when the value still matches", () => {
  const a = run(ENV, [], "DISCORD_TALK", "1.4", "self");
  assert.equal(envMap(a.env)["DISCORD_TALK"], "1.4");
  const u = undoChange(a.env, a.log, a.change.id, NOW);
  assert.equal(u.change?.status, "undone");
  assert.equal(envMap(u.newEnvText ?? "")["DISCORD_TALK"], "1");
});

test("undo leaves the file alone when the value was changed by hand", () => {
  const a = run(ENV, [], "DISCORD_TALK", "1.4", "self");
  const edited = a.env.replace("DISCORD_TALK=1.4", "DISCORD_TALK=2");
  const u = undoChange(edited, a.log, a.change.id, NOW);
  assert.equal(u.newEnvText, undefined);
  assert.equal(u.change?.status, "applied");
});

test("upsert keeps comments, unknown keys and token line", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "1.3", NOW, "self", []);
  const text = r.newEnvText ?? "";
  assert.ok(text.includes("# persona tuning"));
  assert.ok(text.includes("# secret-looking comment kept"));
  assert.equal(envMap(text)["DISCORD_TOKEN"], "test-token-xyz");
  assert.equal(envMap(text)["DISCORD_BUDGET"], "4/30");
});

test("appendLog replaces by id and caps at 200", () => {
  const r = proposeChange(ENV, "DISCORD_TALK", "0.4", NOW, "self", []);
  const once = appendLog([], r.change);
  const updated = appendLog(once, { ...r.change, status: "rejected" });
  assert.equal(updated.length, 1);
  assert.equal(updated[0]?.status, "rejected");

  let log: Change[] = [];
  for (let i = 0; i < 250; i++) log = appendLog(log, { ...r.change, id: `id-${i}` });
  assert.equal(log.length, 200);
  assert.equal(log[0]?.id, "id-50");
});

test("loadLog tolerates missing and corrupt files", () => {
  const dir = mkdtempSync(join(tmpdir(), "selftune-"));
  try {
    assert.deepEqual(loadLog(join(dir, "none.json")), []);
    const bad = join(dir, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(loadLog(bad), []);
    const wrong = join(dir, "wrong.json");
    writeFileSync(wrong, JSON.stringify({ hello: 1 }));
    assert.deepEqual(loadLog(wrong), []);
    const mixed = join(dir, "mixed.json");
    writeFileSync(mixed, JSON.stringify([oldSelf("DISCORD_TALK", 1), { id: 5 }]));
    assert.equal(loadLog(mixed).length, 1);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("saveLog then loadLog round-trips", () => {
  const dir = mkdtempSync(join(tmpdir(), "selftune-"));
  try {
    const path = join(dir, "sub", "log.json");
    const log = [oldSelf("DISCORD_TALK", 1)];
    saveLog(path, log);
    assert.deepEqual(loadLog(path), log);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderTuneState summarises recent and pending changes", () => {
  assert.equal(renderTuneState([], NOW), "尚無自行調整紀錄。");
  const p = run(ENV, [], "DISCORD_TALK", "0.4", "self");
  const applied = run(ENV, p.log, "DISCORD_ARM_MS", "3000", "self");
  const text = renderTuneState(applied.log, NOW);
  assert.match(text, /近 24 小時自行調整：1\/6/);
  assert.match(text, /待主人同意/);
  assert.match(text, /DISCORD_TALK/);
  assert.match(text, /已套用/);
});

test("env reads use own properties only, so inherited names give an empty 'from'", () => {
  for (const key of ["constructor", "toString", "__proto__"]) {
    const r = proposeChange(ENV, key, "1", NOW, "owner", []);
    assert.equal(r.change.status, "rejected", key);
    assert.equal(r.change.from, "", key);
  }
});

test("hush windows wider than 10 hours need the owner; 10 hours or less are free", () => {
  const wide = proposeChange(ENV, "DISCORD_SPON_HUSH", "0-23", NOW, "self", []);
  assert.equal(wide.change.status, "pending");
  assert.equal(wide.newEnvText, undefined);

  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "1-11", NOW, "self", []).change.status, "applied");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "1-12", NOW, "self", []).change.status, "pending");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "10-0", NOW, "self", []).change.status, "pending");
  assert.equal(proposeChange(ENV, "DISCORD_SPON_HUSH", "0-23", NOW, "owner", []).change.status, "applied");
});
