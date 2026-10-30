export interface SpontaneousPlan {
  minMinutes: number;
  maxMinutes: number;
  /** the channel must have been silent this long */
  quietMinutes: number;
  /** local hours when she will not start a new topic (wraps past midnight) */
  hushFrom: number;
  hushTo: number;
}

function clamp01(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.min(1, Math.max(0, n));
}

export function inHush(hour: number, plan: SpontaneousPlan): boolean {
  const from = plan.hushFrom;
  const to = plan.hushTo;
  if (from === to) return false;
  if (from < to) return hour >= from && hour < to;
  return hour >= from || hour < to;
}

/** "1-6" -> quiet hours; "off" / "" -> never quiet. */
export function parseHush(raw: string | undefined): { from: number; to: number } {
  const value = (raw ?? "").trim().toLowerCase();
  if (value === "" || value === "off" || value === "none" || value === "0") {
    return { from: 0, to: 0 };
  }
  const match = /^(\d{1,2})\s*-\s*(\d{1,2})$/.exec(value);
  if (!match) return { from: 1, to: 6 };
  return { from: Number(match[1]), to: Number(match[2]) };
}

/** Random delay in [min, max] minutes, in milliseconds. */
export function nextDelayMs(plan: SpontaneousPlan, rand: number): number {
  const lo = Math.max(1, Math.min(plan.minMinutes, plan.maxMinutes));
  const hi = Math.max(lo, plan.maxMinutes);
  const minutes = lo + (hi - lo) * clamp01(rand);
  return Math.round(minutes * 60_000);
}

/** Hours from now until the clock next reads `hour` (0..24). */
export function hoursUntil(hour: number, now: number): number {
  const delta = hour - now;
  return delta > 0 ? delta : delta + 24;
}

/**
 * Two conditions only: not during her quiet hours, and the room has actually
 * been quiet. She should never barge into an active conversation uninvited —
 * that is what the ambient gate is for.
 */
export function canSpeakNow(args: {
  now: number;
  lastMessageAt: number;
  hour: number;
  plan: SpontaneousPlan;
}): boolean {
  if (inHush(args.hour, args.plan)) return false;
  return args.now - args.lastMessageAt >= args.plan.quietMinutes * 60_000;
}
