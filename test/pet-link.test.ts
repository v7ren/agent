import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createPetLink } from "../src/channels/petLink.ts";

test("pet events are appended as JSONL and repeated states collapse", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-petlink-"));
  const path = join(root, "agent-events", "fishd.jsonl");
  try {
    const link = createPetLink(path);
    link.emit("thinking");
    link.emit("thinking");
    link.emit("working", "memory_search");
    link.emit("idle");

    const lines = readFileSync(path, "utf8").trim().split("\n").map((line) => JSON.parse(line));
    assert.equal(lines.length, 3);
    assert.equal(lines[0].state, "thinking");
    assert.equal(lines[1].state, "working");
    assert.equal(lines[1].tool, "memory_search");
    assert.equal(lines[2].state, "idle");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a broken event path never throws", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-petlink-"));
  const path = join(root, "not-a-directory");
  writeFileSync(path, "occupied", "utf8");
  try {
    assert.doesNotThrow(() => createPetLink(path).emit("idle"));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
