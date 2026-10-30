import { createHash, randomBytes } from "node:crypto";
import { mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { Block } from "../types.ts";
import { safeScope } from "./checkpoint.ts";

export type SavedMsg = { role: "user" | "assistant"; content: string; at: number };
export type SavedHistory = {
  v: 1;
  key: string;
  savedAt: string;
  checkpointIndex: number;
  messages: SavedMsg[];
};

/** Per-message content cap, in UTF-16 units. */
export const MAX_MSG_CHARS = 20000;
/** Total content cap across all saved messages. */
export const MAX_TOTAL_CHARS = 600000;
/** Maximum length of a history file name, without the .json suffix. */
const MAX_NAME = 60;
const RESERVED_WIN = /^(con|prn|aux|nul|com[1-9]|lpt[1-9])$/i;

function shortHash(s: string): string {
  return createHash("sha1").update(s, "utf8").digest("hex").slice(0, 8);
}

function isObj(x: unknown): x is Record<string, unknown> {
  return typeof x === "object" && x !== null && !Array.isArray(x);
}

function finiteInt(x: unknown): number {
  return typeof x === "number" && Number.isFinite(x) ? Math.max(0, Math.trunc(x)) : 0;
}

/**
 * File stem for a key. safeScope already hashes non-ASCII keys; ASCII keys it
 * had to rewrite (Windows-unsafe characters, empty, too long) get a hash too,
 * so 'a:b' and 'a_b' never share a file. Windows device names are suffixed.
 */
function historyName(key: string): string {
  const base = safeScope(key);
  const ascii = !/[^\x00-\x7f]/.test(key);
  let name = ascii && base !== key ? `${base.slice(0, 40)}-${shortHash(key)}` : base;
  if (RESERVED_WIN.test(name)) name = `${name}-${shortHash(key)}`;
  return name.slice(0, MAX_NAME);
}

/** Where a conversation history lives: <stateDir>/history/<safe name>.json */
export function historyPath(stateDir: string, key: string): string {
  return join(stateDir, "history", `${historyName(key)}.json`);
}

/** Truncate to the cap without splitting a surrogate pair. */
function clip(s: string): string {
  if (s.length <= MAX_MSG_CHARS) return s;
  let cut = MAX_MSG_CHARS;
  const last = s.charCodeAt(cut - 1);
  if (last >= 0xd800 && last <= 0xdbff) cut -= 1;
  return s.slice(0, cut);
}

/**
 * Apply the caps: clip each message, drop the oldest until the total fits,
 * then drop leading assistant messages so the history opens with the user.
 */
function capMessages(msgs: SavedMsg[]): SavedMsg[] {
  const out: SavedMsg[] = msgs.map((m) => ({
    role: m.role,
    content: clip(m.content),
    at: Number.isFinite(m.at) ? m.at : 0,
  }));
  let total = 0;
  for (const m of out) total += m.content.length;

  let start = 0;
  let head: SavedMsg | undefined;
  while ((head = out[start]) !== undefined && total > MAX_TOTAL_CHARS) {
    total -= head.content.length;
    start++;
  }
  while ((head = out[start]) !== undefined && head.role === "assistant") {
    total -= head.content.length;
    start++;
  }
  return out.slice(start);
}

/**
 * Write the history atomically (temp file, then rename). Sync and never throws:
 * a failed save leaves the previous file in place.
 */
export function saveHistory(path: string, data: SavedHistory): void {
  let tmp = "";
  try {
    const doc: SavedHistory = {
      v: 1,
      key: data.key,
      savedAt: data.savedAt,
      checkpointIndex: finiteInt(data.checkpointIndex),
      messages: capMessages(data.messages),
    };
    mkdirSync(dirname(path), { recursive: true });
    tmp = `${path}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
    writeFileSync(tmp, JSON.stringify(doc), "utf8");
    renameSync(tmp, path);
  } catch {
    try {
      if (tmp) rmSync(tmp, { force: true });
    } catch {
      // nothing more to do
    }
  }
}

/**
 * Read a saved history. Missing, corrupt or wrong-version files give null.
 * Invalid messages are dropped, and the result always opens with a user turn.
 */
export function loadHistory(path: string): SavedHistory | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!isObj(raw) || raw.v !== 1 || typeof raw.key !== "string") return null;

    const list = Array.isArray(raw.messages) ? raw.messages : [];
    const msgs: SavedMsg[] = [];
    for (const item of list) {
      if (!isObj(item)) continue;
      const role = item.role;
      const content = item.content;
      if (role !== "user" && role !== "assistant") continue;
      if (typeof content !== "string" || content.trim() === "") continue;
      const at = typeof item.at === "number" && Number.isFinite(item.at) ? item.at : 0;
      msgs.push({ role, content, at });
    }

    const messages = capMessages(msgs);
    if (messages.length === 0) return null;

    return {
      v: 1,
      key: raw.key,
      savedAt: typeof raw.savedAt === "string" ? raw.savedAt : new Date(0).toISOString(),
      checkpointIndex: finiteInt(raw.checkpointIndex),
      messages,
    };
  } catch {
    return null;
  }
}

/** Body of a checkpoint file: no frontmatter, no trailing links section. */
function readBody(file: string): string {
  try {
    let text = readFileSync(file, "utf8").replace(/\r\n?/g, "\n");
    const fm = /^---\n[\s\S]*?\n---[ \t]*(?:\n|$)/.exec(text);
    if (fm) text = text.slice(fm[0].length);
    const lines = text.split("\n");
    const cut = lines.findIndex((l) => l.startsWith("## 關聯"));
    const kept = cut === -1 ? lines : lines.slice(0, cut);
    return kept.join("\n").trim();
  } catch {
    return "";
  }
}

/**
 * Load the newest checkpoints for a scope as prompt blocks. Only the last
 * `maxBlocks` non-empty ones are kept. maxIndex is the highest number on disk.
 */
export function loadChain(
  root: string,
  scope: string,
  maxBlocks = 12,
): { blocks: Block[]; maxIndex: number } {
  const dir = join(root, "sessions", safeScope(scope));
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return { blocks: [], maxIndex: 0 };
  }

  const seen = new Set<number>();
  const found: { n: number; name: string }[] = [];
  for (const name of names) {
    const m = /^cp-(\d+)\.md$/.exec(name);
    if (!m) continue;
    const n = Number(m[1]);
    if (seen.has(n)) continue;
    seen.add(n);
    found.push({ n, name });
  }

  let maxIndex = 0;
  for (const f of found) maxIndex = Math.max(maxIndex, f.n);
  found.sort((a, b) => a.n - b.n);

  const blocks: Block[] = [];
  for (const f of found) {
    const body = readBody(join(dir, f.name));
    if (body === "") continue;
    blocks.push({
      id: `cp-${f.n}`,
      volatility: 2,
      content: `<checkpoint n="${f.n}">\n${body}\n</checkpoint>`,
    });
  }

  const keep = Number.isFinite(maxBlocks) ? Math.max(0, Math.trunc(maxBlocks)) : 12;
  return { blocks: blocks.slice(Math.max(0, blocks.length - keep)), maxIndex };
}
