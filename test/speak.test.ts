import { test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, readdir, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  cleanText,
  pruneCache,
  setSpeakDeps,
  synthesize,
  truncateText,
  type FetchLike,
  type RunLike,
} from "../src/voice/speak.ts";

const ENV_KEYS = ["VOICE_CACHE_DIR", "FISHD_VOICE_BACKEND", "SOVITS_URL", "SOVITS_REF", "SOVITS_REF_TXT"] as const;
let saved: Record<string, string | undefined> = {};
let dir: string;
let restore: () => void = () => undefined;

beforeEach(async () => {
  saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));
  dir = await mkdtemp(path.join(os.tmpdir(), "speak-test-"));
  const refTxt = path.join(dir, "ref.txt");
  await writeFile(refTxt, "  prompt text  \n");
  process.env.VOICE_CACHE_DIR = path.join(dir, "cache");
  process.env.FISHD_VOICE_BACKEND = "auto";
  process.env.SOVITS_URL = "http://sovits.test";
  process.env.SOVITS_REF = path.join(dir, "ref.wav");
  process.env.SOVITS_REF_TXT = refTxt;
});

afterEach(async () => {
  restore();
  restore = () => undefined;
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  await rm(dir, { recursive: true, force: true });
});

const bytes = (n: number) => new Uint8Array(n).fill(7);

/** Fake fetch: `/docs` answers `up`, `/tts` runs the handler. Records every URL. */
function fakeFetch(
  tts: (init: RequestInit | undefined) => Promise<Response> | Response,
  up = true,
): { fetch: FetchLike; calls: string[] } {
  const calls: string[] = [];
  const fetch: FetchLike = async (url, init) => {
    calls.push(url);
    if (url.endsWith("/docs")) {
      if (!up) throw new TypeError("fetch failed");
      return new Response("{}", { status: 200 });
    }
    return tts(init);
  };
  return { fetch, calls };
}

/** Fake edge-tts runner: writes `size` bytes to the --write-media target. */
function fakeRun(size: number, log: { cmd: string; args: string[] }[] = []): RunLike {
  return async (cmd, args) => {
    log.push({ cmd, args });
    const out = args[args.indexOf("--write-media") + 1]!;
    await writeFile(out, bytes(size));
  };
}

test("cache hit: second call returns the cached file without touching the network", async () => {
  const f = fakeFetch(() => new Response(bytes(60_000)));
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(0) });

  const first = await synthesize("你好呀", { tone: "healing" });
  assert.ok(first);
  assert.equal(first.backend, "sovits");
  assert.equal(first.bytes, 60_000);
  assert.equal(f.calls.filter((u) => u.endsWith("/tts")).length, 1);

  const second = await synthesize("你好呀", { tone: "healing" });
  assert.deepEqual(second, first);
  assert.equal(f.calls.filter((u) => u.endsWith("/tts")).length, 1, "no second /tts call");
});

test("sovits down: falls back to edge-tts with the tone's prosody", async () => {
  const f = fakeFetch(() => new Response(bytes(60_000)), false);
  const log: { cmd: string; args: string[] }[] = [];
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(3000, log) });

  const r = await synthesize("测试", { tone: "softcute" });
  assert.ok(r);
  assert.equal(r.backend, "edge");
  assert.equal(r.bytes, 3000);
  assert.ok(r.path.endsWith(".mp3"));
  assert.equal(log.length, 1);
  assert.equal(log[0]!.cmd, "python");
  assert.deepEqual(log[0]!.args.slice(0, 3), ["-m", "edge_tts", "--voice"]);
  assert.ok(log[0]!.args.includes("zh-CN-XiaoxiaoNeural"));
  assert.ok(log[0]!.args.includes("--rate=+5%"));
  assert.ok(log[0]!.args.includes("--pitch=+20Hz"));
});

test("too-small sovits output is rejected and edge-tts is used", async () => {
  const f = fakeFetch(() => new Response(bytes(100)));
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(3000) });

  const r = await synthesize("太短了");
  assert.ok(r);
  assert.equal(r.backend, "edge");
  const files = await readdir(process.env.VOICE_CACHE_DIR!);
  assert.ok(!files.some((n) => n.endsWith(".wav")), "stub was not cached");
  assert.ok(!files.some((n) => n.endsWith(".tmp")), "no temp files left behind");
});

test("everything down returns null; FISHD_VOICE_BACKEND=off skips all work", async () => {
  const f = fakeFetch(() => new Response(bytes(10)), false);
  restore = setSpeakDeps({ fetch: f.fetch, run: async () => {
    throw new Error("edge-tts missing");
  } });
  assert.equal(await synthesize("都挂了"), null);

  process.env.FISHD_VOICE_BACKEND = "off";
  const before = f.calls.length;
  assert.equal(await synthesize("关闭"), null);
  assert.equal(f.calls.length, before);
});

test("edge-only mode never contacts sovits", async () => {
  process.env.FISHD_VOICE_BACKEND = "edge";
  const f = fakeFetch(() => new Response(bytes(60_000)));
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(3000) });
  const r = await synthesize("只用边缘");
  assert.equal(r?.backend, "edge");
  assert.equal(f.calls.length, 0);
});

test("text cleaning strips markdown, emoji and kaomoji but keeps words and CJK brackets", () => {
  assert.equal(cleanText("**你好**，[点这里](https://x.y) 😊 `code` (^_^) 好的（OK）"), "你好，点这里 code 好的（OK）");
  assert.equal(cleanText("a\n```js\nconst x = 1\n```\nb"), "a b");
  assert.equal(cleanText("# 标题\n- 一\n- 二"), "标题 一 二");
  assert.equal(cleanText("看 ![图](a.png) 和 (｡･ω･｡) 完"), "看 和 完");
  assert.equal(cleanText("  ✨✨  "), "");
});

test("truncation cuts at the last sentence boundary, else hard-cuts to the cap", () => {
  const long = "甲".repeat(150) + "。" + "乙".repeat(100);
  const cut = truncateText(long);
  assert.equal(cut, "甲".repeat(150) + "。");
  assert.ok([...cut].length <= 200);

  assert.equal([...truncateText("a".repeat(300))].length, 200);
  assert.equal(truncateText("短句。"), "短句。");
});

test("calls are serialised: no overlap and results come back in order", async () => {
  const events: string[] = [];
  const f = fakeFetch(async (init) => {
    const text = JSON.parse(String(init?.body)).text as string;
    events.push(`start:${text}`);
    await new Promise((r) => setTimeout(r, 25));
    events.push(`end:${text}`);
    return new Response(bytes(60_000));
  });
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(0) });

  const results = await Promise.all(["一", "二", "三"].map((t) => synthesize(t)));
  assert.deepEqual(events, ["start:一", "end:一", "start:二", "end:二", "start:三", "end:三"]);
  assert.deepEqual(results.map((r) => r?.backend), ["sovits", "sovits", "sovits"]);
});

test("abort during sovits synthesis rejects and does not fall back to edge-tts", async () => {
  const ac = new AbortController();
  const f = fakeFetch((init) => new Promise<Response>((_, reject) => {
    init?.signal?.addEventListener("abort", () => reject(init.signal!.reason), { once: true });
  }));
  let ran = 0;
  restore = setSpeakDeps({ fetch: f.fetch, run: async (...a) => {
    ran++;
    return fakeRun(3000)(...a);
  } });

  const pending = synthesize("会被取消", { signal: ac.signal });
  setTimeout(() => ac.abort(), 20);
  await assert.rejects(pending, (err: unknown) => (err as Error).name === "AbortError");
  assert.equal(ran, 0);
});

test("aborted before start rejects immediately", async () => {
  const f = fakeFetch(() => new Response(bytes(60_000)));
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(3000) });
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(synthesize("已取消", { signal: ac.signal }), (err: unknown) => (err as Error).name === "AbortError");
  assert.equal(f.calls.length, 0);
});

const hashName = (c: string, ext: string) => `${c.repeat(40)}.${ext}`;

test("pruneCache keeps the newest maxFiles and deletes the rest", async () => {
  const cache = process.env.VOICE_CACHE_DIR!;
  await import("node:fs/promises").then((fs) => fs.mkdir(cache, { recursive: true }));
  // ages in minutes: a=1 (newest) ... e=5 (oldest)
  const ages: Record<string, number> = {
    [hashName("a", "wav")]: 1,
    [hashName("b", "mp3")]: 2,
    [hashName("c", "wav")]: 3,
    [hashName("d", "mp3")]: 4,
    [hashName("e", "wav")]: 5,
  };
  for (const [name, minutes] of Object.entries(ages)) {
    const file = path.join(cache, name);
    await writeFile(file, "x");
    const t = (Date.now() - minutes * 60_000) / 1000;
    await utimes(file, t, t);
  }
  const removed = pruneCache(3, cache);
  assert.equal(removed, 2);
  assert.deepEqual(
    (await readdir(cache)).sort(),
    [hashName("a", "wav"), hashName("b", "mp3"), hashName("c", "wav")].sort(),
  );
});

test("pruneCache never deletes files whose names are not the cache's sha1 names", async () => {
  const cache = process.env.VOICE_CACHE_DIR!;
  await import("node:fs/promises").then((fs) => fs.mkdir(cache, { recursive: true }));
  const foreign = ["song.mp3", "old.wav", hashName("A", "wav"), "f".repeat(41) + ".wav", hashName("b", "wav") + ".bak"];
  for (const name of foreign) {
    const file = path.join(cache, name);
    await writeFile(file, "music");
    const t = (Date.now() - 100 * 3_600_000) / 1000; // oldest of all
    await utimes(file, t, t);
  }
  for (let i = 0; i < 3; i++) {
    const file = path.join(cache, hashName(String(i), "mp3"));
    await writeFile(file, "x");
    const t = (Date.now() - (i + 1) * 60_000) / 1000;
    await utimes(file, t, t);
  }
  assert.equal(pruneCache(1, cache), 2);
  const left = (await readdir(cache)).sort();
  for (const name of foreign) assert.ok(left.includes(name), `${name} must survive`);
  assert.equal(left.filter((n) => /^[0-9a-f]{40}\.(wav|mp3)$/.test(n)).length, 1);
});

test("edge-tts receives --text=<text> as one argv element so a leading dash is not a flag", async () => {
  const f = fakeFetch(() => new Response(bytes(60_000)), false);
  const log: { cmd: string; args: string[] }[] = [];
  restore = setSpeakDeps({ fetch: f.fetch, run: fakeRun(3000, log) });

  const r = await synthesize("-测试一下");
  assert.equal(r?.backend, "edge");
  assert.equal(log.length, 1);
  assert.ok(log[0]!.args.includes("--text=-测试一下"));
  assert.ok(!log[0]!.args.includes("--text"), "no separate --text element");
});
