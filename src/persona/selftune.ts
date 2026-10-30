import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { envMap, upsertEnv } from "../web/envfile.ts";

/**
 * min/max is the hard range: outside it a change is always rejected.
 * softMin/softMax is the range she may use on her own. Between soft and hard
 * a self change waits for the owner (status 'pending').
 *
 * For DISCORD_BUDGET, min/max bound the count n and the soft band applies to
 * n; the window m is checked against BUDGET_WINDOW. For DISCORD_SPON_HUSH,
 * min/max are hour bounds; 'off' and windows wider than 10 hours need the owner.
 */
export interface TunableSpec {
  min: number;
  max: number;
  kind: "number" | "budget" | "hush";
  softMin: number;
  softMax: number;
}

export const TUNABLE: Record<string, TunableSpec> = {
  DISCORD_TALK: { min: 0.3, max: 2.5, kind: "number", softMin: 0.6, softMax: 1.5 },
  DISCORD_AMBIENT_COOLDOWN: { min: 0, max: 600, kind: "number", softMin: 20, softMax: 180 },
  DISCORD_BURST_MIN: { min: 1, max: 30, kind: "number", softMin: 5, softMax: 15 },
  DISCORD_ARM_MS: { min: 0, max: 10000, kind: "number", softMin: 1000, softMax: 5000 },
  DISCORD_SETTLE_MIN: { min: 0, max: 30, kind: "number", softMin: 1, softMax: 10 },
  DISCORD_BUDGET: { min: 1, max: 10, kind: "budget", softMin: 2, softMax: 6 },
  DISCORD_SPON_MIN: { min: 30, max: 1440, kind: "number", softMin: 60, softMax: 360 },
  DISCORD_SPON_MAX: { min: 60, max: 2880, kind: "number", softMin: 120, softMax: 600 },
  DISCORD_SPON_DM_MIN: { min: 15, max: 1440, kind: "number", softMin: 30, softMax: 240 },
  DISCORD_SPON_DM_MAX: { min: 30, max: 2880, kind: "number", softMin: 60, softMax: 480 },
  DISCORD_SPON_QUIET: { min: 5, max: 240, kind: "number", softMin: 10, softMax: 60 },
  DISCORD_SPON_HUSH: { min: 0, max: 23, kind: "hush", softMin: 0, softMax: 23 },
  FISHD_WHISPER_P: { min: 0, max: 0.6, kind: "number", softMin: 0, softMax: 0.3 },
  JEV_THRESHOLD: { min: 0.2, max: 0.7, kind: "number", softMin: 0.25, softMax: 0.45 },
};

/** Window size for DISCORD_BUDGET ("n/m"): m is the minutes. */
const BUDGET_WINDOW = { min: 10, max: 120, softMin: 20, softMax: 60 };

export interface Change {
  id: string;
  key: string;
  from: string;
  to: string;
  at: string;
  by: "self" | "owner";
  status: "applied" | "pending" | "rejected" | "undone";
  reason?: string;
}

const LOG_CAP = 200;
const DAY_MS = 24 * 60 * 60 * 1000;
const SELF_DAILY_MAX = 6;
const SAME_KEY_DAILY_MAX = 2;
const MAX_LOG_VALUE = 40;
const HUSH_FREE_HOURS = 10;

const NUM = /^-?\d+(\.\d+)?$/;
const BUDGET = /^(\d{1,3})\/(\d{1,3})$/;
const HUSH = /^(\d{1,2})-(\d{1,2})$/;

type Tier = "soft" | "hard" | "reject";

interface Verdict {
  tier: Tier;
  value: string;
  reason?: string;
}

function inBand(n: number, min: number, max: number, softMin: number, softMax: number): Tier {
  if (!(n >= min && n <= max)) return "reject";
  return n >= softMin && n <= softMax ? "soft" : "hard";
}

function reject(reason: string): Verdict {
  return { tier: "reject", value: "", reason };
}

const FORMAT_REASON = "數值格式不正確";
const RANGE_REASON = "超出硬性範圍";

function judge(spec: TunableSpec, raw: string): Verdict {
  if (/[\r\n]/.test(raw)) return reject("數值含換行，拒絕");
  const v = raw.trim();

  if (spec.kind === "number") {
    if (!NUM.test(v)) return reject(FORMAT_REASON);
    const n = Number(v);
    const tier = inBand(n, spec.min, spec.max, spec.softMin, spec.softMax);
    if (tier === "reject") return reject(RANGE_REASON);
    return { tier, value: String(n) };
  }

  if (spec.kind === "budget") {
    const m = BUDGET.exec(v);
    if (!m) return reject(FORMAT_REASON);
    const n = Number(m[1]);
    const w = Number(m[2]);
    const tn = inBand(n, spec.min, spec.max, spec.softMin, spec.softMax);
    const tw = inBand(w, BUDGET_WINDOW.min, BUDGET_WINDOW.max, BUDGET_WINDOW.softMin, BUDGET_WINDOW.softMax);
    if (tn === "reject" || tw === "reject") return reject(RANGE_REASON);
    const tier: Tier = tn === "hard" || tw === "hard" ? "hard" : "soft";
    return { tier, value: `${n}/${w}` };
  }

  // hush: 'off' or 'H-H'
  if (v.toLowerCase() === "off") return { tier: "hard", value: "off" };
  const hm = HUSH.exec(v);
  if (!hm) return reject(FORMAT_REASON);
  const a = Number(hm[1]);
  const b = Number(hm[2]);
  const ta = inBand(a, spec.min, spec.max, spec.softMin, spec.softMax);
  const tb = inBand(b, spec.min, spec.max, spec.softMin, spec.softMax);
  if (ta === "reject" || tb === "reject") return reject(RANGE_REASON);
  // A window of HUSH_FREE_HOURS or less is free for self; wider needs the owner.
  const width = (b - a + 24) % 24;
  const tier: Tier = ta === "soft" && tb === "soft" && width <= HUSH_FREE_HOURS ? "soft" : "hard";
  return { tier, value: `${a}-${b}` };
}

/** Current value of an env key, own properties only ('constructor' and friends give ''). */
function envValue(envText: string, key: string): string {
  const map = envMap(envText);
  return Object.prototype.hasOwnProperty.call(map, key) ? (map[key] ?? "") : "";
}

function safeLogValue(value: string): string {
  return value.replace(/[\r\n]+/g, " ").slice(0, MAX_LOG_VALUE);
}

function millis(at: string): number {
  return Date.parse(at);
}

/** Self changes that count against the daily limits (applied or undone, last 24h). */
function recentSelf(log: Change[], now: Date): Change[] {
  const start = now.getTime() - DAY_MS;
  return log.filter((c) => {
    if (c.by !== "self") return false;
    if (c.status !== "applied" && c.status !== "undone") return false;
    const t = millis(c.at);
    return !Number.isNaN(t) && t >= start && t <= now.getTime();
  });
}

function limitReason(log: Change[], key: string, now: Date): string | undefined {
  const recent = recentSelf(log, now);
  if (recent.length >= SELF_DAILY_MAX) return `24 小時內自行調整已達 ${SELF_DAILY_MAX} 次上限`;
  if (recent.filter((c) => c.key === key).length >= SAME_KEY_DAILY_MAX) {
    return `同一設定 24 小時內已調整 ${SAME_KEY_DAILY_MAX} 次`;
  }
  return undefined;
}

/**
 * Validate a requested change and decide what happens to it. Returns the new
 * change record (the caller stores it with appendLog) and, when it is applied,
 * the rewritten env text (the caller writes it). Never throws on bad input.
 */
export function proposeChange(
  envText: string,
  key: string,
  value: string,
  now: Date,
  by: "self" | "owner",
  log: Change[],
): { change: Change; newEnvText?: string } {
  const base: Change = {
    id: randomUUID().slice(0, 8),
    key,
    from: envValue(envText, key),
    to: safeLogValue(String(value)),
    at: now.toISOString(),
    by,
    status: "rejected",
  };

  const spec = Object.prototype.hasOwnProperty.call(TUNABLE, key) ? TUNABLE[key] : undefined;
  if (!spec) return { change: { ...base, reason: "此設定不在可自行調整的清單內" } };

  const verdict = judge(spec, String(value));
  if (verdict.tier === "reject") {
    return { change: { ...base, reason: verdict.reason ?? RANGE_REASON } };
  }
  base.to = verdict.value;

  if (by === "self") {
    const limit = limitReason(log, key, now);
    if (limit) return { change: { ...base, reason: limit } };
  }

  // Owner changes obey the hard range (already checked) but skip the soft band.
  if (verdict.tier === "hard" && by === "self") {
    return { change: { ...base, status: "pending", reason: "超出自行範圍，等待主人同意" } };
  }

  const change: Change = {
    ...base,
    status: "applied",
    reason: by === "owner" ? "主人指定，已套用" : "在自行範圍內，已套用",
  };
  return { change, newEnvText: upsertEnv(envText, { [key]: verdict.value }) };
}

/** Owner approves a pending change. Returns the updated record and the new env text. */
export function approveChange(
  envText: string,
  log: Change[],
  id: string,
  _now: Date,
): { change?: Change; newEnvText?: string } {
  const found = log.find((c) => c.id === id && c.status === "pending");
  if (!found) return {};
  const change: Change = { ...found, status: "applied", by: "owner", reason: "主人同意，已套用" };
  return { change, newEnvText: upsertEnv(envText, { [found.key]: found.to }) };
}

/** Restores 'from' only if the key still holds 'to'; otherwise leaves the file alone. */
export function undoChange(
  envText: string,
  log: Change[],
  id: string,
  _now: Date,
): { change?: Change; newEnvText?: string } {
  const found = log.find((c) => c.id === id && c.status === "applied");
  if (!found) return {};
  const current = envValue(envText, found.key);
  if (current !== found.to) {
    return { change: { ...found, reason: "目前值已被改動，未還原" } };
  }
  return {
    change: { ...found, status: "undone", reason: `已還原為 ${found.from}` },
    newEnvText: upsertEnv(envText, { [found.key]: found.from }),
  };
}

/** Adds or replaces (by id) a record and keeps the newest 200. */
export function appendLog(log: Change[], change: Change): Change[] {
  const i = log.findIndex((c) => c.id === change.id);
  const next = i >= 0 ? log.map((c, j) => (j === i ? change : c)) : [...log, change];
  return next.slice(-LOG_CAP);
}

const STATUSES: Change["status"][] = ["applied", "pending", "rejected", "undone"];

function isChange(x: unknown): x is Change {
  if (typeof x !== "object" || x === null) return false;
  const c = x as Record<string, unknown>;
  return (
    typeof c.id === "string" &&
    typeof c.key === "string" &&
    typeof c.from === "string" &&
    typeof c.to === "string" &&
    typeof c.at === "string" &&
    (c.by === "self" || c.by === "owner") &&
    typeof c.status === "string" &&
    (STATUSES as string[]).includes(c.status) &&
    (c.reason === undefined || typeof c.reason === "string")
  );
}

/** Missing or corrupt file gives an empty log. */
export function loadLog(path: string): Change[] {
  try {
    if (!existsSync(path)) return [];
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    return raw.filter(isChange).slice(-LOG_CAP);
  } catch {
    return [];
  }
}

/** Atomic write: temp file, then rename over the target. */
export function saveLog(path: string, log: Change[]): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, `${JSON.stringify(log.slice(-LOG_CAP), null, 2)}\n`, "utf8");
  renameSync(tmp, path);
}

const STATUS_ZH: Record<Change["status"], string> = {
  applied: "已套用",
  pending: "待同意",
  rejected: "已拒絕",
  undone: "已還原",
};

/** "2026-10-31 01:02" on the machine's own clock; an unparseable value is shown as-is. */
function localStamp(d: Date): string {
  if (Number.isNaN(d.getTime())) return "?";
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** Short Traditional Chinese summary of the recent and pending changes. */
export function renderTuneState(log: Change[], now: Date = new Date()): string {
  if (log.length === 0) return "尚無自行調整紀錄。";

  const lines: string[] = [`近 24 小時自行調整：${recentSelf(log, now).length}/${SELF_DAILY_MAX}`];

  const pending = log.filter((c) => c.status === "pending");
  if (pending.length > 0) {
    lines.push("待主人同意：");
    for (const c of pending) lines.push(`- ${c.id} ${c.key} ${c.from} → ${c.to}`);
  }

  lines.push("最近紀錄：");
  for (const c of log.slice(-5).reverse()) {
    // c.at is stored as UTC; show it on the system clock, not as raw UTC.
    const time = localStamp(new Date(c.at));
    lines.push(`- ${time} ${c.key} ${c.from} → ${c.to} ${STATUS_ZH[c.status]}`);
  }

  return lines.join("\n");
}
