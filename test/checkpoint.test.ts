import { test } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { chunkText, planChunks, safeScope, writeCheckpoint } from "../src/memory/checkpoint.ts";
import { StubProvider } from "../src/core/provider.ts";

class RecordingProvider extends StubProvider {
  readonly calls: Parameters<StubProvider["chat"]>[0][] = [];
  override async chat(req: Parameters<StubProvider["chat"]>[0]) {
    this.calls.push(req);
    return super.chat(req);
  }
}

test("chunking keeps every non-blank line, in order, within the size", () => {
  const lines = Array.from({ length: 200 }, (_, i) => `第${i}行 ${"字".repeat(i % 37)}`);
  const text = lines.join("\n");
  const chunks = chunkText(text, 120);

  for (const c of chunks) assert.ok(Array.from(c).length <= 120, c);
  assert.equal(chunks.join("\n"), text);
});

test("an over-long single line is split, not cut", () => {
  const long = "魚".repeat(500);
  const chunks = chunkText(long, 200);
  assert.equal(chunks.length, 3);
  assert.equal(chunks.join(""), long);
});

test("planChunks never plans more than 3 chunks, however long the text", () => {
  const huge = Array.from({ length: 5000 }, (_, i) => `line ${i} ${"x".repeat(30)}`).join("\n");
  const chunks = planChunks(huge, 6000, 4);
  assert.ok(chunks.length <= 3, String(chunks.length));
  assert.equal(chunks.join("").replace(/\s/g, ""), huge.replace(/\s/g, ""));
});

test("a long transcript is condensed in at most 4 calls with every message seen", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-cp-"));
  try {
    const messages = Array.from({ length: 300 }, (_, i) => ({
      role: "user" as const,
      content: `第${String(i).padStart(3, "0")}則 ${"話".repeat(290)}`,
    }));
    const provider = new RecordingProvider(["重點"]);
    const out = await writeCheckpoint({ root, scope: "main", index: 1, messages, provider });

    assert.ok(out, "checkpoint written");
    assert.ok(provider.calls.length > 1 && provider.calls.length <= 4, String(provider.calls.length));

    const seen = provider.calls
      .slice(0, -1)
      .flatMap((c) => c.messages.filter((m) => m.role === "user").map((m) => m.content))
      .join("\n");
    for (let i = 0; i < 300; i++) {
      assert.ok(seen.includes(`第${String(i).padStart(3, "0")}則`), `message ${i}`);
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a restart never overwrites an older checkpoint", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-cp-"));
  try {
    const provider = new StubProvider(["重點一"]);
    const messages = [{ role: "user" as const, content: "hi" }];

    const first = await writeCheckpoint({ root, scope: "main", index: 1, messages, provider });
    assert.equal(first?.index, 1);
    const before = readFileSync(join(root, "sessions/main/cp-001.md"), "utf8");

    // A fresh process starts its counter at 1 again.
    const again = await writeCheckpoint({ root, scope: "main", index: 1, messages, provider });
    assert.equal(again?.index, 2);
    assert.equal(readFileSync(join(root, "sessions/main/cp-001.md"), "utf8"), before);
    assert.ok(existsSync(join(root, "sessions/main/cp-002.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("rooms with non-ASCII names get distinct folders; ASCII names are unchanged", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-cp-"));
  try {
    const provider = new StubProvider(["重點"]);
    const messages = [{ role: "user" as const, content: "hi" }];
    const living = await writeCheckpoint({ root, scope: "客廳", index: 1, messages, provider });
    const bed = await writeCheckpoint({ root, scope: "臥室", index: 1, messages, provider });
    const kitchen = await writeCheckpoint({ root, scope: "kitchen", index: 1, messages, provider });
    assert.ok(living && bed && kitchen);

    const folder = (rel: string) => rel.split("/")[1] ?? "";
    assert.notEqual(folder(living.rel), folder(bed.rel));
    assert.notEqual(folder(living.rel), "main");
    assert.equal(folder(kitchen.rel), "kitchen");
    assert.equal(safeScope("#kitchen"), "kitchen");
    assert.equal(safeScope("客廳"), safeScope("客廳"));
    assert.ok(existsSync(join(root, living.rel)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("an empty transcript writes nothing", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-cp-"));
  try {
    const provider = new StubProvider(["重點"]);
    const out = await writeCheckpoint({ root, scope: "main", index: 1, messages: [], provider });
    assert.equal(out, null);
    assert.ok(!existsSync(join(root, "sessions/main/cp-001.md")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
