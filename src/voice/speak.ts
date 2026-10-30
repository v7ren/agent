// Speech synthesis: local GPT-SoVITS first, edge-tts fallback, sha1-keyed cache.
// Port of mcp-speak/server.mjs. Network and process spawning are injectable (setSpeakDeps)
// so tests run without a server or python.
import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { readdirSync, statSync, unlinkSync } from "node:fs";
import { mkdir, readFile, rename, stat, unlink, utimes, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

export type Backend = "sovits" | "edge";
export type SpeakResult = { path: string; backend: Backend; bytes: number };
export type FetchLike = (url: string, init?: RequestInit) => Promise<Response>;
export type RunLike = (
  cmd: string,
  args: string[],
  opts: { signal?: AbortSignal; timeoutMs: number },
) => Promise<void>;

const here = path.dirname(fileURLToPath(import.meta.url));
const DEFAULT_CACHE_DIR = path.resolve(here, "..", "..", "vault", "voice-cache");
const DEFAULT_REF = "D:\\work2\\research\\fish_cute_pack\\voice_ref\\ref.wav";
const DEFAULT_REF_TXT = "D:\\work2\\research\\fish_cute_pack\\voice_ref\\ref.txt";
const EDGE_VOICE = "zh-CN-XiaoxiaoNeural";
const DEFAULT_TONE = "softcute";
const MAX_CHARS = 200;
const SOVITS_MIN_BYTES = 50_000;
const BACKEND_MODES = ["auto", "sovits", "edge", "off"] as const;
const CACHE_FILE_NAME = /^[0-9a-f]{40}\.(wav|mp3)$/;
type Mode = (typeof BACKEND_MODES)[number];

// Numeric prosody only; the voice is fixed to EDGE_VOICE.
const PROSODY: Record<string, { rate: string; pitch: string }> = {
  softcute: { rate: "+5%", pitch: "+20Hz" },
  playful: { rate: "+10%", pitch: "+25Hz" },
  healing: { rate: "0%", pitch: "+12Hz" },
  energetic: { rate: "+15%", pitch: "+30Hz" },
  whisper: { rate: "-8%", pitch: "+5Hz" },
};

function config() {
  const env = process.env;
  const rawMode = (env.FISHD_VOICE_BACKEND ?? "auto").trim().toLowerCase();
  const mode: Mode = (BACKEND_MODES as readonly string[]).includes(rawMode) ? (rawMode as Mode) : "auto";
  return {
    url: env.SOVITS_URL || "http://127.0.0.1:9880",
    ref: env.SOVITS_REF || DEFAULT_REF,
    refTxt: env.SOVITS_REF_TXT || DEFAULT_REF_TXT,
    cacheDir: env.VOICE_CACHE_DIR || DEFAULT_CACHE_DIR,
    mode,
  };
}

function defaultRun(cmd: string, args: string[], opts: { signal?: AbortSignal; timeoutMs: number }): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const child = spawn(cmd, args, { windowsHide: true, stdio: ["ignore", "ignore", "pipe"] });
    let stderr = "";
    child.stderr?.on("data", (d: Buffer) => {
      stderr = (stderr + d.toString()).slice(-2000);
    });
    const timer = setTimeout(() => child.kill(), opts.timeoutMs);
    const onAbort = () => child.kill();
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    const done = () => {
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
    };
    child.once("error", (e) => {
      done();
      reject(e);
    });
    child.once("close", (code, signal) => {
      done();
      if (opts.signal?.aborted) reject(opts.signal.reason);
      else if (code === 0) resolve();
      else {
        const tail = stderr.trim().split("\n").slice(-3).join(" | ");
        reject(new Error(`${cmd} exited ${code ?? signal}: ${tail}`));
      }
    });
  });
}

let deps: { fetch: FetchLike; run: RunLike } = {
  fetch: (url, init) => fetch(url, init),
  run: defaultRun,
};

/** Replace the fetch / process runner (tests). Returns a restore function. */
export function setSpeakDeps(d: Partial<{ fetch: FetchLike; run: RunLike }>): () => void {
  const prev = deps;
  deps = { ...deps, ...d };
  return () => {
    deps = prev;
  };
}

function anySignal(signal: AbortSignal | undefined, ms: number): AbortSignal {
  const timeout = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

/** Probe the SoVITS server. Any HTTP answer counts as up. */
export async function sovitsUp(signal?: AbortSignal): Promise<boolean> {
  try {
    await deps.fetch(`${config().url}/docs`, { signal: anySignal(signal, 1500) });
    return true;
  } catch {
    return false;
  }
}

// Strips markdown and emoji, then kaomoji-like bracket groups (no CJK, no words, no digits).
export function cleanText(input: string): string {
  let s = input.normalize("NFC");
  s = s.replace(/```[\s\S]*?```/g, " ");
  s = s.replace(/`([^`]*)`/g, "$1");
  s = s.replace(/!\[[^\]]*\]\([^)]*\)/g, " ");
  s = s.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
  s = s.replace(/https?:\/\/\S+/g, " ");
  s = s.replace(/^\s{0,3}#{1,6}\s+/gm, "");
  s = s.replace(/^\s*>\s?/gm, "");
  s = s.replace(/^\s*(?:[-*+]|\d+[.)])\s+/gm, "");
  s = s.replace(/^\s*(?:[-*_]\s*){3,}$/gm, " ");
  s = s.replace(/\*\*(.+?)\*\*/g, "$1");
  s = s.replace(/__(.+?)__/g, "$1");
  s = s.replace(/~~(.+?)~~/g, "$1");
  s = s.replace(/(^|[^\w*])\*(?!\s)(.+?)\*/g, "$1$2");
  s = s.replace(/[*|`]/g, " ");
  s = s.replace(/[\p{Extended_Pictographic}\p{Emoji_Presentation}\p{Regional_Indicator}\u200d\ufe0f\u20e3]/gu, " ");
  s = s.replace(/[(（[【]([^()（）[\]【】\n]{1,16})[)）\]】]/g, (m, inner: string) =>
    /[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}]/u.test(inner) || /[A-Za-z]{2,}|\d/.test(inner) ? m : " ",
  );
  return s.replace(/\s+/g, " ").trim();
}

// Cuts to max characters at the last sentence boundary, if it falls in the back 60% of the window.
export function truncateText(s: string, max = MAX_CHARS): string {
  const chars = [...s];
  if (chars.length <= max) return s;
  const head = chars.slice(0, max).join("");
  let cut = -1;
  for (const m of head.matchAll(/[。！？!?…；;\n]/g)) cut = m.index;
  if (cut >= Math.floor(max * 0.4)) return head.slice(0, cut + 1);
  return head.trimEnd();
}

function cacheKey(text: string, tone: string, backend: Backend): string {
  return createHash("sha1").update([text, tone, backend].join("|")).digest("hex");
}

function cacheFile(dir: string, key: string, backend: Backend): string {
  return path.join(dir, `${key}.${backend === "sovits" ? "wav" : "mp3"}`);
}

async function cacheLookup(dir: string, key: string, backend: Backend): Promise<SpeakResult | null> {
  const file = cacheFile(dir, key, backend);
  try {
    const s = await stat(file);
    if (s.size > 0) {
      const now = new Date();
      await utimes(file, now, now).catch(() => undefined); // touch so pruning is LRU-ish
      return { path: file, backend, bytes: s.size };
    }
  } catch {
    /* miss */
  }
  return null;
}

async function sovitsSynth(text: string, outFile: string, signal?: AbortSignal): Promise<number> {
  const c = config();
  const promptText = (await readFile(c.refTxt, "utf8")).trim();
  const res = await deps.fetch(`${c.url}/tts`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      text,
      text_lang: "zh",
      ref_audio_path: path.resolve(c.ref),
      prompt_text: promptText,
      prompt_lang: "zh",
      text_split_method: "cut5",
      media_type: "wav",
      streaming_mode: false,
      speed_factor: 1.0,
      temperature: 0.8,
      top_k: 15,
      sample_steps: 32,
    }),
    signal: anySignal(signal, 150_000),
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`SoVITS HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const buf = new Uint8Array(await res.arrayBuffer());
  if (buf.length < SOVITS_MIN_BYTES) throw new Error(`SoVITS returned a stub (${buf.length} bytes)`);
  await writeAtomic(outFile, buf);
  return buf.length;
}

async function edgeSynth(text: string, tone: string, outFile: string, signal?: AbortSignal): Promise<number> {
  const p = PROSODY[tone] ?? PROSODY[DEFAULT_TONE]!;
  const tmp = `${outFile}.tmp`;
  try {
    await deps.run(
      "python",
      ["-m", "edge_tts", "--voice", EDGE_VOICE, `--rate=${p.rate}`, `--pitch=${p.pitch}`, `--text=${text}`, "--write-media", tmp],
      { signal, timeoutMs: 60_000 },
    );
    const size = (await stat(tmp)).size;
    if (size === 0) throw new Error("edge-tts produced an empty file");
    await rename(tmp, outFile);
    return size;
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

async function writeAtomic(file: string, data: Uint8Array): Promise<void> {
  const tmp = `${file}.tmp`;
  try {
    await writeFile(tmp, data);
    await rename(tmp, file);
  } catch (err) {
    await unlink(tmp).catch(() => undefined);
    throw err;
  }
}

// One synthesis at a time: each call waits for the previous one to settle.
let queue: Promise<unknown> = Promise.resolve();
function serialise<T>(task: () => Promise<T>): Promise<T> {
  const next = queue.then(task);
  queue = next.catch(() => undefined);
  return next;
}

/**
 * Synthesize speech for text. Returns null when disabled or every backend failed.
 * Throws an AbortError when opts.signal aborts.
 */
export async function synthesize(
  text: string,
  opts: { tone?: string; signal?: AbortSignal } = {},
): Promise<SpeakResult | null> {
  return serialise(async () => {
    opts.signal?.throwIfAborted();
    const spoken = truncateText(cleanText(text), MAX_CHARS);
    if (!spoken) return null;
    const c = config();
    if (c.mode === "off") return null;
    const tone = opts.tone && Object.hasOwn(PROSODY, opts.tone) ? opts.tone : DEFAULT_TONE;
    const order: Backend[] = c.mode === "auto" ? ["sovits", "edge"] : [c.mode];

    await mkdir(c.cacheDir, { recursive: true });
    for (const b of order) {
      const hit = await cacheLookup(c.cacheDir, cacheKey(spoken, tone, b), b);
      if (hit) return hit;
    }

    for (const b of order) {
      opts.signal?.throwIfAborted();
      const file = cacheFile(c.cacheDir, cacheKey(spoken, tone, b), b);
      try {
        let bytes: number;
        if (b === "sovits") {
          if (!(await sovitsUp(opts.signal))) continue;
          bytes = await sovitsSynth(spoken, file, opts.signal);
        } else {
          bytes = await edgeSynth(spoken, tone, file, opts.signal);
        }
        pruneCache(200, c.cacheDir);
        return { path: file, backend: b, bytes };
      } catch (err) {
        if (opts.signal?.aborted) throw err;
        console.warn(`[speak] ${b} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
    return null;
  });
}

/**
 * Delete the oldest cache files beyond maxFiles. Only files named like the cache's
 * own sha1 keys are considered; anything else in the directory is left alone.
 * Returns the number removed.
 */
export function pruneCache(maxFiles = 200, dir: string = config().cacheDir): number {
  let entries: { file: string; mtime: number }[];
  try {
    entries = readdirSync(dir)
      .filter((f) => CACHE_FILE_NAME.test(f))
      .map((f) => {
        const file = path.join(dir, f);
        return { file, mtime: statSync(file).mtimeMs };
      });
  } catch {
    return 0;
  }
  if (entries.length <= maxFiles) return 0;
  entries.sort((a, b) => b.mtime - a.mtime);
  let removed = 0;
  for (const e of entries.slice(maxFiles)) {
    try {
      unlinkSync(e.file);
      removed++;
    } catch {
      /* already gone */
    }
  }
  return removed;
}
