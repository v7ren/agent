import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  MAX_RULES,
  acknowledgeWake,
  defaultRules,
  emptyState,
  loadRules,
  loadState,
  parseRules,
  renderStats,
  saveState,
  tickStats,
} from "../src/persona/stats.ts";
import type { StatRule, StatsState } from "../src/persona/stats.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m, 0, 0);

function rule(over: Partial<StatRule> = {}): StatRule {
  return {
    name: "想你",
    startValue: 0,
    gainPerHour: 10,
    max: 100,
    threshold: 50,
    onThreshold: "wake",
    recordPeak: false,
    ...over,
  };
}

function stateAt(now: Date, values: Record<string, number> = {}, extra: Partial<StatsState> = {}): StatsState {
  return { values, peaks: {}, lastTickAt: now.toISOString(), pendingWake: [], ...extra };
}

test("parseRules accepts valid rules and defaults optional fields", () => {
  const { rules, errors } = parseRules([
    { name: "餓", startValue: 5, gainPerHour: 3, max: 50, threshold: 40, onThreshold: "reset" },
  ]);
  assert.deepEqual(errors, []);
  assert.equal(rules.length, 1);
  assert.equal(rules[0]?.recordPeak, false);
  assert.equal(rules[0]?.quietHoursGain, undefined);
});

test("parseRules never throws on non-array input", () => {
  for (const raw of [null, undefined, 42, "x", {}]) {
    const r = parseRules(raw);
    assert.deepEqual(r.rules, []);
    assert.equal(r.errors.length, 1);
  }
});

test("parseRules enforces the rule count limit", () => {
  const many = Array.from({ length: MAX_RULES + 3 }, (_, i) => rule({ name: `s${i}` }));
  const { rules, errors } = parseRules(many);
  assert.equal(rules.length, MAX_RULES);
  assert.equal(errors.length, 3);
});

test("parseRules enforces name rules", () => {
  const bad = ["", "a".repeat(21), "bad!name", "dot.name"];
  for (const name of bad) {
    const { rules, errors } = parseRules([rule({ name })]);
    assert.equal(rules.length, 0, `name ${JSON.stringify(name)} should be rejected`);
    assert.equal(errors.length, 1);
  }
  const ok = parseRules([rule({ name: "a".repeat(20) }), rule({ name: "想被 摸_1-2" })]);
  assert.equal(ok.rules.length, 2);
});

test("parseRules rejects duplicate names after the first", () => {
  const { rules, errors } = parseRules([rule({ name: "餓" }), rule({ name: "餓", gainPerHour: 1 })]);
  assert.equal(rules.length, 1);
  assert.equal(errors.length, 1);
});

test("parseRules clamps gainPerHour to +-200", () => {
  const { rules } = parseRules([rule({ gainPerHour: 500 }), rule({ name: "b", gainPerHour: -999 })]);
  assert.equal(rules[0]?.gainPerHour, 200);
  assert.equal(rules[1]?.gainPerHour, -200);
});

test("parseRules enforces threshold in (0, max] and max in (0, 1000]", () => {
  assert.equal(parseRules([rule({ threshold: 0 })]).rules.length, 0);
  assert.equal(parseRules([rule({ threshold: 101 })]).rules.length, 0);
  assert.equal(parseRules([rule({ threshold: 100 })]).rules.length, 1);
  assert.equal(parseRules([rule({ max: 0 })]).rules.length, 0);
  assert.equal(parseRules([rule({ max: 1001, threshold: 1 })]).rules.length, 0);
  assert.equal(parseRules([rule({ max: 1000, threshold: 1 })]).rules.length, 1);
});

test("parseRules rejects bad enums, types and quiet multiplier", () => {
  const cases: unknown[] = [
    { ...rule(), onThreshold: "explode" },
    { ...rule(), recordPeak: "yes" },
    { ...rule(), quietHoursGain: 1.5 },
    { ...rule(), quietHoursGain: -0.1 },
    { ...rule(), startValue: Number.NaN },
    { ...rule(), gainPerHour: "10" },
    null,
    [],
  ];
  const { rules, errors } = parseRules(cases);
  assert.equal(rules.length, 0);
  assert.equal(errors.length, cases.length);
});

test("tick adds gain per elapsed hour and clamps to [0, max]", () => {
  const start = at(12);
  const r = [rule({ gainPerHour: 10, max: 100, threshold: 90 })];
  const s = stateAt(start, { 想你: 0 });
  const next = tickStats(s, r, at(13), { userMessages: 0 });
  assert.equal(next.state.values["想你"], 10);
  assert.equal(next.state.lastTickAt, at(13).toISOString());

  const capped = tickStats(stateAt(start, { 想你: 95 }), [rule({ gainPerHour: 50, max: 100, threshold: 99 })], at(13), {
    userMessages: 0,
  });
  assert.equal(capped.state.values["想你"], 100);
});

test("tick applies negative gainPerHour but never below zero", () => {
  const r = [rule({ gainPerHour: -50, threshold: 90 })];
  const out = tickStats(stateAt(at(12), { 想你: 10 }), r, at(14), { userMessages: 0 });
  assert.equal(out.state.values["想你"], 0);
});

test("tick applies gainOnUserMessage per message, including negatives", () => {
  const r = [rule({ gainPerHour: 0, gainOnUserMessage: -10, threshold: 90 })];
  const out = tickStats(stateAt(at(12), { 想你: 50 }), r, at(12), { userMessages: 3 });
  assert.equal(out.state.values["想你"], 20);
  const clamped = tickStats(stateAt(at(12), { 想你: 5 }), r, at(12), { userMessages: 3 });
  assert.equal(clamped.state.values["想你"], 0);
});

test("elapsed time is capped at 48 hours", () => {
  const r = [rule({ gainPerHour: 1, max: 1000, threshold: 1000 })];
  const start = at(0);
  const later = new Date(start.getTime() + 100 * 3_600_000);
  const out = tickStats(stateAt(start), r, later, { userMessages: 0 });
  assert.equal(out.state.values["想你"], 48);
  assert.equal(out.state.lastTickAt, later.toISOString());
});

test("a clock that went backwards adds no gain", () => {
  const r = [rule({ gainPerHour: 10, threshold: 90 })];
  const out = tickStats(stateAt(at(12), { 想你: 5 }), r, at(11), { userMessages: 0 });
  assert.equal(out.state.values["想你"], 5);
});

test("wake threshold keeps the value and reports once", () => {
  const r = [rule({ onThreshold: "wake", threshold: 50, gainPerHour: 10, max: 100 })];
  const first = tickStats(stateAt(at(12), { 想你: 45 }), r, at(13), { userMessages: 0 });
  assert.deepEqual(first.woke, ["想你"]);
  assert.equal(first.state.values["想你"], 55);
  assert.deepEqual(first.state.pendingWake, ["想你"]);
});

test("a pending wake does not re-fire until acknowledged", () => {
  const r = [rule({ onThreshold: "wake", threshold: 50, gainPerHour: 10, max: 100 })];
  const first = tickStats(stateAt(at(12), { 想你: 45 }), r, at(13), { userMessages: 0 });
  const second = tickStats(first.state, r, at(14), { userMessages: 0 });
  assert.deepEqual(second.woke, []);
  assert.deepEqual(second.state.pendingWake, ["想你"]);

  const acked = acknowledgeWake(second.state, ["想你"], r);
  assert.deepEqual(acked.pendingWake, []);
  const third = tickStats(acked, r, at(15), { userMessages: 0 });
  assert.deepEqual(third.woke, ["想你"]);
});

test("reset threshold sets the value to zero", () => {
  const r = [rule({ name: "餓", onThreshold: "reset", threshold: 40, gainPerHour: 0, max: 50 })];
  const out = tickStats(stateAt(at(12), { 餓: 45 }), r, at(12), { userMessages: 0 });
  assert.deepEqual(out.woke, ["餓"]);
  assert.equal(out.state.values["餓"], 0);
  assert.deepEqual(out.state.pendingWake, []);
});

test("halve threshold halves the value", () => {
  const r = [rule({ name: "想被摸", onThreshold: "halve", threshold: 50, gainPerHour: 0, max: 60 })];
  const out = tickStats(stateAt(at(12), { 想被摸: 50 }), r, at(12), { userMessages: 0 });
  assert.deepEqual(out.woke, ["想被摸"]);
  assert.equal(out.state.values["想被摸"], 25);
});

test("below threshold nothing fires", () => {
  const r = [rule({ threshold: 50, gainPerHour: 0 })];
  const out = tickStats(stateAt(at(12), { 想你: 49 }), r, at(12), { userMessages: 0 });
  assert.deepEqual(out.woke, []);
});

test("peaks record the highest value and its time when recordPeak is set", () => {
  const r = [rule({ recordPeak: true, threshold: 100, gainPerHour: 10, max: 100 })];
  const up = tickStats(stateAt(at(12), { 想你: 20 }), r, at(13), { userMessages: 0 });
  assert.deepEqual(up.state.peaks["想你"], { value: 30, at: at(13).toISOString() });

  const down = tickStats(up.state, [rule({ recordPeak: true, threshold: 100, gainPerHour: -10 })], at(14), {
    userMessages: 0,
  });
  assert.equal(down.state.values["想你"], 20);
  assert.deepEqual(down.state.peaks["想你"], { value: 30, at: at(13).toISOString() });
});

test("peak is captured before a reset clears the value", () => {
  const r = [rule({ name: "餓", recordPeak: true, onThreshold: "reset", threshold: 40, gainPerHour: 0, max: 50 })];
  const out = tickStats(stateAt(at(12), { 餓: 44 }), r, at(12), { userMessages: 0 });
  assert.equal(out.state.values["餓"], 0);
  assert.equal(out.state.peaks["餓"]?.value, 44);
});

test("acknowledgeWake clears only the named entries", () => {
  const s: StatsState = {
    values: { a: 1, b: 2 },
    peaks: {},
    lastTickAt: at(12).toISOString(),
    pendingWake: ["a", "b"],
  };
  const out = acknowledgeWake(s, ["a"]);
  assert.deepEqual(out.pendingWake, ["b"]);
  assert.deepEqual(out.values, { a: 1, b: 2 });
});

test("quiet-hours multiplier scales gain between 01:00 and 06:00 local", () => {
  const r = [rule({ gainPerHour: 10, quietHoursGain: 0.5, threshold: 100, max: 100 })];
  // 00:00 to 02:00: 00-01 is normal (10), 01-02 is quiet (5)
  const out = tickStats(stateAt(at(0)), r, at(2), { userMessages: 0 });
  assert.equal(out.state.values["想你"], 15);

  // entirely in the day: no reduction
  const day = tickStats(stateAt(at(12)), r, at(14), { userMessages: 0 });
  assert.equal(day.state.values["想你"], 20);

  // quietHoursGain 0 freezes the drive overnight
  const frozen = tickStats(stateAt(at(1)), [rule({ gainPerHour: 10, quietHoursGain: 0, threshold: 100 })], at(5, 59), {
    userMessages: 0,
  });
  assert.ok(Math.abs((frozen.state.values["想你"] ?? 0)) < 1e-9);
});

test("emptyState uses start values and empty collections", () => {
  const s = emptyState(defaultRules(), at(9));
  assert.equal(s.values["餓"], 10);
  assert.deepEqual(s.peaks, {});
  assert.deepEqual(s.pendingWake, []);
  assert.equal(s.lastTickAt, at(9).toISOString());
});

test("renderStats produces one compact line and empty string without rules", () => {
  const s: StatsState = {
    values: { 想你: 62.4, 餓: 12 },
    peaks: {},
    lastTickAt: at(9).toISOString(),
    pendingWake: [],
  };
  const r = [rule({ name: "想你", max: 80, threshold: 70 }), rule({ name: "餓", max: 50, threshold: 40 })];
  assert.equal(renderStats(s, r), "（你的數值：想你 62/80；餓 12/50）");
  assert.equal(renderStats(s, []), "");
});

test("defaultRules are valid and survive parseRules", () => {
  const d = defaultRules();
  const { rules, errors } = parseRules(d);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    rules.map((r) => r.name),
    ["想你", "餓", "想被摸"],
  );
});

test("save and load round-trip, leaving no temp files behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-test-"));
  const file = join(dir, "sub", "stats.json");
  const s = emptyState(defaultRules(), at(9));
  saveState(file, s);
  assert.deepEqual(loadState(file), s);
  assert.deepEqual(
    readdirSync(join(dir, "sub")).filter((f) => f.endsWith(".tmp")),
    [],
  );
});

test("corrupt files fall back to defaults", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-corrupt-"));
  const bad = join(dir, "bad.json");
  writeFileSync(bad, "{not json", "utf8");
  assert.deepEqual(loadRules(bad).map((r) => r.name), defaultRules().map((r) => r.name));
  const st = loadState(bad);
  assert.deepEqual(st.values, {});
  assert.deepEqual(st.pendingWake, []);

  const missing = join(dir, "missing.json");
  assert.equal(loadRules(missing).length, 3);
  assert.deepEqual(loadState(missing).values, {});
});

test("loadState drops malformed fields but keeps good ones", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-partial-"));
  const file = join(dir, "partial.json");
  writeFileSync(
    file,
    JSON.stringify({ values: { a: 3, b: "x" }, peaks: { a: { value: 3, at: "t" }, c: 1 }, lastTickAt: "nope", pendingWake: ["a", 2] }),
    "utf8",
  );
  const st = loadState(file);
  assert.deepEqual(st.values, { a: 3 });
  assert.deepEqual(st.peaks, { a: { value: 3, at: "t" } });
  assert.deepEqual(st.pendingWake, ["a"]);
  assert.ok(Number.isFinite(Date.parse(st.lastTickAt)));
});

test("parseRules rejects names that exist on every object", () => {
  const names = ["__proto__", "constructor", "prototype", "toString", "hasOwnProperty"];
  for (const name of names) {
    const { rules, errors } = parseRules([rule({ name })]);
    assert.equal(rules.length, 0, name);
    assert.equal(errors.length, 1, name);
    assert.match(errors[0] ?? "", /reserved/, name);
  }
});

test("loadState drops reserved keys and never reads inherited values", () => {
  const dir = mkdtempSync(join(tmpdir(), "stats-reserved-"));
  try {
    const file = join(dir, "reserved.json");
    writeFileSync(
      file,
      '{"values":{"__proto__":5,"constructor":2,"想你":3},"peaks":{"toString":{"value":1,"at":"t"},"餓":{"value":2,"at":"t"}}}',
      "utf8",
    );
    const st = loadState(file);
    assert.deepEqual(st.values, { 想你: 3 });
    assert.equal(Object.getPrototypeOf(st.values), Object.prototype);
    assert.deepEqual(st.peaks, { 餓: { value: 2, at: "t" } });
    assert.equal(Object.getPrototypeOf(st.peaks), Object.prototype);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("renderStats and tickStats use the start value, not inherited members", () => {
  const r = [rule({ name: "想你", startValue: 7, max: 80, threshold: 70, gainPerHour: 0 })];
  const s = stateAt(at(12), {});
  assert.equal(renderStats(s, r), "（你的數值：想你 7/80）");
  const out = tickStats(s, r, at(12), { userMessages: 0 });
  assert.equal(out.state.values["想你"], 7);
});
