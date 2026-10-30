import type { Msg } from "../types.ts";
import { estimateTokens } from "./budget.ts";

/** Per-message framing overhead, in tokens. */
const MESSAGE_OVERHEAD = 4;

export interface WindowConfig {
  limitTokens: number;
  keepFraction: number;
}

const DEFAULT_LIMIT = 100000;
const MIN_LIMIT = 8000;
// Saved history is capped at 600k characters, and compaction needs the oldest
// part to fit a few model calls: past about this size neither holds.
const MAX_LIMIT = 160000;
const DEFAULT_KEEP = 0.3;
const MIN_KEEP = 0.1;
const MAX_KEEP = 0.6;

/** Estimated tokens for a message list, including per-message framing. */
export function historyTokens(msgs: Msg[]): number {
  let total = 0;
  for (const m of msgs) total += estimateTokens(m.content) + MESSAGE_OVERHEAD;
  return total;
}

function parseNumber(raw: string | undefined): number | null {
  if (raw === undefined) return null;
  const text = raw.trim();
  if (text === "") return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}

/**
 * Reads FISHD_CONTEXT_TOKENS and FISHD_COMPACT_KEEP.
 * Returns null when the window is disabled ("0" or "off").
 */
export function windowFromEnv(
  env: Record<string, string | undefined>,
): WindowConfig | null {
  const rawLimit = env.FISHD_CONTEXT_TOKENS?.trim().toLowerCase();
  if (rawLimit === "0" || rawLimit === "off") return null;

  let limit = parseNumber(rawLimit);
  if (limit === null) limit = DEFAULT_LIMIT;
  limit = Math.min(MAX_LIMIT, Math.max(MIN_LIMIT, Math.round(limit)));

  let keep = parseNumber(env.FISHD_COMPACT_KEEP);
  if (keep === null) keep = DEFAULT_KEEP;
  keep = Math.min(MAX_KEEP, Math.max(MIN_KEEP, keep));

  return { limitTokens: limit, keepFraction: keep };
}

/** Above this, the prompt must be trimmed even if compaction failed. */
export function hardLimit(cfg: WindowConfig): number {
  return Math.round(cfg.limitTokens * 1.25);
}

/**
 * Chooses how many messages to drop from the front so the rest fits in
 * keepFraction of the limit. The kept part starts at a user message and
 * always holds at least the last two messages. Returns null when no
 * compaction is needed or none is possible.
 */
export function planCompaction(
  msgs: Msg[],
  cfg: WindowConfig,
  systemTokens = 0,
): { cut: number } | null {
  const n = msgs.length;
  const total = historyTokens(msgs);
  if (total + systemTokens <= cfg.limitTokens) return null;

  const target = cfg.limitTokens * cfg.keepFraction;
  const maxCut = n - 2;
  if (maxCut < 2) return null;

  // Smallest cut whose remaining tokens fit the target.
  let cut = 0;
  let remaining = total;
  while (cut < n && remaining > target) {
    const m = msgs[cut];
    if (m === undefined) break;
    remaining -= estimateTokens(m.content) + MESSAGE_OVERHEAD;
    cut++;
  }
  cut = Math.min(cut, maxCut);

  // Re-align forward to a user message that still keeps two messages.
  let aligned = -1;
  for (let i = cut; i <= maxCut; i++) {
    if (msgs[i]?.role === "user") {
      aligned = i;
      break;
    }
  }
  // Nothing forward fits: fall back to the nearest user message before it.
  if (aligned < 0) {
    for (let i = cut; i >= 2; i--) {
      if (msgs[i]?.role === "user") {
        aligned = i;
        break;
      }
    }
  }

  if (aligned < 2) return null;
  return { cut: aligned };
}

/** A one-line reminder of persona identity once the hot part is long. */
export function personaAnchor(hotTokens: number, threshold = 40000): string {
  if (hotTokens < threshold) return "";
  return "（這段對話已經很長了，妳還是藍色大肥魚，說話的口氣、脾氣和習慣都不變，不是客氣的助理。）";
}
