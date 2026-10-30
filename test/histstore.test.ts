import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { historyPath, loadChain, loadHistory, saveHistory } from "../src/memory/histstore.ts";
import type { SavedHistory, SavedMsg } from "../src/memory/histstore.ts";

function tmp(): string {
  return mkdtempSync(join(tmpdir(), "fishd-hist-"));
}

function doc(messages: SavedMsg[], key = "main"): SavedHistory {
  return { v: 1, key, savedAt: "2026-10-31T00:00:00.000Z", checkpointIndex: 2, messages };
}

test("round trip keeps role, content, time and index", () => {
  const dir = tmp();
  try {
    const p = historyPath(dir, "客廳");
    const d = doc(
      [
        { role: "user", content: "嗨", at: 1000 },
        { role: "assistant", content: "你好", at: 1001 },
      ],
      "客廳",
    );
    saveHistory(p, d);
    assert.deepEqual(loadHistory(p), d);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("caps drop the oldest messages and never leave a leading assistant", () => {
  const dir = tmp();
  try {
    const p = historyPath(dir, "main");
    // 35 messages of 20000 chars = 700000; dropping 0..4 fits, then #5 (assistant) goes too.
    const msgs: SavedMsg[] = Array.from({ length: 35 }, (_, i) => ({
      role: i % 2 === 0 ? "user" : "assistant",
      content: `#${i}`.padEnd(20000, "字"),
      at: i,
    }));
    saveHistory(p, doc(msgs));
    const out = loadHistory(p);
    assert.ok(out);
    assert.equal(out.messages.length, 29);
    assert.equal(out.messages[0]?.role, "user");
    assert.ok(out.messages[0]?.content.startsWith("#6字"));
    assert.ok(out.messages.at(-1)?.content.startsWith("#34字"));
    const total = out.messages.reduce((n, m) => n + m.content.length, 0);
    assert.ok(total <= 600000, String(total));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("a single over-long message is truncated to 20000 chars", () => {
  const dir = tmp();
  try {
    const p = historyPath(dir, "main");
    saveHistory(p, doc([{ role: "user", content: "x".repeat(25000), at: 1 }]));
    const out = loadHistory(p);
    assert.equal(out?.messages[0]?.content.length, 20000);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("Windows-unsafe and non-ASCII keys give distinct, safe file names", () => {
  const dir = join(tmpdir(), "fishd-state");
  const keys = [
    "a:b",
    "a?b",
    "a_b",
    "a b",
    "客廳",
    "臥室",
    "",
    "main",
    "CON",
    "x".repeat(200),
    "x".repeat(200) + "y",
  ];
  const paths = keys.map((k) => historyPath(dir, k));
  assert.equal(new Set(paths).size, keys.length);
  for (const p of paths) {
    const stem = basename(p).slice(0, -".json".length);
    assert.ok(stem.length <= 60, stem);
    assert.ok(!/[:*?"<>|\\/]/.test(stem), stem);
    assert.equal(dirname(p), join(dir, "history"));
  }
});

test("corrupt, wrong-version and partial files load safely", () => {
  const dir = tmp();
  try {
    const p = historyPath(dir, "main");
    mkdirSync(dirname(p), { recursive: true });

    assert.equal(loadHistory(join(dir, "missing.json")), null);

    writeFileSync(p, "{not json", "utf8");
    assert.equal(loadHistory(p), null);

    writeFileSync(p, "", "utf8");
    assert.equal(loadHistory(p), null);

    writeFileSync(p, JSON.stringify({ v: 2, key: "main", messages: [] }), "utf8");
    assert.equal(loadHistory(p), null);

    writeFileSync(
      p,
      JSON.stringify({
        v: 1,
        key: "main",
        savedAt: "x",
        checkpointIndex: "bad",
        messages: [
          { role: "assistant", content: "hi", at: 1 },
          { role: "user", content: "ok", at: "bad" },
          { role: "system", content: "no", at: 2 },
          { role: "user", content: 42, at: 3 },
          { role: "user", content: "fine", at: 5 },
        ],
      }),
      "utf8",
    );
    const out = loadHistory(p);
    assert.ok(out);
    assert.equal(out?.checkpointIndex, 0);
    assert.deepEqual(out?.messages, [
      { role: "user", content: "ok", at: 0 },
      { role: "user", content: "fine", at: 5 },
    ]);

    writeFileSync(
      p,
      JSON.stringify({ v: 1, key: "main", messages: [{ role: "assistant", content: "x", at: 1 }] }),
      "utf8",
    );
    assert.equal(loadHistory(p), null);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("loadChain orders by number, keeps the last 12, strips frontmatter and links", () => {
  const root = tmp();
  try {
    const dir = join(root, "sessions", "main");
    mkdirSync(dir, { recursive: true });
    for (let n = 1; n <= 15; n++) {
      const name = `cp-${String(n).padStart(3, "0")}.md`;
      writeFileSync(
        join(dir, name),
        `---\nscope: "main"\nindex: ${n}\ntype: checkpoint\n---\n\n共${n}\n\n## 關聯\n- [[x]]\n`,
        "utf8",
      );
    }
    const out = loadChain(root, "main");
    assert.equal(out.maxIndex, 15);
    assert.equal(out.blocks.length, 12);
    assert.equal(out.blocks[0]?.id, "cp-4");
    assert.equal(out.blocks.at(-1)?.id, "cp-15");
    assert.equal(out.blocks[0]?.volatility, 2);
    assert.equal(out.blocks[0]?.content, `<checkpoint n="4">\n共4\n</checkpoint>`);
    for (const b of out.blocks) {
      assert.ok(!b.content.includes("scope:"));
      assert.ok(!b.content.includes("## 關聯"));
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadChain skips empty bodies and ignores non-matching names", () => {
  const root = tmp();
  try {
    const dir = join(root, "sessions", "main");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "cp-001.md"), "---\nindex: 1\n---\n\na\n", "utf8");
    writeFileSync(join(dir, "cp-002.md"), "---\nindex: 2\n---\n\n## 關聯\n- [[y]]\n", "utf8");
    writeFileSync(join(dir, "cp-003.md.bak"), "zz", "utf8");
    writeFileSync(join(dir, "cp-x.md"), "zz", "utf8");
    writeFileSync(join(dir, "notes.md"), "zz", "utf8");

    const out = loadChain(root, "main");
    assert.equal(out.maxIndex, 2);
    assert.deepEqual(
      out.blocks.map((b) => b.id),
      ["cp-1"],
    );
    assert.equal(out.blocks[0]?.content, `<checkpoint n="1">\na\n</checkpoint>`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("loadChain on a missing directory is empty", () => {
  const root = tmp();
  try {
    assert.deepEqual(loadChain(root, "nobody"), { blocks: [], maxIndex: 0 });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
