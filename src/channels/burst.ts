export interface BurstItem {
  id: string;
  author: string;
  authorId: string;
  text: string;
  at: number;
  where: string;
  /** names of the people this line was aimed at, when it was not for her */
  to?: string[];
}

/** Keep the tail of a conversation, bounded by time and count. */
export function trimBurst(
  items: BurstItem[],
  now: number,
  windowMs: number,
  max = 8,
): BurstItem[] {
  return items.filter((item) => now - item.at <= windowMs).slice(-max);
}

export interface BudgetResult {
  ok: boolean;
  stamps: number[];
}

/**
 * Token bucket for interjections. Counts only *unprompted* replies, so being
 * called by name never consumes the budget.
 */
export function takeBudget(
  stamps: number[],
  now: number,
  max: number,
  windowMs: number,
): BudgetResult {
  const kept = stamps.filter((at) => now - at < windowMs);
  if (max > 0 && kept.length >= max) return { ok: false, stamps: kept };
  return { ok: true, stamps: [...kept, now] };
}

/** After she speaks unprompted, she stays quiet for a while. */
export function inSettle(now: number, settleUntil: number): boolean {
  return now < settleUntil;
}

/** Parse "4/30" into { max: 4, minutes: 30 }. */
export function parseBudget(raw: string): { max: number; minutes: number } {
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(raw);
  if (!match) return { max: 4, minutes: 30 };
  return { max: Number(match[1]), minutes: Number(match[2]) };
}
