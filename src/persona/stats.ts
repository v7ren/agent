import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * A stat is a drive she carries between turns (missing someone, hunger, thirst).
 * Stats are DATA: the companion defines them as JSON rules, and nothing here is
 * ever evaluated as code. This module is pure except for the load/save helpers.
 */

export const MAX_RULES = 12;
export const MAX_NAME_LENGTH = 20;
export const MAX_GAIN_ABS = 200;
export const MAX_VALUE_LIMIT = 1000;
export const MAX_ELAPSED_HOURS = 48;

const NAME_PATTERN = /^[\p{L}\p{N}_ -]+$/u;
const HOUR_MS = 3_600_000;
const QUIET_START_HOUR = 1;
const QUIET_END_HOUR = 6; // quiet window is 01:00 up to, not including, 06:00 local

export type ThresholdAction = "wake" | "reset" | "halve";

export interface StatRule {
  name: string;
  startValue: number;
  gainPerHour: number;
  gainOnUserMessage?: number;
  max: number;
  threshold: number;
  onThreshold: ThresholdAction;
  recordPeak: boolean;
  /** multiplier 0..1 applied to time gain during local hours 01:00-05:59 */
  quietHoursGain?: number;
}

export interface StatsState {
  values: Record<string, number>;
  peaks: Record<string, { value: number; at: string }>;
  lastTickAt: string;
  pendingWake: string[];
}

export interface ParseResult {
  rules: StatRule[];
  errors: string[];
}

const THRESHOLD_ACTIONS: readonly string[] = ["wake", "reset", "halve"];

/** Names that exist on every object; a stat with one of these would read inherited values. */
const RESERVED_NAMES: ReadonlySet<string> = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "hasOwnProperty",
]);

function hasOwn(o: object, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(o, key);
}

/** Own-property read only: never sees Object.prototype members. */
function ownNumber(rec: Record<string, number>, key: string): number | undefined {
  return hasOwn(rec, key) ? rec[key] : undefined;
}

function clamp(n: number, lo: number, hi: number): number {
  return Math.min(hi, Math.max(lo, n));
}

function isFiniteNumber(v: unknown): v is number {
  return typeof v === "number" && Number.isFinite(v);
}

/** Validate untrusted rule data. Invalid rules are dropped with an error; never throws. */
export function parseRules(raw: unknown): ParseResult {
  const rules: StatRule[] = [];
  const errors: string[] = [];

  let list: unknown = raw;
  if (!Array.isArray(list) && typeof raw === "object" && raw !== null && "rules" in raw) {
    list = (raw as { rules: unknown }).rules;
  }
  if (!Array.isArray(list)) {
    errors.push("rules must be an array");
    return { rules, errors };
  }

  const seen = new Set<string>();
  list.forEach((entry: unknown, i: number) => {
    const where = `rule ${i}`;
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      errors.push(`${where}: not an object`);
      return;
    }
    if (rules.length >= MAX_RULES) {
      errors.push(`${where}: over the limit of ${MAX_RULES} rules, dropped`);
      return;
    }
    const e = entry as Record<string, unknown>;

    const name = e.name;
    if (typeof name !== "string" || name.length < 1 || [...name].length > MAX_NAME_LENGTH || !NAME_PATTERN.test(name)) {
      errors.push(`${where}: name must be 1-${MAX_NAME_LENGTH} letters, digits, _, space or hyphen`);
      return;
    }
    if (RESERVED_NAMES.has(name)) {
      errors.push(`${where}: name "${name}" is reserved, dropped`);
      return;
    }
    if (seen.has(name)) {
      errors.push(`${where}: duplicate name "${name}", dropped`);
      return;
    }

    if (!isFiniteNumber(e.max) || e.max <= 0 || e.max > MAX_VALUE_LIMIT) {
      errors.push(`${where} (${name}): max must be in (0, ${MAX_VALUE_LIMIT}]`);
      return;
    }
    const max = e.max;

    if (!isFiniteNumber(e.threshold) || e.threshold <= 0 || e.threshold > max) {
      errors.push(`${where} (${name}): threshold must be in (0, max]`);
      return;
    }

    if (!isFiniteNumber(e.startValue)) {
      errors.push(`${where} (${name}): startValue must be a finite number`);
      return;
    }
    if (!isFiniteNumber(e.gainPerHour)) {
      errors.push(`${where} (${name}): gainPerHour must be a finite number`);
      return;
    }

    let gainOnUserMessage: number | undefined;
    if (e.gainOnUserMessage !== undefined) {
      if (!isFiniteNumber(e.gainOnUserMessage)) {
        errors.push(`${where} (${name}): gainOnUserMessage must be a finite number`);
        return;
      }
      gainOnUserMessage = clamp(e.gainOnUserMessage, -MAX_GAIN_ABS, MAX_GAIN_ABS);
    }

    if (typeof e.onThreshold !== "string" || !THRESHOLD_ACTIONS.includes(e.onThreshold)) {
      errors.push(`${where} (${name}): onThreshold must be wake, reset or halve`);
      return;
    }

    if (e.recordPeak !== undefined && typeof e.recordPeak !== "boolean") {
      errors.push(`${where} (${name}): recordPeak must be a boolean`);
      return;
    }

    let quietHoursGain: number | undefined;
    if (e.quietHoursGain !== undefined) {
      if (!isFiniteNumber(e.quietHoursGain) || e.quietHoursGain < 0 || e.quietHoursGain > 1) {
        errors.push(`${where} (${name}): quietHoursGain must be in [0, 1]`);
        return;
      }
      quietHoursGain = e.quietHoursGain;
    }

    const rule: StatRule = {
      name,
      startValue: clamp(e.startValue, 0, max),
      gainPerHour: clamp(e.gainPerHour, -MAX_GAIN_ABS, MAX_GAIN_ABS),
      max,
      threshold: e.threshold,
      onThreshold: e.onThreshold as ThresholdAction,
      recordPeak: e.recordPeak === true,
    };
    if (gainOnUserMessage !== undefined) rule.gainOnUserMessage = gainOnUserMessage;
    if (quietHoursGain !== undefined) rule.quietHoursGain = quietHoursGain;

    seen.add(name);
    rules.push(rule);
  });

  return { rules, errors };
}

export function defaultRules(): StatRule[] {
  return [
    {
      name: "想你",
      startValue: 0,
      gainPerHour: 4,
      gainOnUserMessage: -10,
      max: 80,
      threshold: 70,
      onThreshold: "wake",
      recordPeak: true,
      quietHoursGain: 0.5,
    },
    {
      name: "餓",
      startValue: 10,
      gainPerHour: 3,
      max: 50,
      threshold: 40,
      onThreshold: "reset",
      recordPeak: false,
      quietHoursGain: 0.3,
    },
    {
      name: "想被摸",
      startValue: 0,
      gainPerHour: 2,
      gainOnUserMessage: 8,
      max: 60,
      threshold: 50,
      onThreshold: "halve",
      recordPeak: true,
    },
  ];
}

export function emptyState(rules: StatRule[], now: Date): StatsState {
  const values: Record<string, number> = {};
  for (const r of rules) values[r.name] = r.startValue;
  return { values, peaks: {}, lastTickAt: now.toISOString(), pendingWake: [] };
}

/** Split [startMs, endMs) into hours spent inside and outside the local quiet window. */
function splitHours(startMs: number, endMs: number): { normal: number; quiet: number } {
  let normal = 0;
  let quiet = 0;
  let t = startMs;
  while (t < endMs) {
    const d = new Date(t);
    const hour = d.getHours();
    const next = new Date(d.getFullYear(), d.getMonth(), d.getDate(), hour + 1).getTime();
    // guard against DST oddities where the computed boundary is not ahead of t
    const segEnd = Math.min(next > t ? next : t + HOUR_MS, endMs);
    const hours = (segEnd - t) / HOUR_MS;
    if (hour >= QUIET_START_HOUR && hour < QUIET_END_HOUR) quiet += hours;
    else normal += hours;
    t = segEnd;
  }
  return { normal, quiet };
}

/**
 * Advance every rule to `now`. Elapsed time is capped at 48h, so a long absence
 * does not saturate every drive in a single jump. `woke` lists rules that
 * crossed their threshold on this tick; a rule already in pendingWake is not
 * reported again until it is acknowledged.
 */
export function tickStats(
  state: StatsState,
  rules: StatRule[],
  now: Date,
  ctx: { userMessages: number },
): { state: StatsState; woke: string[] } {
  const nowMs = now.getTime();
  const lastMs = Date.parse(state.lastTickAt);
  const startMs = Number.isFinite(lastMs) ? Math.min(lastMs, nowMs) : nowMs;
  const endMs = Math.min(nowMs, startMs + MAX_ELAPSED_HOURS * HOUR_MS);
  const { normal, quiet } = splitHours(startMs, endMs);

  const userMessages = isFiniteNumber(ctx.userMessages) ? Math.max(0, Math.floor(ctx.userMessages)) : 0;
  const nowIso = now.toISOString();

  const values: Record<string, number> = {};
  const peaks: Record<string, { value: number; at: string }> = { ...state.peaks };
  const known = new Set(rules.map((r) => r.name));
  const pendingWake = state.pendingWake.filter((n) => known.has(n));
  const woke: string[] = [];

  for (const rule of rules) {
    const prev = ownNumber(state.values, rule.name) ?? rule.startValue;
    const quietMult = rule.quietHoursGain ?? 1;
    let v =
      prev +
      rule.gainPerHour * (normal + quiet * quietMult) +
      (rule.gainOnUserMessage ?? 0) * userMessages;
    v = clamp(v, 0, rule.max);

    if (rule.recordPeak) {
      const p = hasOwn(peaks, rule.name) ? peaks[rule.name] : undefined;
      if (!p || v > p.value) peaks[rule.name] = { value: v, at: nowIso };
    }

    if (v >= rule.threshold) {
      if (rule.onThreshold === "wake") {
        if (!pendingWake.includes(rule.name)) {
          pendingWake.push(rule.name);
          woke.push(rule.name);
        }
      } else if (rule.onThreshold === "reset") {
        v = 0;
        woke.push(rule.name);
      } else {
        v = v / 2;
        woke.push(rule.name);
      }
    }
    values[rule.name] = v;
  }

  return {
    state: { values, peaks, lastTickAt: nowIso, pendingWake },
    woke,
  };
}

/**
 * Clear the named rules from pendingWake. When `rules` is given, the named
 * rules' own reset/halve action is applied as well (wake leaves the value alone).
 */
export function acknowledgeWake(state: StatsState, names: string[], rules: StatRule[] = []): StatsState {
  const ack = new Set(names);
  const pendingWake = state.pendingWake.filter((n) => !ack.has(n));
  const values = { ...state.values };
  for (const rule of rules) {
    if (!ack.has(rule.name) || !state.pendingWake.includes(rule.name)) continue;
    const cur = ownNumber(values, rule.name);
    if (cur === undefined) continue;
    if (rule.onThreshold === "reset") values[rule.name] = 0;
    else if (rule.onThreshold === "halve") values[rule.name] = cur / 2;
  }
  return { ...state, values, pendingWake };
}

/** One compact line for a prompt, e.g. （你的數值：想你 62/80；餓 12/50）. */
export function renderStats(state: StatsState, rules: StatRule[]): string {
  if (rules.length === 0) return "";
  const parts = rules.map((r) => {
    const v = Math.round(ownNumber(state.values, r.name) ?? r.startValue);
    return `${r.name} ${v}/${r.max}`;
  });
  return `（你的數值：${parts.join("；")}）`;
}

function readJson(path: string): unknown {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** Load rules from a JSON file (array, or {rules: [...]}). Missing or corrupt file gives defaults. */
export function loadRules(path: string): StatRule[] {
  const raw = readJson(path);
  if (raw === undefined) return defaultRules();
  const { rules } = parseRules(raw);
  return rules.length > 0 ? rules : defaultRules();
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** Load state from a JSON file. Missing or corrupt fields fall back per field. */
export function loadState(path: string): StatsState {
  const fallback: StatsState = {
    values: {},
    peaks: {},
    lastTickAt: new Date().toISOString(),
    pendingWake: [],
  };
  const raw = readJson(path);
  if (!isRecord(raw)) return fallback;

  const values: Record<string, number> = {};
  if (isRecord(raw.values)) {
    for (const [k, v] of Object.entries(raw.values)) {
      if (!RESERVED_NAMES.has(k) && isFiniteNumber(v)) values[k] = v;
    }
  }
  const peaks: Record<string, { value: number; at: string }> = {};
  if (isRecord(raw.peaks)) {
    for (const [k, p] of Object.entries(raw.peaks)) {
      if (RESERVED_NAMES.has(k)) continue;
      if (isRecord(p) && isFiniteNumber(p.value) && typeof p.at === "string") {
        peaks[k] = { value: p.value, at: p.at };
      }
    }
  }
  const lastTickAt =
    typeof raw.lastTickAt === "string" && Number.isFinite(Date.parse(raw.lastTickAt))
      ? raw.lastTickAt
      : fallback.lastTickAt;
  const pendingWake = Array.isArray(raw.pendingWake)
    ? raw.pendingWake.filter((n): n is string => typeof n === "string")
    : [];

  return { values, peaks, lastTickAt, pendingWake };
}

/** Write via a temp file in the same directory, then rename over the target. */
export function saveState(path: string, state: StatsState): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}
