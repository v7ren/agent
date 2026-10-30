export interface ScopeRules {
  /** if non-empty, guild messages outside these channels are ignored */
  onlyChannels: string[];
  /** if non-empty, only these user ids may DM her (overrides the owner default) */
  dmUsers: string[];
  /** the owners: the default DM audience when dmUsers is empty */
  owners: string[];
  /** DISCORD_DM_OPEN=1: anyone may DM her (still limited by dmUsers if set) */
  dmOpen: boolean;
  /** never answered anywhere, checked before everything else */
  ignoreUsers: string[];
  /** answer DMs at all */
  dms: boolean;
}

export interface ScopeTarget {
  inGuild: boolean;
  channelId: string;
  authorId: string;
}

export type ScopeDeny = "ignored" | "dms-off" | "dm-not-allowed" | "channel-not-allowed";

export function emptyRules(): ScopeRules {
  return { onlyChannels: [], dmUsers: [], owners: [], dmOpen: false, ignoreUsers: [], dms: true };
}

/** Empty dmUsers means owners only; DISCORD_DM_OPEN=1 opens DMs to everyone. */
export function dmAllowed(authorId: string, rules: ScopeRules): boolean {
  if (rules.dmOpen) return rules.dmUsers.length === 0 || rules.dmUsers.includes(authorId);
  const audience = rules.dmUsers.length > 0 ? rules.dmUsers : rules.owners;
  return audience.includes(authorId);
}

/**
 * The hard boundary, applied before any mention / ambient logic.
 * Returns why the target is refused, or null when it is allowed.
 * Guilds and DMs are governed separately: DM restrictions never leak into
 * channels, and channel restrictions never touch DMs.
 */
export function scopeReason(target: ScopeTarget, rules: ScopeRules): ScopeDeny | null {
  if (rules.ignoreUsers.includes(target.authorId)) return "ignored";

  if (!target.inGuild) {
    if (!rules.dms) return "dms-off";
    return dmAllowed(target.authorId, rules) ? null : "dm-not-allowed";
  }

  if (rules.onlyChannels.length > 0 && !rules.onlyChannels.includes(target.channelId)) {
    return "channel-not-allowed";
  }
  return null;
}

export function scopeAllows(target: ScopeTarget, rules: ScopeRules): boolean {
  return scopeReason(target, rules) === null;
}

export interface TokenBucket {
  tokens: number;
  at: number;
}

/** Explicit-trigger turns: 6 per user per 5 minutes (owners exempt by the caller). */
export const TURN_LIMIT = { capacity: 6, refillPerMs: 6 / (5 * 60_000) };
/** Incoming DMs from a non-owner: a burst of 5, then one every 20 seconds. */
export const DM_LIMIT = { capacity: 5, refillPerMs: 1 / 20_000 };
/** Serial queue: at most this many turns pending (running or waiting). */
export const QUEUE_LIMIT = 8;

/**
 * Classic token bucket. Starts full, refills continuously, one token per take.
 * Pure: returns the next bucket state instead of mutating.
 */
export function takeToken(
  bucket: TokenBucket | undefined,
  now: number,
  limit: { capacity: number; refillPerMs: number },
): { ok: boolean; bucket: TokenBucket } {
  const start = bucket ?? { tokens: limit.capacity, at: now };
  const elapsed = Math.max(0, now - start.at);
  const tokens = Math.min(limit.capacity, start.tokens + elapsed * limit.refillPerMs);
  if (tokens < 1) return { ok: false, bucket: { tokens, at: now } };
  return { ok: true, bucket: { tokens: tokens - 1, at: now } };
}

/** True when a new turn must be refused because the queue is already full. */
export function queueFull(pending: number, limit: number = QUEUE_LIMIT): boolean {
  return pending >= limit;
}
