import { test } from "node:test";
import assert from "node:assert/strict";
import {
  advanceTurn,
  applyMoodPatch,
  derive,
  fed,
  hearTease,
  initialMood,
  mealFromText,
  nudge,
  render,
  teaseLevel,
  tick,
} from "../src/persona/mood.ts";
import type { MoodState } from "../src/persona/mood.ts";

const at = (h: number, m = 0) => new Date(2026, 9, 28, h, m, 0, 0);

test("tick drains energy while awake and raises hunger", () => {
  const base = initialMood(at(22), 80, 20);
  const next = tick(base, at(23));
  assert.ok(next.energy < 80, `energy should drop, got ${next.energy}`);
  assert.ok(next.hunger > 20, `hunger should rise, got ${next.hunger}`);
  assert.equal(next.lastTick, at(23).toISOString());
});

test("tick clamps absurd gaps instead of underflowing", () => {
  const base: MoodState = {
    ...initialMood(new Date(2026, 0, 1), 90, 50),
    lastTick: new Date(2026, 0, 1).toISOString(),
  };
  const next = tick(base, new Date(2026, 1, 1));
  assert.ok(next.energy >= 0 && next.energy <= 100);
  assert.ok(next.hunger >= 0 && next.hunger <= 100);
});

test("tick is a no-op for non-positive dt", () => {
  const base = initialMood(at(12), 50, 50);
  const next = tick(base, at(12));
  assert.deepEqual(next, base);
});

test("3am with low energy derives sleepy", () => {
  const s: MoodState = {
    ...initialMood(at(3), 12, 20),
    mood: "genki",
    overrideTurns: 0,
  };
  assert.equal(derive(s, at(3)).mood, "sleepy");
});

test("lunch with high hunger derives hungry", () => {
  const s: MoodState = {
    ...initialMood(at(12, 30), 70, 90),
    mood: "tsundere",
    overrideTurns: 0,
  };
  assert.equal(derive(s, at(12, 30)).mood, "hungry");
});

test("override suppresses derivation", () => {
  const s: MoodState = {
    ...initialMood(at(3), 5, 10),
    mood: "genki",
    overrideTurns: 2,
  };
  assert.equal(derive(s, at(3)).mood, "genki");
});

test("nudge applies once per conversation", () => {
  const s = initialMood(at(15), 60, 40);
  const first = nudge(s, { mood: "tsundere", why: "被逗" }, at(15), {
    nudgedThisSession: false,
  });
  assert.equal(first.accepted, true);
  assert.equal(first.state.mood, "tsundere");
  assert.equal(first.state.overrideTurns, 3);
  assert.ok(first.log?.includes("tsundere"));

  const second = nudge(first.state, { mood: "genki" }, at(15), {
    nudgedThisSession: true,
  });
  assert.equal(second.accepted, false);
  assert.equal(second.reason, "already-nudged");
});

test("nudge is rejected in serious mode", () => {
  const s = initialMood(at(15));
  const r = nudge(s, { mood: "genki" }, at(15), {
    nudgedThisSession: false,
    serious: true,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "serious-mode");
});

test("nudge is a no-op when nothing changes", () => {
  const s = initialMood(at(15));
  const r = nudge(s, { mood: s.mood, intensity: s.intensity }, at(15), {
    nudgedThisSession: false,
  });
  assert.equal(r.accepted, false);
  assert.equal(r.reason, "unchanged");
});

test("render exposes effects, never raw numbers", () => {
  const s = initialMood(at(15), 74, 35);
  const line = render(s, at(15), { closeness: "friend", gapHours: 50 });
  assert.equal(/\d+\s*%/.test(line), false, `render leaked a percentage: ${line}`);
  assert.equal(/energy|hunger|精力|飽足/.test(line), false, `render leaked a stat name: ${line}`);
  assert.ok(line.includes("現在的你"));
  assert.ok(line.includes("2 天沒見"));
});

test("render drops all cuteness in serious mode", () => {
  const line = render(initialMood(at(15)), at(15), { serious: true });
  assert.ok(line.includes("可愛元素全部收起來"));
  assert.equal(/\d/.test(line), false);
});

test("tsundere is not the resting state: a calm genki stays genki", () => {
  const s = initialMood(at(15), 60, 30);
  assert.equal(derive(s, at(15)).mood, "genki");
});

test("tsundere with no teasing left lets go without a margin", () => {
  const s: MoodState = { ...initialMood(at(15), 60, 30), mood: "tsundere", overrideTurns: 0, tease: 0 };
  assert.equal(derive(s, at(15)).mood, "genki");
});

test("teasing and praise classify, and 大肥魚 counts most", () => {
  assert.equal(teaseLevel("你這個大肥魚"), 50);
  assert.equal(teaseLevel("你好笨喔"), 35);
  assert.equal(teaseLevel("好厲害！"), 25);
  assert.equal(teaseLevel("今天天氣不錯"), 0);
});

test("being called 大肥魚 raises tsundere", () => {
  const s = initialMood(at(15), 60, 30);
  const next = hearTease(s, "大肥魚", at(15));
  assert.equal(next.mood, "tsundere");
  assert.equal(next.tease, 50);
});

test("teasing fades by wall clock over hours", () => {
  const s: MoodState = { ...initialMood(at(15), 60, 30), tease: 50 };
  const later = tick(s, at(18));
  assert.ok((later.tease ?? 0) < 2, `tease should have faded, got ${later.tease}`);
});

test("a meal given to her lowers hunger, and questions do not count", () => {
  assert.equal(mealFromText("給你白飯，快吃吧。"), 40);
  assert.equal(mealFromText("我把西瓜吃完了。"), 15);
  assert.equal(mealFromText("你吃了嗎？"), 0);
  assert.equal(mealFromText("我還沒吃飯。"), 0);
  assert.equal(mealFromText("今天天氣不錯。"), 0);
});

test("fed reduces hunger and clamps at zero", () => {
  const s = { ...initialMood(at(12), 60, 80) };
  assert.equal(fed(s, "給你白飯", at(12)).hunger, 40);
  const low = { ...initialMood(at(12), 60, 10) };
  assert.equal(fed(low, "給你白飯", at(12)).hunger, 0);
});

test("a nudge expires by wall clock, not by assistant turns", () => {
  const s = initialMood(at(15), 60, 30);
  const { state } = nudge(s, { mood: "tsundere" }, at(15), { nudgedThisSession: false });
  let advanced = state;
  for (let i = 0; i < 10; i++) advanced = advanceTurn(advanced);
  assert.equal(derive(advanced, at(15, 10)).mood, "tsundere");
  assert.equal(derive(advanced, at(15, 21)).mood, "genki");
});

test("applyMoodPatch clamps numbers and ignores bad values", () => {
  const s = initialMood(at(15), 60, 30);
  const hi = applyMoodPatch(s, { hunger: 150, energy: -5 }, at(15));
  assert.equal(hi.hunger, 100);
  assert.equal(hi.energy, 0);
  const nan = applyMoodPatch(s, { hunger: Number.NaN }, at(15));
  assert.equal(nan.hunger, 30);
  assert.equal(applyMoodPatch(s, { mood: "bogus" as never }, at(15)).mood, "genki");
});

test("applyMoodPatch holds a set mood like a nudge, but a hunger-only patch does not", () => {
  const s = initialMood(at(15), 60, 30);
  const set = applyMoodPatch(s, { mood: "tsundere", intensity: 3 }, at(15));
  assert.equal(set.mood, "tsundere");
  assert.equal(set.intensity, 3);
  assert.equal(derive(set, at(15, 10)).mood, "tsundere");
  const hungerOnly = applyMoodPatch(s, { hunger: 35 }, at(15));
  assert.equal(hungerOnly.overrideUntil, undefined);
});
