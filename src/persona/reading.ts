// Cheap guesses about what typed text cannot carry. Every output is a guess,
// phrased as "我猜", and must never be treated as fact.

import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type PacePoint = { at: string; latencyMs: number; length: number };
export type PaceState = { people: Record<string, PacePoint[]> };

const MAX_POINTS = 20;
const MAX_PEOPLE = 50;
const FORBIDDEN_KEYS = new Set(["__proto__", "constructor", "prototype"]);

const GUESS_TAIL = "——這只是猜的，不確定。";

function hint(body: string): string {
  return `（他這句的語氣我猜：${body}${GUESS_TAIL}）`;
}

// ---------------------------------------------------------------- tone

export function toneHint(text: string): string {
  const t = text.trim();
  if (t.length === 0) return "";

  const letters = t.match(/[A-Za-z]/g);
  const allCaps = letters !== null && letters.length >= 3 && !/[a-z]/.test(t);
  if (allCaps || /[幹煩氣爛]/.test(t)) return hint("可能在生氣或煩躁");
  if (/\?{2,}|？{2,}/.test(t)) return hint("疑惑或不耐");
  if (t.includes("💀") || t.includes("😭")) return hint("誇張的情緒");
  if (/[!！]{2,}|哈哈|www|XD|xd|笑死|😂/.test(t)) return hint("很開心");
  if (/[~～]|啦|喔～/.test(t)) return hint("輕鬆撒嬌");
  if (/^(\.{2,}|…+|嗯+|喔+|哦+)$/.test(t)) return hint("冷淡或在想");
  if (t.length <= 3 && !/[\p{P}\p{S}]/u.test(t)) return hint("冷淡或在想");
  return "";
}

// ---------------------------------------------------------------- pace

function isForbidden(personId: string): boolean {
  return FORBIDDEN_KEYS.has(personId) || personId.length === 0;
}

function ownPoints(state: PaceState, personId: string): PacePoint[] | undefined {
  if (isForbidden(personId)) return undefined;
  if (!Object.hasOwn(state.people, personId)) return undefined;
  return state.people[personId];
}

function lastSeenMs(points: PacePoint[]): number {
  const last = points[points.length - 1];
  if (!last) return Number.NEGATIVE_INFINITY;
  const ms = Date.parse(last.at);
  return Number.isNaN(ms) ? Number.NEGATIVE_INFINITY : ms;
}

// Drops the least recently seen people until at most MAX_PEOPLE remain.
function capPeople(people: Record<string, PacePoint[]>): Record<string, PacePoint[]> {
  const keys = Object.keys(people);
  if (keys.length <= MAX_PEOPLE) return people;
  keys.sort((a, b) => lastSeenMs(people[b]!) - lastSeenMs(people[a]!));
  const kept: Record<string, PacePoint[]> = Object.create(null);
  for (const key of keys.slice(0, MAX_PEOPLE)) kept[key] = people[key]!;
  return kept;
}

export function paceAdd(state: PaceState, personId: string, point: PacePoint): PaceState {
  if (FORBIDDEN_KEYS.has(personId)) throw new Error(`reserved person id: ${personId}`);
  if (personId.length === 0) throw new Error("empty person id");

  const people: Record<string, PacePoint[]> = Object.create(null);
  for (const key of Object.keys(state.people)) {
    if (!isForbidden(key)) people[key] = state.people[key]!;
  }
  const previous = ownPoints(state, personId) ?? [];
  people[personId] = [...previous, point].slice(-MAX_POINTS);
  return { people: capPeople(people) };
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? (sorted[mid - 1]! + sorted[mid]!) / 2 : sorted[mid]!;
}

export function paceHint(state: PaceState, personId: string, latest: PacePoint, now: Date): string {
  const earlier = ownPoints(state, personId);
  if (!earlier || earlier.length < 6) return "";

  const medLen = median(earlier.map((p) => p.length));
  const medLat = median(earlier.map((p) => p.latencyMs));

  const shorter = latest.length < 0.4 * medLen;
  const slower = medLat > 0 && latest.latencyMs > 3 * medLat;
  if (shorter || slower) {
    const late = now.getHours() >= 0 && now.getHours() <= 5;
    const reason = late ? "這麼晚了，他可能累了" : "他可能累了或在忙";
    return `（他這幾句比平常短／慢，我猜${reason}——不一定是不想理你。）`;
  }

  const fast = medLat > 0 && latest.latencyMs < 0.5 * medLat;
  if (fast && latest.length > 2 * medLen) {
    return "（他今天回得特別多，我猜他心情不錯或有話想說。）";
  }
  return "";
}

// ---------------------------------------------------------------- persistence

function isPacePoint(value: unknown): value is PacePoint {
  if (typeof value !== "object" || value === null) return false;
  const p = value as Record<string, unknown>;
  return (
    typeof p.at === "string" &&
    typeof p.latencyMs === "number" && Number.isFinite(p.latencyMs) && p.latencyMs >= 0 &&
    typeof p.length === "number" && Number.isFinite(p.length) && p.length >= 0
  );
}

function sanitize(raw: unknown): PaceState {
  const empty: PaceState = { people: Object.create(null) };
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return empty;
  const people = (raw as Record<string, unknown>).people;
  if (typeof people !== "object" || people === null || Array.isArray(people)) return empty;

  const clean: Record<string, PacePoint[]> = Object.create(null);
  for (const key of Object.keys(people)) {
    if (isForbidden(key)) continue;
    const list = (people as Record<string, unknown>)[key];
    if (!Array.isArray(list)) continue;
    const points = list.filter(isPacePoint).slice(-MAX_POINTS);
    if (points.length > 0) clean[key] = points;
  }
  return { people: capPeople(clean) };
}

export function loadPace(path: string): PaceState {
  try {
    return sanitize(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return { people: Object.create(null) };
  }
}

export function savePace(path: string, state: PaceState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(sanitize(state), null, 2), "utf8");
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}
