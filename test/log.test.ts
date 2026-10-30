import test from "node:test";
import assert from "node:assert/strict";
import { formatLine, log, snip } from "../src/log.ts";

test("lines carry the local time, a padded tag and the message", () => {
  const at = new Date(2026, 9, 31, 1, 35, 12);
  assert.equal(formatLine("msg", "ren: 嗨", at, false), "01:35:12 msg    ren: 嗨");
});

test("colour is only added when asked for", () => {
  const at = new Date(2026, 9, 31, 1, 35, 12);
  assert.ok(!formatLine("turn", "x", at, false).includes("\u001b"));
  assert.ok(formatLine("turn", "x", at, true).includes("\u001b[32m"));
});

test("snip keeps one line and cuts long text", () => {
  assert.equal(snip("a\nb\tc   d"), "a b c d");
  assert.equal(snip("一二三四五六七八九十", 5), "一二三四五…");
  assert.equal(snip("\u001b[31mred\u0007"), "[31mred");
});

test("log stays silent during tests unless FISHD_LOG is set", () => {
  const seen: string[] = [];
  const orig = console.log;
  console.log = (...a: unknown[]) => void seen.push(a.join(" "));
  try {
    log.info("msg", "hello");
    assert.equal(seen.length, 0);
    process.env.FISHD_LOG = "info";
    log.info("msg", "hello");
    log.debug("msg", "detail");
    assert.equal(seen.length, 1);
    process.env.FISHD_LOG = "debug";
    log.debug("msg", "detail");
    assert.equal(seen.length, 2);
    process.env.FISHD_LOG = "quiet";
    log.info("msg", "hidden");
    assert.equal(seen.length, 2);
  } finally {
    console.log = orig;
    delete process.env.FISHD_LOG;
  }
});
