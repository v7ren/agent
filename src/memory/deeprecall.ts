import type { Hit } from "./types.ts";
import type { Scope } from "./index.ts";
import { keywordQuery } from "./tokenize.ts";

/** What recall needs from her memory: find, then read around the find. */
export interface RecallSource {
  search(query: string, limit?: number, scope?: Scope, perFile?: number): Hit[];
  open(path: string, fromLine?: number, count?: number, scope?: Scope): string;
}

const ASKS =
  /(記得|還記|記不記得|有印象|想得起來|之前|上次|那時候|那次|剛才|剛剛|說過|講過|問過|答應過|許了|交代過|告訴過)/;
const QUESTION = /(嗎|呢|什麼|甚麼|哪|誰|怎麼|多少|幾|\?|？)/;

/** "Do you remember what I said about…" asks for facts she must look up, not guess. */
export function looksLikeMemoryQuestion(text: string): boolean {
  const t = text.trim();
  return t.length >= 4 && t.length <= 200 && ASKS.test(t) && QUESTION.test(t);
}

/** A short label for where a line came from, so she can tell old from recent. */
export function sourceLabel(path: string): string {
  const day = /(\d{4})-(\d{2})-(\d{2})/.exec(path);
  const md = day ? `${day[2]}-${day[3]}` : "";
  if (path.startsWith("journal/")) return md;
  if (path.startsWith("diary/")) return `日記 ${md}`;
  if (path.startsWith("sessions/")) return "整理過的摘要";
  if (path.startsWith("nodes/people/")) return "人物筆記";
  return path.split("/").pop() ?? path;
}

/** Turn raw vault lines into something she can read: no headers, links, or markup. */
export function tidy(raw: string): string {
  return raw
    .split("\n")
    .filter((l) => !/^#\s/.test(l) && !/^（第 \d+ 行起）$/.test(l.trim()))
    .join(" ")
    .replace(/\[\[[^\]|]*\|([^\]]*)\]\]/g, "$1")
    .replace(/\[\[([^\]]*)\]\]/g, "$1")
    .replace(/[<>`]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

/** The hit line with a little before it and a few lines after: the answer is usually next. */
export function excerptFor(
  source: RecallSource,
  hit: Hit,
  scope: Scope | undefined,
  opts: { before?: number; after?: number; maxChars?: number } = {},
): string {
  const before = opts.before ?? 1;
  const after = opts.after ?? 4;
  const from = Math.max(1, hit.line - before);
  let raw = "";
  try {
    raw = source.open(hit.path, from, before + after + 1, scope);
  } catch {
    return "";
  }
  const text = tidy(raw);
  const chars = Array.from(text);
  return chars.length <= (opts.maxChars ?? 240) ? text : `${chars.slice(0, opts.maxChars ?? 240).join("")}…`;
}

/**
 * The words that only make it a question ("你還記得…的時候…嗎") say nothing about
 * what is being asked. Left in, they match every "還記得" line in the journal and
 * push the real subject down the ranking.
 */
const FRAME =
  /(你)?(還)?記(不記)?得|有印象|想得起來|的時候|那時候|時候|來著|甚麼|什麼|怎麼|之前|上次|那次|剛才|剛剛|說過|講過|問過|答應過|交代過|告訴過|我跟你說|跟你說|嗎|呢|\?|？/g;

/** What the question is about, or "" when it is all frame ("你還記得嗎"). */
export function subjectOnly(question: string): string {
  return keywordQuery(question.replace(FRAME, " "));
}

export function questionSubject(question: string): string {
  const stripped = subjectOnly(question);
  return stripped !== "" ? stripped : keywordQuery(question);
}

/** For comparing a question with a line: no mentions, spaces or punctuation. */
function squash(text: string): string {
  return text
    .replace(/@\S+/g, "")
    .replace(/[\s\p{P}\p{S}]+/gu, "")
    .toLowerCase();
}

export interface DeepRecall {
  text: string;
  count: number;
}

/**
 * For "do you remember…" questions: search, then read around each find, so the
 * evidence is already in front of her. Searching for the question's own words
 * misses answers that use other words (a wish list never says "許願"), which is
 * why the lines after the match are included, and why the finds are shown in
 * the order they happened.
 */
export function deepRecall(
  source: RecallSource,
  question: string,
  scope?: Scope,
  opts: { limit?: number; maxChars?: number } = {},
): DeepRecall {
  const query = questionSubject(question);
  if (query === "") return { text: "", count: 0 };

  const limit = opts.limit ?? 5;
  const cap = opts.maxChars ?? 1100;
  let hits: Hit[] = [];
  try {
    // Several moments from one busy day, not just its single best line: the thing
    // she is asked about is often hours before the line that repeats the question.
    hits = source.search(query, limit * 4, scope, 4);
  } catch {
    return { text: "", count: 0 };
  }

  // Best finds first, but two finds a few lines apart are the same moment.
  const chosen: Hit[] = [];
  for (const hit of [...hits].sort((a, b) => b.score - a.score)) {
    if (chosen.length >= limit) break;
    if (chosen.some((c) => c.path === hit.path && Math.abs(c.line - hit.line) <= 4)) continue;
    chosen.push(hit);
  }
  // Then oldest first, so the original event comes before later mentions of it.
  chosen.sort((a, b) => (a.path === b.path ? a.line - b.line : a.path < b.path ? -1 : 1));

  // The question was written into the journal the moment it was asked, and
  // matches itself best. It is not an answer.
  const asked = squash(question);
  const lines: string[] = [];
  let used = 0;
  for (const hit of chosen) {
    const excerpt = excerptFor(source, hit, scope);
    if (excerpt === "") continue;
    if (asked.length >= 6 && squash(excerpt).includes(asked)) continue;
    const label = sourceLabel(hit.path);
    const line = `• ${label ? `[${label}] ` : ""}${excerpt}`;
    if (used + line.length > cap && lines.length > 0) break;
    lines.push(line);
    used += line.length;
  }
  if (lines.length === 0) return { text: "", count: 0 };

  return {
    count: lines.length,
    text:
      "（你剛翻了紀錄，找到這些可能相關的，可能不完整：照紀錄回答；紀錄裡沒有的就說不確定，不要編。）\n" +
      lines.join("\n"),
  };
}
