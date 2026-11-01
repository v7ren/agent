import type { DocInput, Hit } from "./types.ts";
import { tokenize } from "./tokenize.ts";

const K1 = 1.2;
const B = 0.75;
const DEFAULT_LIMIT = 8;
const MAX_WHY = 4;
const DAY_MS = 86_400_000;
/** Recency halves every 30 days, but never drops below the floor. */
const HALF_LIFE_MS = 30 * DAY_MS;
const RECENCY_FLOOR = 0.2;

/** Who said a line and where. Units without tags are visible everywhere. */
export interface UnitTags {
  /** the conversation the line belongs to; "" when unknown */
  room?: string;
  speaker?: string;
  speakerId?: string;
  /** diary and other self-owned content: visible in every room */
  shared?: boolean;
}

/** The conversation a search runs for. */
export interface Scope {
  room: string;
}

export interface SearchOptions {
  scope?: Scope;
  /** epoch ms the recency decay is measured from; defaults to the newest unit */
  now?: number;
  /** most hits to return from one file; 1 by default, more when a day holds several moments */
  perFile?: number;
}

/** Maps a raw line (by 0-based index) to its tags. */
export type LineTagger = (lineIndex: number, raw: string) => UnitTags | undefined;

interface Unit {
  key: string;
  path: string;
  line: number;
  mtime: number;
  length: number;
  counts: Map<string, number>;
  tags?: UnitTags;
}

interface SerializedUnit {
  line: number;
  length: number;
  counts: Record<string, number>;
  tags?: UnitTags;
}

interface SerializedDoc {
  path: string;
  mtime: number;
  units: SerializedUnit[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function comparePath(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function visible(unit: Unit, scope: Scope | undefined): boolean {
  if (scope === undefined) return true;
  const tags = unit.tags;
  if (tags === undefined || tags.shared === true) return true;
  return (tags.room ?? "") === scope.room;
}

function recencyWeight(mtime: number, reference: number): number {
  const ageMs = Math.max(0, reference - mtime);
  return RECENCY_FLOOR + (1 - RECENCY_FLOOR) * Math.pow(2, -ageMs / HALF_LIFE_MS);
}

function readTags(value: unknown): UnitTags | undefined {
  if (!isRecord(value)) return undefined;
  const tags: UnitTags = {};
  if (typeof value["room"] === "string") tags.room = value["room"];
  if (typeof value["speaker"] === "string") tags.speaker = value["speaker"];
  if (typeof value["speakerId"] === "string") tags.speakerId = value["speakerId"];
  if (value["shared"] === true) tags.shared = true;
  return Object.keys(tags).length === 0 ? undefined : tags;
}

export class MemoryIndex {
  private readonly docs = new Map<string, number>();
  private readonly units = new Map<string, Unit>();
  private readonly byPath = new Map<string, string[]>();
  private readonly postings = new Map<string, Set<string>>();
  private totalLength = 0;

  add(doc: DocInput, tagger?: LineTagger): void {
    this.remove(doc.path);
    this.docs.set(doc.path, doc.mtime);
    this.byPath.set(doc.path, []);

    const lines = doc.text.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      const raw = lines[i];
      if (raw === undefined) continue;
      const text = raw.trim();
      if (text.length === 0) continue;
      const tokens = tokenize(text);
      const counts = new Map<string, number>();
      for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);
      this.insertUnit(doc.path, i + 1, doc.mtime, tokens.length, counts, tagger?.(i, raw));
    }
  }

  /**
   * Index a single appended line without re-reading the whole file. The
   * journal grows on every message, so a full re-scan per line is the one
   * thing that would not scale.
   */
  appendLine(path: string, line: number, text: string, mtime: number, tags?: UnitTags): void {
    const trimmed = text.trim();
    if (trimmed === "") return;

    const key = `${path}:${line}`;
    this.dropUnit(key);

    const tokens = tokenize(trimmed);
    if (tokens.length === 0) return;

    const counts = new Map<string, number>();
    for (const token of tokens) counts.set(token, (counts.get(token) ?? 0) + 1);

    this.docs.set(path, mtime);
    this.insertUnit(path, line, mtime, tokens.length, counts, tags);
  }

  private dropUnit(key: string): void {
    const unit = this.units.get(key);
    if (unit === undefined) return;

    this.totalLength -= unit.length;
    for (const token of unit.counts.keys()) {
      const posting = this.postings.get(token);
      if (posting === undefined) continue;
      posting.delete(key);
      if (posting.size === 0) this.postings.delete(token);
    }
    this.units.delete(key);

    const keys = this.byPath.get(unit.path);
    if (keys) {
      const at = keys.indexOf(key);
      if (at !== -1) keys.splice(at, 1);
    }
  }

  remove(path: string): void {
    const keys = this.byPath.get(path);
    if (keys === undefined) return;
    for (const key of keys) {
      const unit = this.units.get(key);
      if (unit === undefined) continue;
      this.totalLength -= unit.length;
      for (const token of unit.counts.keys()) {
        const posting = this.postings.get(token);
        if (posting === undefined) continue;
        posting.delete(key);
        if (posting.size === 0) this.postings.delete(token);
      }
      this.units.delete(key);
    }
    this.byPath.delete(path);
    this.docs.delete(path);
  }

  /**
   * BM25 with a half-life recency weight. At most one hit per file (a day's
   * journal, a diary entry), so one busy day cannot fill the whole result.
   */
  search(query: string, limit: number = DEFAULT_LIMIT, opts: SearchOptions = {}): Hit[] {
    const queryTokens = tokenize(query);
    if (queryTokens.length === 0) return [];

    const unitCount = this.units.size;
    if (unitCount === 0) return [];

    const wanted = Math.floor(limit);
    if (!(wanted > 0)) return [];

    const avgLength = this.totalLength > 0 ? this.totalLength / unitCount : 1;

    let newest = -Infinity;
    for (const unit of this.units.values()) {
      if (unit.mtime > newest) newest = unit.mtime;
    }
    const reference = opts.now ?? newest;

    const hits: Hit[] = [];
    for (const unit of this.units.values()) {
      if (!visible(unit, opts.scope)) continue;

      let score = 0;
      const matched: string[] = [];

      for (const token of queryTokens) {
        const tf = unit.counts.get(token);
        if (tf === undefined || tf <= 0) continue;
        const df = this.postings.get(token)?.size ?? 0;
        if (df === 0) continue;
        const idf = Math.log(1 + (unitCount - df + 0.5) / (df + 0.5));
        const norm = 1 - B + (B * unit.length) / avgLength;
        score += idf * ((tf * (K1 + 1)) / (tf + K1 * norm));
        matched.push(token);
      }

      if (score <= 0) continue;

      hits.push({
        path: unit.path,
        line: unit.line,
        score: score * recencyWeight(unit.mtime, reference),
        why: `matched: ${matched.slice(0, MAX_WHY).join(" ")}`,
      });
    }

    hits.sort((a, b) => b.score - a.score || comparePath(a.path, b.path) || a.line - b.line);

    const out: Hit[] = [];
    const perFile = Math.max(1, Math.floor(opts.perFile ?? 1));
    const seenPaths = new Map<string, number>();
    for (const hit of hits) {
      const used = seenPaths.get(hit.path) ?? 0;
      if (used >= perFile) continue;
      seenPaths.set(hit.path, used + 1);
      out.push(hit);
      if (out.length >= wanted) break;
    }
    return out;
  }

  get docCount(): number {
    return this.docs.size;
  }

  toJSON(): unknown {
    const docs: SerializedDoc[] = [];
    for (const [path, mtime] of this.docs) {
      const keys = this.byPath.get(path) ?? [];
      const sorted = [...keys].sort(
        (a, b) => (this.units.get(a)?.line ?? 0) - (this.units.get(b)?.line ?? 0),
      );
      const units: SerializedUnit[] = [];
      for (const key of sorted) {
        const unit = this.units.get(key);
        if (unit === undefined) continue;
        const entry: SerializedUnit = {
          line: unit.line,
          length: unit.length,
          counts: Object.fromEntries(unit.counts),
        };
        if (unit.tags !== undefined) entry.tags = unit.tags;
        units.push(entry);
      }
      docs.push({ path, mtime, units });
    }
    return { version: 1, docs };
  }

  static fromJSON(value: unknown): MemoryIndex {
    const index = new MemoryIndex();
    if (!isRecord(value)) return index;
    const rawDocs = value["docs"];
    if (!Array.isArray(rawDocs)) return index;

    for (const rawDoc of rawDocs) {
      if (!isRecord(rawDoc)) continue;
      const path = rawDoc["path"];
      if (typeof path !== "string") continue;
      const mtimeRaw = rawDoc["mtime"];
      const mtime = typeof mtimeRaw === "number" && Number.isFinite(mtimeRaw) ? mtimeRaw : 0;

      if (!index.docs.has(path)) {
        index.docs.set(path, mtime);
        index.byPath.set(path, []);
      }

      const rawUnits = rawDoc["units"];
      if (!Array.isArray(rawUnits)) continue;
      for (const rawUnit of rawUnits) {
        if (!isRecord(rawUnit)) continue;
        const lineRaw = rawUnit["line"];
        const line = typeof lineRaw === "number" ? lineRaw : 0;

        const counts = new Map<string, number>();
        let sum = 0;
        const rawCounts = rawUnit["counts"];
        if (isRecord(rawCounts)) {
          for (const [token, count] of Object.entries(rawCounts)) {
            if (typeof count !== "number" || !Number.isFinite(count) || count <= 0) continue;
            counts.set(token, count);
            sum += count;
          }
        }

        const lengthRaw = rawUnit["length"];
        const length =
          typeof lengthRaw === "number" && Number.isFinite(lengthRaw) && lengthRaw >= 0
            ? lengthRaw
            : sum;

        if (index.units.has(`${path}:${line}`)) continue;
        index.insertUnit(path, line, mtime, length, counts, readTags(rawUnit["tags"]));
      }
    }

    return index;
  }

  private insertUnit(
    path: string,
    line: number,
    mtime: number,
    length: number,
    counts: Map<string, number>,
    tags?: UnitTags,
  ): void {
    const key = `${path}:${line}`;
    const unit: Unit = { key, path, line, mtime, length, counts };
    if (tags !== undefined) unit.tags = tags;
    this.units.set(key, unit);

    const keys = this.byPath.get(path);
    if (keys === undefined) this.byPath.set(path, [key]);
    else keys.push(key);

    for (const token of counts.keys()) {
      const posting = this.postings.get(token);
      if (posting === undefined) this.postings.set(token, new Set([key]));
      else posting.add(key);
    }

    this.totalLength += length;
  }
}
