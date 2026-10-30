import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySelf,
  emptySelf,
  planDue,
  renderSelf,
  tickSelf,
  touchSelf,
} from "../src/persona/self.ts";

const at = () => new Date(2026, 9, 30, 21, 0, 0);

test("boredom and longing rise while idle, contact drains them", () => {
  const halfHourAgo = new Date(at().getTime() - 30 * 60_000);
  const base = {
    ...emptySelf(),
    boredom: 50,
    longing: 40,
    lastSeen: halfHourAgo.toISOString(),
    lastTick: halfHourAgo.toISOString(),
  };

  const idle = tickSelf(base, at());
  assert.ok(idle.boredom > 50, `${idle.boredom}`);
  assert.ok(idle.longing > 40, `${idle.longing}`);

  const touched = touchSelf(base, at());
  assert.ok(touched.boredom < 50, `${touched.boredom}`);
  assert.ok(touched.longing < 40, `${touched.longing}`);
  assert.equal(touched.lastSeen, at().toISOString());
  assert.equal(touched.sleeping, false);
});

test("a heartbeat and a turn never count the same idle minute twice", () => {
  const start = at();
  const first = new Date(start.getTime() + 60_000);
  const second = new Date(start.getTime() + 120_000);
  const base = {
    ...emptySelf(),
    longing: 10,
    lastSeen: new Date(start.getTime() - 30 * 60_000).toISOString(),
    lastTick: start.toISOString(),
  };

  const one = tickSelf(base, first);
  const two = tickSelf(one, second);
  assert.ok(Math.abs(two.longing - (base.longing + 2 * 0.18)) < 0.001, `${two.longing}`);
});

test("boredom and longing stay inside 0..100", () => {
  const high = tickSelf(
    {
      ...emptySelf(),
      boredom: 99,
      longing: 99,
      lastSeen: new Date(at().getTime() - 600 * 60_000).toISOString(),
      lastTick: new Date(at().getTime() - 600 * 60_000).toISOString(),
    },
    at(),
  );
  assert.equal(high.boredom, 100);
  assert.equal(high.longing, 100);

  const low = touchSelf({ ...emptySelf(), boredom: 10, longing: 10 }, at());
  assert.equal(low.boredom, 0);
  assert.equal(low.longing, 0);
});

test("she can set a task, slack off, and plan her next line", () => {
  const { state, log } = applySelf(
    emptySelf(),
    { task: "整理白飯清單", slacking: true, planMinutes: 20, planTopic: "晚餐", planWhy: "想知道他吃了沒" },
    at(),
  );

  assert.equal(state.task?.what, "整理白飯清單");
  assert.equal(state.slacking, true);
  assert.ok(state.plan);
  assert.equal(state.plan?.topic, "晚餐");
  assert.ok(log.length >= 3, log.join(" | "));

  const text = renderSelf(state, at());
  assert.ok(text.includes("摸魚"), text);
  assert.ok(text.includes("白飯清單"), text);
  assert.ok(text.includes("20 分鐘後"), text);
});

test("she can choose to sleep, wake up, or let the alarm do it", () => {
  const asleep = applySelf(emptySelf(), { sleeping: true, sleepMinutes: 60 }, at()).state;
  assert.equal(asleep.sleeping, true);
  assert.ok(renderSelf(asleep, at()).includes("正在睡"));

  const manual = applySelf(asleep, { sleeping: false }, at()).state;
  assert.equal(manual.sleeping, false);
  assert.equal(manual.sleepUntil, "");
  assert.ok(!renderSelf(manual, at()).includes("正在睡"));

  const auto = tickSelf(asleep, new Date(at().getTime() + 61 * 60_000));
  assert.equal(auto.sleeping, false);
  assert.equal(auto.sleepUntil, "");
});

test("marks are capped and the newest one is visible", () => {
  let state = emptySelf();
  for (let i = 0; i < 10; i++) {
    state = applySelf(state, { mark: `記號 ${i}` }, at()).state;
  }

  assert.equal(state.marks.length, 8);
  const text = renderSelf(state, at());
  assert.ok(text.includes("記號 9"), text);
  assert.ok(!text.includes("記號 0"), text);
});

test("a plan becomes due exactly at its time", () => {
  const { state } = applySelf(emptySelf(), { planMinutes: 10, planTopic: "睡覺" }, at());
  assert.equal(planDue(state, at()), false);
  assert.equal(planDue(state, new Date(at().getTime() + 10 * 60_000)), true);
});

test("clearing the plan and the task works", () => {
  const first = applySelf(emptySelf(), { task: "寫 code", planMinutes: 5, planTopic: "x" }, at()).state;
  const second = applySelf(first, { task: "", clearPlan: true }, at()).state;

  assert.equal(second.task, null);
  assert.equal(second.plan, null);
});

test("renderSelf is empty when there is nothing to say", () => {
  assert.equal(renderSelf({ ...emptySelf(), boredom: 30 }, at()), "");
});
