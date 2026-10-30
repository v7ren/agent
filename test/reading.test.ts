import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadPace,
  paceAdd,
  paceHint,
  savePace,
  toneHint,
  type PacePoint,
  type PaceState,
} from "../src/persona/reading.ts";

const plain = (state: PaceState) => JSON.parse(JSON.stringify(state)) as PaceState;
const empty = (): PaceState => ({ people: Object.create(null) });

function points(n: number, length = 10, latencyMs = 1000): PacePoint[] {
  return Array.from({ length: n }, (_, i) => ({
    at: new Date(Date.UTC(2026, 9, 1, 0, i)).toISOString(),
    latencyMs,
    length,
  }));
}

function stateWith(id: string, list: PacePoint[]): PaceState {
  return { people: { [id]: list } };
}

test("tone: empty and neutral text give no hint", () => {
  assert.equal(toneHint(""), "");
  assert.equal(toneHint("   "), "");
  assert.equal(toneHint("今天去吃拉麵好不好呀"), "");
});

test("tone: each signal maps to a guess that contains 猜 and stays short", () => {
  const cases: [string, string][] = [
    ["好耶!!", "很開心"],
    ["哈哈哈", "很開心"],
    ["笑死www", "很開心"],
    ["真的假的？？", "疑惑或不耐"],
    ["WHAT IS THIS", "可能在生氣或煩躁"],
    ["幹，又來", "可能在生氣或煩躁"],
    ["好吧 💀", "誇張的情緒"],
    ["我要睡了😭", "誇張的情緒"],
    ["好啦~", "輕鬆撒嬌"],
    ["喔～", "輕鬆撒嬌"],
    ["...", "冷淡或在想"],
    ["嗯", "冷淡或在想"],
    ["哦", "冷淡或在想"],
    ["好", "冷淡或在想"],
  ];
  for (const [text, word] of cases) {
    const hint = toneHint(text);
    assert.ok(hint.includes(word), `${text} -> ${hint}`);
    assert.ok(hint.includes("猜"), hint);
    assert.ok([...hint].length <= 60, hint);
    assert.ok(hint.startsWith("（") && hint.endsWith("）"), hint);
  }
});

test("tone: the strongest signal wins when several appear", () => {
  assert.ok(toneHint("哈哈哈 幹").includes("生氣"));
  assert.ok(toneHint("哈哈？？").includes("疑惑"));
});

test("tone: ALL CAPS needs letters and no lowercase", () => {
  assert.ok(!toneHint("OK").includes("生氣"));
  assert.ok(toneHint("NO WAY").includes("生氣"));
  assert.equal(toneHint("No way"), "");
});

test("pace: no hint with fewer than six earlier points", () => {
  const now = new Date(2026, 9, 31, 12, 0);
  const latest = { at: now.toISOString(), latencyMs: 9999, length: 1 };
  assert.equal(paceHint(stateWith("a", points(5)), "a", latest, now), "");
  assert.equal(paceHint(empty(), "a", latest, now), "");
});

test("pace: much shorter or much slower than median gives a tired-or-busy guess", () => {
  const now = new Date(2026, 9, 31, 14, 0);
  const state = stateWith("a", points(8, 100, 1000));
  const short = paceHint(state, "a", { at: "x", latencyMs: 1000, length: 20 }, now);
  assert.ok(short.includes("猜") && short.includes("累了或在忙"), short);
  assert.ok(!short.includes("這麼晚"), short);
  const slow = paceHint(state, "a", { at: "x", latencyMs: 3500, length: 100 }, now);
  assert.ok(slow.includes("猜"), slow);
});

test("pace: late night local hour is mentioned", () => {
  const state = stateWith("a", points(8, 100, 1000));
  const late = new Date(2026, 9, 31, 2, 30);
  const hint = paceHint(state, "a", { at: "x", latencyMs: 1000, length: 10 }, late);
  assert.ok(hint.includes("這麼晚了"), hint);
  assert.ok(hint.includes("猜"), hint);
});

test("pace: unusually fast and long gives a chatty guess", () => {
  const now = new Date(2026, 9, 31, 14, 0);
  const state = stateWith("a", points(8, 10, 1000));
  const hint = paceHint(state, "a", { at: "x", latencyMs: 100, length: 50 }, now);
  assert.ok(hint.includes("回得特別多") && hint.includes("猜"), hint);
});

test("pace: normal message gives nothing", () => {
  const now = new Date(2026, 9, 31, 14, 0);
  const state = stateWith("a", points(8, 10, 1000));
  assert.equal(paceHint(state, "a", { at: "x", latencyMs: 1000, length: 12 }, now), "");
});

test("pace: reserved keys are rejected and never become own properties", () => {
  for (const key of ["__proto__", "constructor", "prototype"]) {
    assert.throws(() => paceAdd(empty(), key, { at: "x", latencyMs: 1, length: 1 }));
  }
  const poisoned = paceAdd(empty(), "bob", { at: "x", latencyMs: 1, length: 1 });
  assert.equal(({} as Record<string, unknown>).polluted, undefined);
  assert.equal(Object.hasOwn(poisoned.people, "__proto__"), false);
  const now = new Date(2026, 9, 31, 14, 0);
  assert.equal(paceHint(poisoned, "__proto__", { at: "x", latencyMs: 1, length: 1 }, now), "");
  assert.equal(paceHint(poisoned, "constructor", { at: "x", latencyMs: 1, length: 1 }, now), "");
});

test("pace: keeps only the last 20 points per person", () => {
  let state = empty();
  for (let i = 0; i < 30; i++) {
    state = paceAdd(state, "a", { at: String(i), latencyMs: i, length: i });
  }
  assert.equal(state.people.a!.length, 20);
  assert.equal(state.people.a![0]!.latencyMs, 10);
  assert.equal(state.people.a![19]!.latencyMs, 29);
});

test("pace: keeps at most 50 people, dropping the least recently seen", () => {
  let state = empty();
  for (let i = 0; i < 50; i++) {
    const at = new Date(Date.UTC(2026, 0, 1, 0, i)).toISOString();
    state = paceAdd(state, `p${i}`, { at, latencyMs: 1, length: 1 });
  }
  // p0 was seen earliest; a new person arrives later and should evict p0.
  const later = new Date(Date.UTC(2026, 0, 2)).toISOString();
  state = paceAdd(state, "newcomer", { at: later, latencyMs: 1, length: 1 });
  const keys = Object.keys(state.people);
  assert.equal(keys.length, 50);
  assert.ok(!keys.includes("p0"));
  assert.ok(keys.includes("newcomer"));
  assert.ok(keys.includes("p49"));
});

test("persistence: missing file loads as empty state", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-reading-"));
  try {
    assert.deepEqual(plain(loadPace(join(root, "nope.json"))), { people: {} });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence: corrupt or malformed file loads as empty state", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-reading-"));
  try {
    const bad = join(root, "bad.json");
    writeFileSync(bad, "{not json");
    assert.deepEqual(plain(loadPace(bad)), { people: {} });

    const wrongShape = join(root, "shape.json");
    writeFileSync(wrongShape, JSON.stringify([1, 2]));
    assert.deepEqual(plain(loadPace(wrongShape)), { people: {} });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence: load drops invalid points and reserved keys", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-reading-"));
  try {
    const file = join(root, "pace.json");
    const raw = {
      people: {
        ok: [
          { at: "t", latencyMs: 5, length: 3 },
          { at: "t", latencyMs: "x", length: 3 },
          { at: 1, latencyMs: 5, length: 3 },
          null,
        ],
        constructor: [{ at: "t", latencyMs: 5, length: 3 }],
        junk: "not an array",
      },
    };
    writeFileSync(file, JSON.stringify(raw));
    const loaded = plain(loadPace(file));
    assert.deepEqual(loaded, { people: { ok: [{ at: "t", latencyMs: 5, length: 3 }] } });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("persistence: save then load round-trips and leaves no temp files", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-reading-"));
  try {
    const file = join(root, "sub", "pace.json");
    const state = paceAdd(empty(), "bob", { at: "2026-10-31T00:00:00.000Z", latencyMs: 42, length: 7 });
    savePace(file, state);
    assert.deepEqual(plain(loadPace(file)), plain(state));
    const leftovers = readFileSync(file, "utf8");
    assert.ok(leftovers.includes("bob"));
    assert.equal(existsSync(`${file}.tmp`), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
