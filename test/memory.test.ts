import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { keywordQuery, tokenize } from "../src/memory/tokenize.ts";
import { MemoryIndex } from "../src/memory/index.ts";
import { VaultMemory } from "../src/memory/vaultMemory.ts";
import { writeDiary } from "../src/memory/diary.ts";
import { journalPath } from "../src/memory/vault.ts";
import { StubProvider } from "../src/core/provider.ts";

/** Records every request so tests can count calls and inspect what was sent. */
class RecordingProvider extends StubProvider {
  readonly calls: Parameters<StubProvider["chat"]>[0][] = [];
  override async chat(req: Parameters<StubProvider["chat"]>[0]) {
    this.calls.push(req);
    return super.chat(req);
  }
}

test("tokenize splits latin runs and adds CJK bigrams", () => {
  const tokens = tokenize("Hello, World 白飯很好吃");
  assert.ok(tokens.includes("hello"));
  assert.ok(tokens.includes("world"));
  assert.equal(tokens.includes("hello,"), false);
  assert.ok(tokens.includes("白飯"));
  // 很 and 好 are function characters, so a bigram made of them is not indexed
  assert.equal(tokens.includes("很好"), false);
  assert.equal(new Set(tokens).size, tokens.length);
  assert.ok(tokenize("魚").includes("魚"));
});

test("search finds the right line number", () => {
  const index = new MemoryIndex();
  index.add({
    path: "journal/a.md",
    text: "# 日誌\r\n今天吃了拉麵\r\n明天想吃壽司",
    mtime: 1000,
  });

  const hits = index.search("拉麵");
  assert.equal(hits[0]?.path, "journal/a.md");
  assert.equal(hits[0]?.line, 2);
  assert.ok(hits[0]?.why.startsWith("matched: "));
});

test("Chinese query finds a Chinese document", () => {
  const index = new MemoryIndex();
  index.add({ path: "notes/zh.md", text: "白飯很好吃", mtime: 1 });
  index.add({ path: "notes/en.md", text: "the rice was good", mtime: 1 });

  const hits = index.search("白飯");
  assert.ok(hits.length > 0);
  assert.equal(hits[0]?.path, "notes/zh.md");
});

test("add twice replaces rather than duplicates", () => {
  const index = new MemoryIndex();
  index.add({ path: "same.md", text: "alpha beta", mtime: 1 });
  index.add({ path: "same.md", text: "gamma delta", mtime: 2 });

  assert.equal(index.docCount, 1);
  assert.equal(index.search("alpha").length, 0);
  assert.equal(index.search("gamma")[0]?.path, "same.md");
});

test("toJSON/fromJSON round-trips and still finds the same hit", () => {
  const index = new MemoryIndex();
  index.add({
    path: "journal/2026/10/2026-10-28.md",
    text: "# 日誌\n今天吃了白飯\n明天想吃壽司",
    mtime: 2000,
  });
  index.add({ path: "notes/en.md", text: "the rice was good today", mtime: 1500 });

  const before = index.search("白飯");
  const restored = MemoryIndex.fromJSON(JSON.parse(JSON.stringify(index.toJSON())));

  assert.equal(restored.docCount, index.docCount);
  assert.deepEqual(restored.search("白飯"), before);
  assert.deepEqual(restored.search("rice"), index.search("rice"));
});

test("empty query returns no hits", () => {
  const index = new MemoryIndex();
  index.add({ path: "a.md", text: "apple banana", mtime: 1 });

  assert.deepEqual(index.search(""), []);
  assert.deepEqual(index.search("   \n\t "), []);
  assert.deepEqual(new MemoryIndex().search("apple"), []);
});

test("ranking prefers the clearly better match", () => {
  const index = new MemoryIndex();
  index.add({ path: "a.md", text: "apple banana cherry", mtime: 100 });
  index.add({ path: "b.md", text: "apple", mtime: 100 });

  const hits = index.search("apple");
  assert.equal(hits[0]?.path, "b.md");
  assert.equal(hits[0]?.why, "matched: apple");
  assert.ok((hits[0]?.score ?? 0) > (hits[1]?.score ?? 0));
});

test("a single CJK character finds the longer word that contains it", () => {
  const index = new MemoryIndex();
  index.add({ path: "notes/rice.md", text: "今天的白飯很香", mtime: 1 });
  index.add({ path: "notes/ramen.md", text: "晚上吃拉麵", mtime: 1 });

  assert.equal(index.search("飯")[0]?.path, "notes/rice.md");
  assert.ok(tokenize("白飯").includes("飯"));
});

test("particles are dropped from tokens and from the keyword query", () => {
  const tokens = tokenize("我的白飯呢");
  for (const particle of ["我", "的", "呢"]) assert.equal(tokens.includes(particle), false, particle);
  assert.ok(tokens.includes("白"));

  assert.equal(keywordQuery("你的啊呢嗎"), "");
  const query = keywordQuery("你今天吃白飯嗎").split(" ");
  assert.ok(query.includes("白飯"));
  assert.equal(query.includes("你"), false);
  assert.equal(query.includes("嗎"), false);
});

test("a long message searches for its content words, not its particles", () => {
  const index = new MemoryIndex();
  index.add({ path: "notes/rice.md", text: "我喜歡白飯", mtime: 1 });
  index.add({ path: "notes/who.md", text: "我是誰呢", mtime: 1 });

  const hits = index.search(keywordQuery("我的白飯呢"));
  assert.equal(hits[0]?.path, "notes/rice.md");
  assert.ok(hits.every((h) => h.path !== "notes/who.md"));
});

test("recency decays with a 30-day half-life and a 0.2 floor", () => {
  const DAY = 86_400_000;
  const now = 100 * DAY;
  const index = new MemoryIndex();
  index.add({ path: "fresh.md", text: "白飯", mtime: now });
  index.add({ path: "month.md", text: "白飯", mtime: now - 30 * DAY });
  index.add({ path: "old.md", text: "白飯", mtime: now - 3650 * DAY });

  const score = new Map(index.search("白飯", 8, { now }).map((h) => [h.path, h.score]));
  const fresh = score.get("fresh.md") ?? 0;
  assert.ok(fresh > 0);
  // one half-life: 0.2 + 0.8 * 0.5 = 0.6 of the fresh score
  assert.ok(Math.abs((score.get("month.md") ?? 0) / fresh - 0.6) < 1e-9);
  // ten years later: the floor, not zero
  const ratio = (score.get("old.md") ?? 0) / fresh;
  assert.ok(ratio >= 0.2 && ratio < 0.201, String(ratio));
});

test("a day contributes at most one hit", () => {
  const index = new MemoryIndex();
  index.add({ path: "journal/a.md", text: "白飯\n白飯很好\n白飯", mtime: 1 });
  index.add({ path: "journal/b.md", text: "白飯", mtime: 1 });

  const hits = index.search("白飯", 8);
  assert.equal(hits.length, 2);
  assert.equal(hits.filter((h) => h.path === "journal/a.md").length, 1);
  assert.equal(index.search("白飯", 1).length, 1);
});

test("scoped recall never shows another room's lines", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-scope-"));
  try {
    mkdirSync(join(root, "diary"), { recursive: true });
    writeFileSync(join(root, "diary/2026-10-29.md"), "# 日記\n今天白飯很好吃\n", "utf8");

    const at = new Date(2026, 9, 30, 12, 0);
    const writer = new VaultMemory(root);
    writer.log({ kind: "heard", text: "我超愛白飯", at, where: "#kitchen", who: "ren", whoId: "1" });
    writer.log({ kind: "heard", text: "白飯配滷蛋", at, where: "#secret", who: "amy", whoId: "2" });
    writer.log({ kind: "said", text: "我也想吃白飯", at, where: "#secret" });

    // reloaded from disk, so the tags must survive a restart
    const memory = new VaultMemory(root);
    const lines = (room: string) =>
      memory
        .search("白飯", 8, { room })
        .map((h) => memory.open(h.path, h.line, 1))
        .join("\n");

    const kitchen = lines("#kitchen");
    assert.ok(kitchen.includes("超愛"), kitchen);
    assert.ok(!kitchen.includes("滷蛋"), kitchen);
    assert.ok(!kitchen.includes("也想吃"), kitchen);

    const secret = lines("#secret");
    assert.ok(secret.includes("滷蛋") || secret.includes("也想吃"), secret);
    assert.ok(!secret.includes("超愛"), secret);

    // the diary is shared: a room with no lines of its own still sees it
    const quiet = memory.search("白飯", 8, { room: "#quiet" });
    assert.deepEqual(quiet.map((h) => h.path), ["diary/2026-10-29.md"]);

    const block = memory.recall("白飯", at, { room: "#kitchen" });
    assert.ok(block?.content.includes("超愛"), block?.content);
    assert.ok(!block?.content.includes("滷蛋"), block?.content);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("unscoped search still sees every room", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-scope-"));
  try {
    const memory = new VaultMemory(root);
    const at = new Date(2026, 9, 30, 12, 0);
    memory.log({ kind: "heard", text: "白飯A", at, where: "#a", who: "ren", whoId: "1" });
    memory.log({ kind: "heard", text: "白飯B", at, where: "#b", who: "amy", whoId: "2" });
    assert.equal(memory.search("白飯", 8).length, 1);
    assert.ok(memory.search("白飯", 8, { room: "#b" }).length === 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("function characters are not indexed, content words still match", () => {
  assert.deepEqual(tokenize("は を が に で と も"), []);
  assert.equal(keywordQuery("你是不是很好的嗎"), "");
  assert.equal(keywordQuery("the cat is here"), "the cat here");

  const index = new MemoryIndex();
  index.add({ path: "fish.md", text: "今天吃魚", mtime: 1 });
  index.add({ path: "cat.md", text: "我養了一隻貓", mtime: 1 });
  index.add({ path: "melon.md", text: "西瓜很甜", mtime: 1 });
  index.add({ path: "rice.md", text: "白飯", mtime: 1 });
  index.add({ path: "fn.md", text: "我不是很好的嗎", mtime: 1 });

  assert.equal(index.search("魚")[0]?.path, "fish.md");
  assert.equal(index.search("貓")[0]?.path, "cat.md");
  assert.equal(index.search("西瓜")[0]?.path, "melon.md");
  assert.equal(index.search("飯")[0]?.path, "rice.md");
  // a line made only of function words is never returned for a stopword query
  assert.deepEqual(index.search(keywordQuery("我不是很好的嗎")), []);
  assert.ok(index.search(keywordQuery("你今天吃魚嗎")).every((h) => h.path !== "fn.md"));
});

test("open and timeline with a scope leave out other rooms' journal lines", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-open-"));
  try {
    const at = new Date(2026, 9, 30, 12, 0);
    const writer = new VaultMemory(root);
    writer.log({ kind: "heard", text: "我超愛白飯", at, where: "#kitchen", who: "ren", whoId: "1" });
    writer.log({ kind: "heard", text: "白飯配滷蛋", at, where: "#secret", who: "amy", whoId: "2" });
    writer.log({ kind: "said", text: "我也想吃白飯", at, where: "#secret" });

    const memory = new VaultMemory(root);
    const rel = memory.search("白飯", 1)[0]?.path ?? "";
    assert.ok(rel.startsWith("journal/"), rel);

    // unscoped calls keep the old behaviour
    assert.ok(memory.open(rel, 1, 40).includes("滷蛋"));
    assert.equal(memory.timeline(at).length, 2);

    const kitchen = memory.open(rel, 1, 40, { room: "#kitchen" });
    assert.ok(kitchen.startsWith("# "), kitchen);
    assert.ok(kitchen.includes("超愛"), kitchen);
    assert.ok(!kitchen.includes("滷蛋"), kitchen);
    assert.ok(!kitchen.includes("也想吃"), kitchen);

    const day = memory.timeline(at, { room: "#kitchen" });
    assert.equal(day.length, 1);
    assert.ok(day[0]?.includes("超愛"), String(day[0]));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("resolve never wipes pending items, and blank pending text is not stored", () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-person-"));
  try {
    mkdirSync(join(root, "nodes/people"), { recursive: true });
    writeFileSync(
      join(root, "nodes/people/amy.md"),
      '---\nid: "amy"\nname: "Amy"\n---\n\n# Amy\n\n## 進行中\n- 2026-10-01 還欠我一頓晚餐\n- 2026-10-02 明天還書\n',
      "utf8",
    );
    const memory = new VaultMemory(root);
    const at = new Date(2026, 9, 31, 12, 0);

    assert.equal(memory.setPerson("amy", { resolve: "   " }, at)?.pending.length, 2);
    assert.equal(memory.setPerson("amy", { resolve: "" }, at)?.pending.length, 2);
    assert.equal(memory.setPerson("amy", { pending: "   " }, at)?.pending.length, 2);

    const after = memory.setPerson("amy", { resolve: "晚餐" }, at);
    assert.deepEqual(after?.pending, ["2026-10-02 明天還書"]);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a long day is condensed in at most 4 calls, and every line is seen", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-diary-"));
  try {
    const date = new Date(2026, 9, 30, 12, 0);
    const abs = journalPath(root, date);
    mkdirSync(dirname(abs), { recursive: true });
    const pad = (i: number) => String(i).padStart(4, "0");
    const body = Array.from(
      { length: 1000 },
      (_, i) => `- 12:00 （#kitchen）ren：第${pad(i)}句 白飯很好吃白飯很好吃白飯`,
    ).join("\n");
    writeFileSync(abs, `# 日誌\n\n${body}\n`, "utf8");

    const provider = new RecordingProvider(["摘要"]);
    const out = await writeDiary({ root, date, provider });
    assert.ok(out, "diary written");
    assert.ok(provider.calls.length > 1 && provider.calls.length <= 4, String(provider.calls.length));

    const seen = provider.calls
      .slice(0, -1)
      .flatMap((c) => c.messages.filter((m) => m.role === "user").map((m) => m.content))
      .join("\n");
    for (let i = 0; i < 1000; i++) assert.ok(seen.includes(`第${pad(i)}句`), `line ${i}`);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("a short day is a single call that sends the whole journal", async () => {
  const root = mkdtempSync(join(tmpdir(), "fishd-diary-"));
  try {
    const date = new Date(2026, 9, 30, 12, 0);
    const abs = journalPath(root, date);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, "# 日誌\n\n- 12:00 （#kitchen）ren：早安末尾標記\n", "utf8");

    const provider = new RecordingProvider(["今天還不錯"]);
    await writeDiary({ root, date, provider });
    assert.equal(provider.calls.length, 1);
    assert.ok(provider.calls[0]?.messages.some((m) => m.content.includes("末尾標記")));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
