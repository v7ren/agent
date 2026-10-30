import test from "node:test";
import assert from "node:assert/strict";
import { hasDsml, parseDsml } from "../src/core/dsml.ts";

const LEAK =
  '<｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="memory_diary"> ' +
  '<｜｜DSML｜｜ parameter name="date" string="true">2026-10-31</｜｜DSML｜｜ parameter> ' +
  "</｜｜DSML｜｜ invoke> </｜｜DSML｜｜ calls>";

test("the leaked diary call is turned into a real tool call", () => {
  assert.ok(hasDsml(LEAK));
  const r = parseDsml(LEAK);
  assert.equal(r.calls.length, 1);
  assert.equal(r.calls[0]?.name, "memory_diary");
  assert.deepEqual(JSON.parse(r.calls[0]?.arguments ?? "{}"), { date: "2026-10-31" });
  assert.equal(r.text, "");
});

test("text around the markup is kept and the markup never shows", () => {
  const r = parseDsml(`我看一下喔～ ${LEAK}`);
  assert.equal(r.text, "我看一下喔～");
  assert.equal(r.calls.length, 1);
});

test("non-string parameters are read as JSON", () => {
  const r = parseDsml(
    '<｜DSML｜function_calls><｜DSML｜invoke name="memory_search">' +
      '<｜DSML｜parameter name="query" string="true">白飯</｜DSML｜parameter>' +
      '<｜DSML｜parameter name="limit" string="false">3</｜DSML｜parameter>' +
      "</｜DSML｜invoke></｜DSML｜function_calls>",
  );
  assert.deepEqual(JSON.parse(r.calls[0]?.arguments ?? "{}"), { query: "白飯", limit: 3 });
});

test("ASCII bars work too and plain text is untouched", () => {
  const r = parseDsml('<||DSML||invoke name="self"><||DSML||parameter name="boredom" string="false">10</||DSML||parameter></||DSML||invoke>');
  assert.equal(r.calls[0]?.name, "self");
  assert.equal(parseDsml("普通的一句話").text, "普通的一句話");
  assert.equal(parseDsml("普通的一句話").calls.length, 0);
});

test("a reply cut off mid-markup shows nothing of it", () => {
  const r = parseDsml('好喔 <｜｜DSML｜｜ calls> <｜｜DSML｜｜ invoke name="memory_di');
  assert.equal(r.text, "好喔");
  assert.equal(r.calls.length, 0);
});

test("bad tool or parameter names are ignored", () => {
  const r = parseDsml(
    '<｜｜DSML｜｜ invoke name="x; rm -rf"><｜｜DSML｜｜ parameter name="a" string="true">1</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>',
  );
  assert.equal(r.calls.length, 0);
});

test("at most 8 calls are read", () => {
  const one =
    '<｜｜DSML｜｜ invoke name="self"><｜｜DSML｜｜ parameter name="boredom" string="false">1</｜｜DSML｜｜ parameter></｜｜DSML｜｜ invoke>';
  assert.equal(parseDsml(one.repeat(20)).calls.length, 8);
});
