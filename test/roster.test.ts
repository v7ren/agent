import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadRoster, rosterPath, saveRoster } from "../src/memory/roster.ts";

test("the roster file sits next to the history file", () => {
  assert.equal(rosterPath(join("a", "history", "x.json")), join("a", "history", "x.roster.json"));
});

test("a roster survives a round trip, newest first", () => {
  const path = join(mkdtempSync(join(tmpdir(), "ro-")), "r.roster.json");
  saveRoster(path, [
    { id: "1", name: "ren", lastAt: 10, rooms: ["#bot"] },
    { id: "2", name: "Wennn", lastAt: 20, rooms: ["#bot", "#chat"] },
  ]);
  const back = loadRoster(path);
  assert.deepEqual(back.map((p) => p.name), ["Wennn", "ren"]);
  assert.deepEqual(back[0]?.rooms, ["#bot", "#chat"]);
});

test("bad ids, blank names and corrupt files are ignored", () => {
  const dir = mkdtempSync(join(tmpdir(), "ro-"));
  const path = join(dir, "r.roster.json");
  saveRoster(path, [
    { id: "../x", name: "bad", lastAt: 1, rooms: [] },
    { id: "3", name: "  ", lastAt: 1, rooms: [] },
    { id: "4", name: "ok", lastAt: 1, rooms: [] },
  ]);
  assert.deepEqual(loadRoster(path).map((p) => p.id), ["4"]);
  writeFileSync(path, "{nope");
  assert.deepEqual(loadRoster(path), []);
  assert.deepEqual(loadRoster(join(dir, "missing.json")), []);
});
