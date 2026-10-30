import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** What presence.json holds: whether the last run is still alive, and when it was last seen. */
export type PresenceFile = { running: boolean; startedAt: string; lastAlive: string };

export type OfflineInfo = { from: string; to: string; minutes: number; clean: boolean };

const FILE = "presence.json";
const MIN_GAP_MINUTES = 3;

function readPresence(dir: string): PresenceFile | null {
  try {
    const raw: unknown = JSON.parse(readFileSync(join(dir, FILE), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const p = raw as Record<string, unknown>;
    if (typeof p.running !== "boolean") return null;
    if (typeof p.startedAt !== "string" || typeof p.lastAlive !== "string") return null;
    if (Number.isNaN(Date.parse(p.lastAlive))) return null;
    return { running: p.running, startedAt: p.startedAt, lastAlive: p.lastAlive };
  } catch {
    return null;
  }
}

function writePresence(dir: string, data: PresenceFile): void {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, FILE);
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(data, null, 2));
    renameSync(tmp, file);
  } catch (err) {
    try {
      rmSync(tmp, { force: true });
    } catch {
      // best effort cleanup only
    }
    throw err;
  }
}

/**
 * Called once when the process starts. Reports how long she was away since
 * the previous run was last seen, then marks this run as alive.
 */
export function markStart(dir: string, now: Date): { offline: OfflineInfo | null } {
  const prev = readPresence(dir);
  let offline: OfflineInfo | null = null;
  if (prev) {
    const gapMs = now.getTime() - Date.parse(prev.lastAlive);
    const minutes = Math.round(gapMs / 60_000);
    if (minutes >= MIN_GAP_MINUTES) {
      offline = {
        from: prev.lastAlive,
        to: now.toISOString(),
        minutes,
        clean: !prev.running,
      };
    }
  }
  try {
    writePresence(dir, { running: true, startedAt: now.toISOString(), lastAlive: now.toISOString() });
  } catch {
    // an unwritable dir must not break startup
  }
  return { offline };
}

/** Cheap heartbeat; safe to call every minute. Never throws. */
export function markAlive(dir: string, now: Date): void {
  try {
    const prev = readPresence(dir);
    writePresence(dir, {
      running: prev?.running ?? true,
      startedAt: prev?.startedAt ?? now.toISOString(),
      lastAlive: now.toISOString(),
    });
  } catch {
    // presence is advisory; swallow
  }
}

/** Records a clean shutdown. Never throws. */
export function markStop(dir: string, now: Date): void {
  try {
    const prev = readPresence(dir);
    writePresence(dir, {
      running: false,
      startedAt: prev?.startedAt ?? now.toISOString(),
      lastAlive: now.toISOString(),
    });
  } catch {
    // presence is advisory; swallow
  }
}

const pad = (n: number): string => String(n).padStart(2, "0");

function sameLocalDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

/** Local HH:mm, prefixed with M/D when the day differs from `now`. */
function clockText(iso: string, now: Date): string {
  const d = new Date(iso);
  const hm = `${pad(d.getHours())}:${pad(d.getMinutes())}`;
  return sameLocalDay(d, now) ? hm : `${d.getMonth() + 1}/${d.getDate()} ${hm}`;
}

/** "45 分鐘" under two hours, otherwise "2.5 小時". */
function durationText(minutes: number): string {
  if (minutes > 120) return `${Math.round((minutes / 60) * 10) / 10} 小時`;
  return `${minutes} 分鐘`;
}

/** Traditional Chinese one-liner describing an absence, for a prompt. Empty for null. */
export function renderOffline(info: OfflineInfo | null, now: Date): string {
  if (!info) return "";
  const from = clockText(info.from, now);
  const to = clockText(info.to, now);
  const how = info.clean ? "是正常關機" : "像是突然中斷";
  return `（你剛醒來：你從 ${from} 到 ${to} 不在線，大約 ${durationText(info.minutes)}，${how}。這段時間的訊息你沒看到。）`;
}

const GOODBYE = /晚安|掰掰|拜拜|bye|先睡|去睡|睡了|下線|先走|先去|明天見|回頭見|等等見/i;

/**
 * A note on how the last conversation ended, shown once she is back after a
 * long enough silence. Empty when the gap is under 20 minutes.
 */
export function conversationEnd(args: {
  gapMinutes: number;
  lastUserText: string;
  lastBotText: string;
  now: Date;
}): string {
  const { gapMinutes, lastUserText, lastBotText } = args;
  if (gapMinutes < 20) return "";
  const gone = durationText(gapMinutes);
  if (GOODBYE.test(lastUserText)) {
    return `（他在最後說了要先離開，之後已經過了 ${gone}。）`;
  }
  const quote = Array.from(lastBotText).slice(0, 12).join("");
  return `（你最後說「${quote}」之後他就沒再回覆了，已經過了 ${gone}。）`;
}
