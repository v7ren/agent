import { test } from "node:test";
import assert from "node:assert/strict";
import { renderPeople } from "../src/persona/people.ts";

test("lists people and marks the current speaker", () => {
  const out = renderPeople(
    [
      { id: "a", name: "ren", lastAt: 2 },
      { id: "b", name: "輕輕鬆鬆", lastAt: 3 },
    ],
    "b",
  );

  assert.ok(out.includes("<people>"));
  assert.ok(out.includes("ren"));
  assert.ok(out.includes("輕輕鬆鬆"));
  assert.ok(out.includes("（現在：輕輕鬆鬆）"));
  assert.ok(out.includes("[名字]"));
});

test("an empty roster tells the model nothing", () => {
  assert.equal(renderPeople([], "a"), "");
});

test("caps at the limit and keeps the most recent", () => {
  const many = Array.from({ length: 20 }, (_, i) => ({
    id: `u${i}`,
    name: `u${i}`,
    lastAt: i,
  }));

  const out = renderPeople(many, "u19", 5);
  const names = out.split("多人頻道；")[1]?.split("（")[0] ?? "";

  assert.equal(names.split("、").length, 5, out);
  assert.ok(out.includes("u19"));
  assert.ok(!out.includes("u0、"));
});

test("no current speaker still renders the roster", () => {
  const out = renderPeople([{ id: "a", name: "ren", lastAt: 1 }]);
  assert.ok(out.includes("ren"));
  assert.ok(!out.includes("現在："));
});

test("a scoped roster lists only people present in that room", () => {
  const out = renderPeople(
    [
      { id: "a", name: "ren", lastAt: 5, rooms: ["#kitchen"] },
      { id: "b", name: "amy", lastAt: 9, rooms: ["#secret"] },
      { id: "c", name: "bo", lastAt: 7, rooms: ["#kitchen", "#secret"] },
      { id: "d", name: "zed", lastAt: 10 },
    ],
    undefined,
    6,
    "#kitchen",
  );

  assert.ok(out.includes("ren"), out);
  assert.ok(out.includes("bo"), out);
  assert.ok(!out.includes("amy"), out);
  assert.ok(!out.includes("zed"), out);
});

test("the current speaker stays on a scoped roster", () => {
  const out = renderPeople(
    [
      { id: "a", name: "ren", lastAt: 1, rooms: ["#kitchen"] },
      { id: "b", name: "amy", lastAt: 9 },
    ],
    "b",
    6,
    "#kitchen",
  );
  assert.ok(out.includes("（現在：amy）"), out);
});

test("an unscoped roster is unchanged by the new rooms field", () => {
  const out = renderPeople([
    { id: "a", name: "ren", lastAt: 1, rooms: ["#kitchen"] },
    { id: "b", name: "amy", lastAt: 2, rooms: ["#secret"] },
  ]);
  assert.ok(out.includes("ren") && out.includes("amy"));
});
