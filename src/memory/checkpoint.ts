import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Msg, Provider } from "../types.ts";

export interface CheckpointResult {
  rel: string;
  text: string;
  /** the index actually used; may be higher than the requested one */
  index: number;
}

/** Characters per map chunk. */
export const CHUNK_CHARS = 6000;
/** Hard budget per condensation: map calls plus the one reduce call. */
export const MAX_LLM_CALLS = 4;

/**
 * A folder name for a scope. ASCII-only scopes keep their historical name. When
 * any non-ASCII character is present (客廳 and 臥室 would both become 'main'),
 * a short hash of the original is appended so distinct rooms stay distinct.
 */
export function safeScope(scope: string): string {
  const cleaned = scope.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "");
  if (!/[^\x00-\x7f]/.test(scope)) return cleaned.slice(0, 40) || "main";
  const hash = createHash("sha1").update(scope, "utf8").digest("hex").slice(0, 6);
  return `${cleaned.slice(0, 33) || "scope"}-${hash}`;
}

/** Break a single over-long line into code-point-safe pieces of at most `size`. */
function hardSplit(line: string, size: number): string[] {
  const cps = Array.from(line);
  if (cps.length <= size) return [line];
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += size) out.push(cps.slice(i, i + size).join(""));
  return out;
}

/**
 * Pack whole lines into chunks of at most `size` code points. Nothing is
 * dropped: every non-blank line lands in exactly one chunk.
 */
export function chunkText(text: string, size: number): string[] {
  const out: string[] = [];
  let cur = "";
  let curLen = 0;

  for (const line of text.split("\n")) {
    if (line.trim() === "") continue;
    for (const piece of hardSplit(line, size)) {
      const len = Array.from(piece).length;
      const add = cur === "" ? len : len + 1;
      if (cur !== "" && curLen + add > size) {
        out.push(cur);
        cur = piece;
        curLen = len;
      } else {
        cur = cur === "" ? piece : `${cur}\n${piece}`;
        curLen += add;
      }
    }
  }
  if (cur !== "") out.push(cur);
  return out;
}

/**
 * Split text into at most `maxCalls - 1` chunks (one call is reserved for the
 * reduce step). Short text stays one chunk. Long text gets wider chunks rather
 * than being cut, so the whole input is always seen.
 */
export function planChunks(
  text: string,
  size: number = CHUNK_CHARS,
  maxCalls: number = MAX_LLM_CALLS,
): string[] {
  const total = Array.from(text).length;
  if (total === 0) return [];
  if (total <= size) return [text];

  const maxMap = Math.max(1, maxCalls - 1);
  const natural = chunkText(text, size);
  if (natural.length <= maxMap) return natural;

  // Line packing wastes a little room per chunk, so widen gently until it fits.
  let width = Math.ceil(total / maxMap);
  for (let attempt = 0; attempt < 32; attempt++) {
    const wide = chunkText(text, width);
    if (wide.length <= maxMap) return wide;
    width = Math.ceil(width * 1.05);
  }

  // Last resort: fixed slices, which may cut a line but still drop nothing.
  const cps = Array.from(text);
  const fixed = Math.ceil(cps.length / maxMap);
  const out: string[] = [];
  for (let i = 0; i < cps.length; i += fixed) out.push(cps.slice(i, i + fixed).join(""));
  return out;
}

/**
 * Map-reduce condensation. Each chunk is summarised on its own, then one call
 * combines the summaries. A single chunk skips the map step, so the total is
 * never more than MAX_LLM_CALLS.
 */
export async function condense(opts: {
  provider: Provider;
  model?: string;
  text: string;
  mapSystem: string;
  mapMaxTokens?: number;
  reduceSystem: string;
  reduceMaxTokens?: number;
  /** builds the final user turn; `condensed` is true when material is map output */
  reduceUser: (material: string, condensed: boolean) => string;
  chunkChars?: number;
}): Promise<string> {
  const model = opts.model ? { model: opts.model } : {};
  const pieces = planChunks(opts.text, opts.chunkChars ?? CHUNK_CHARS, MAX_LLM_CALLS);
  if (pieces.length === 0) return "";

  const condensed = pieces.length > 1;
  let material = opts.text;

  if (condensed) {
    const maps = await Promise.all(
      pieces.map((piece) =>
        opts.provider.chat({
          messages: [
            { role: "system", content: opts.mapSystem },
            { role: "user", content: piece },
          ],
          maxTokens: opts.mapMaxTokens ?? 300,
          ...model,
        }),
      ),
    );
    material = maps
      .map((r) => r.text.trim())
      .filter((s) => s !== "")
      .join("\n\n");
    if (material === "") return "";
  }

  const res = await opts.provider.chat({
    messages: [
      { role: "system", content: opts.reduceSystem },
      { role: "user", content: opts.reduceUser(material, condensed) },
    ],
    maxTokens: opts.reduceMaxTokens ?? 500,
    ...model,
  });
  return res.text.trim();
}

/**
 * Turn a chunk of a conversation into a compact checkpoint. This is the
 * "epoch boundary": after it, the prompt changes once and then stays stable
 * again, instead of silently dropping detail when the hot window rolls.
 */
export async function writeCheckpoint(opts: {
  root: string;
  scope: string;
  index: number;
  messages: Msg[];
  provider: Provider;
  maxTokens?: number;
}): Promise<CheckpointResult | null> {
  const transcript = opts.messages
    .filter((m) => m.role === "user" || m.role === "assistant")
    .map((m) => `${m.role === "user" ? "對方" : "我"}：${m.content}`)
    .join("\n");

  if (transcript.trim() === "") return null;

  const text = await condense({
    provider: opts.provider,
    text: transcript,
    mapSystem:
      "摘出這段對話的重點：出現的人、發生的事、做過的決定、還沒完成的事、情緒轉折。" +
      "每條一行，用繁體中文，不要客套，不要編造沒發生的事。",
    reduceSystem:
      "把以下對話壓成重點。只保留：出現的人、發生的事、做過的決定、還沒完成的事、情緒轉折。" +
      "最多 5 條，每條一行，用繁體中文。不要客套、不要開場白、不要編造沒發生的事。",
    reduceUser: (material, condensedInput) =>
      condensedInput ? `以下是同一段對話分段的摘要，合併去重後輸出：\n${material}` : material,
    reduceMaxTokens: opts.maxTokens ?? 500,
  });
  if (text === "") return null;

  const scope = safeScope(opts.scope);
  const dir = join(opts.root, "sessions", scope);
  mkdirSync(dir, { recursive: true });

  // The in-memory counter resets on restart; never overwrite an older run.
  let index = Math.max(1, Math.trunc(opts.index));
  try {
    for (const name of readdirSync(dir)) {
      const match = /^cp-(\d+)\.md$/.exec(name);
      if (match) index = Math.max(index, Number(match[1]) + 1);
    }
  } catch {
    // empty or unreadable directory: the requested index is fine
  }

  const rel = `sessions/${scope}/cp-${String(index).padStart(3, "0")}.md`;
  writeFileSync(
    join(opts.root, rel),
    `---\nscope: "${scope}"\nindex: ${index}\ntype: checkpoint\n---\n\n${text}\n`,
    "utf8",
  );

  return { rel, text, index };
}
