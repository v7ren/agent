import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ensureDiaries } from "../src/memory/autodiary.ts";
import { diaryPath } from "../src/memory/diary.ts";
import { journalPath } from "../src/memory/vault.ts";
import type { Provider } from "../src/types.ts";

const provider = { name: "fake" } as unknown as Provider;
const NOW = new Date(2026, 9, 31, 1, 20);
const YESTERDAY = new Date(2026, 9, 30, 12);

function root(withJournal: boolean, withDiary = false): string {
  const dir = mkdtempSync(join(tmpdir(), "ad-"));
  if (withJournal) {
    const p = journalPath(dir, YESTERDAY);
    mkdirSync(dirname(p), { recursive: true });
    writeFileSync(p, "- 12:00 使用者：嗨｜我：哼\n", "utf8");
  }
  if (withDiary) {
    mkdirSync(join(dir, "diary"), { recursive: true });
    writeFileSync(join(dir, diaryPath(YESTERDAY)), "x", "utf8");
  }
  return dir;
}

function fakeWrite() {
  const calls: string[] = [];
  const fn = (async (o: { date: Date }) => {
    calls.push(o.date.toDateString());
    return { path: diaryPath(o.date), text: "…" };
  }) as never;
  return { calls, fn };
}

test("yesterday gets a diary when it has a journal and no diary", async () => {
  const w = fakeWrite();
  const made = await ensureDiaries({ root: root(true), provider, now: NOW, write: w.fn, handledDays: new Set() });
  assert.equal(made.length, 1);
  assert.equal(w.calls.length, 1);
});

test("no journal means nothing to write", async () => {
  const w = fakeWrite();
  await ensureDiaries({ root: root(false), provider, now: NOW, write: w.fn, handledDays: new Set() });
  assert.equal(w.calls.length, 0);
});

test("an existing diary is left alone", async () => {
  const w = fakeWrite();
  await ensureDiaries({ root: root(true, true), provider, now: NOW, write: w.fn, handledDays: new Set() });
  assert.equal(w.calls.length, 0);
});

test("each day is tried once per run, even if it failed", async () => {
  let calls = 0;
  const failing = (async () => {
    calls++;
    throw new Error("boom");
  }) as never;
  const seen = new Set<string>();
  const r = root(true);
  await ensureDiaries({ root: r, provider, now: NOW, write: failing, handledDays: seen });
  await ensureDiaries({ root: r, provider, now: NOW, write: failing, handledDays: seen });
  assert.equal(calls, 1);
});

test("today is never written", async () => {
  const w = fakeWrite();
  const dir = mkdtempSync(join(tmpdir(), "ad-"));
  const p = journalPath(dir, NOW);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, "- 01:00 使用者：嗨｜我：哼\n", "utf8");
  await ensureDiaries({ root: dir, provider, now: NOW, write: w.fn, handledDays: new Set() });
  assert.equal(w.calls.length, 0);
});
