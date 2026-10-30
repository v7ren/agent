// The companion may decline to answer ("不想回答"), but declining is rate
// limited by a rolling 60-minute window kept in memory only.

const WINDOW_MS = 60 * 60_000;
const MAX_STORED = 50;
const MAX_REASON_CHARS = 30;
const FALLBACK_REASON = "這個……我不想講。";
const DEFAULT_MAX_PER_HOUR = 3;
const ENV_MAX_CEILING = 10;

export class DeclineLimiter {
  readonly #maxPerHour: number;
  #stamps: number[] = [];

  constructor(maxPerHour = DEFAULT_MAX_PER_HOUR) {
    this.#maxPerHour = Number.isFinite(maxPerHour) ? Math.trunc(maxPerHour) : 0;
  }

  #inWindow(now: Date): number[] {
    const cutoff = now.getTime() - WINDOW_MS;
    return this.#stamps.filter((t) => t > cutoff);
  }

  allow(now: Date): boolean {
    if (this.#maxPerHour <= 0) return false;
    return this.#inWindow(now).length < this.#maxPerHour;
  }

  record(now: Date): void {
    this.#stamps = [...this.#inWindow(now), now.getTime()].slice(-MAX_STORED);
  }

  remaining(now: Date): number {
    if (this.#maxPerHour <= 0) return 0;
    return Math.max(0, this.#maxPerHour - this.#inWindow(now).length);
  }
}

export function declineLine(reason: unknown): string {
  const raw = typeof reason === "string" ? reason : "";
  const text = raw
    .replace(/\b(?:https?:\/\/|www\.)\S+/gi, " ")
    .replace(/@\S*/g, " ")
    .replace(/[<>]/g, " ")
    .replace(/[*_`~#|\[\]()\\]/g, "")
    .replace(/^\s*(?:[-+]|\d+\.)\s+/, "")
    .replace(/\s+/g, " ")
    .trim();
  const clipped = Array.from(text).slice(0, MAX_REASON_CHARS).join("").trim();
  return clipped === "" ? FALLBACK_REASON : clipped;
}

export function declineMaxFromEnv(env: Record<string, string | undefined>): number {
  const raw = (env.FISHD_DECLINE_MAX_PER_HOUR ?? "").trim();
  if (!/^[+-]?\d+$/.test(raw)) return DEFAULT_MAX_PER_HOUR;
  const n = Number(raw);
  return Math.min(ENV_MAX_CEILING, Math.max(0, n));
}
