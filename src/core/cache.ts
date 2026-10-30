import type { CacheStat, Usage } from "../types.ts";

export interface Rates {
  /** USD per 1M tokens */
  cacheHit: number;
  cacheMiss: number;
  output: number;
}

/** DeepSeek V3.2 list prices. Verify before trusting any number below. */
export const DEEPSEEK_RATES: Rates = {
  cacheHit: 0.028,
  cacheMiss: 0.28,
  output: 0.42,
};

/**
 * Price table lookup. Only providers with known rates get a number; anything
 * else returns null and the cost is reported as unknown instead of wrong.
 */
export function ratesFor(provider: string, model: string): Rates | null {
  const id = `${provider} ${model}`.toLowerCase();
  if (id.includes("deepseek")) return DEEPSEEK_RATES;
  return null;
}

export function emptyStat(): CacheStat {
  return {
    requests: 0,
    hitTokens: 0,
    missTokens: 0,
    promptTokens: 0,
    completionTokens: 0,
    costUsd: 0,
    naiveCostUsd: 0,
  };
}

export class CacheLog {
  stat: CacheStat;
  rates: Rates | null;

  constructor(rates: Rates | null = DEEPSEEK_RATES) {
    this.stat = emptyStat();
    this.rates = rates;
  }

  /** false when the provider has no known price; costs then stay at 0 */
  get costKnown(): boolean {
    return this.rates !== null;
  }

  record(u: Usage): CacheStat {
    const s = this.stat;
    s.requests += 1;
    s.hitTokens += u.cacheHitTokens;
    s.missTokens += u.cacheMissTokens;
    s.promptTokens += u.promptTokens;
    s.completionTokens += u.completionTokens;

    const r = this.rates;
    if (!r) return s;

    s.costUsd +=
      (u.cacheHitTokens * r.cacheHit) / 1e6 +
      (u.cacheMissTokens * r.cacheMiss) / 1e6 +
      (u.completionTokens * r.output) / 1e6;

    // What the same traffic would have cost with no prefix caching at all.
    s.naiveCostUsd +=
      (u.promptTokens * r.cacheMiss) / 1e6 +
      (u.completionTokens * r.output) / 1e6;

    return s;
  }

  get hitRate(): number {
    const total = this.stat.hitTokens + this.stat.missTokens;
    return total === 0 ? 0 : this.stat.hitTokens / total;
  }

  get savedUsd(): number {
    if (!this.rates) return 0;
    return Math.max(0, this.stat.naiveCostUsd - this.stat.costUsd);
  }

  /** One-line footer for the CLI. */
  formatLast(u: Usage): string {
    const total = u.cacheHitTokens + u.cacheMissTokens;
    const rate = total === 0 ? 0 : u.cacheHitTokens / total;
    const all = this.stat;
    const r = this.rates;
    const turnCost = r
      ? `$${((u.cacheHitTokens * r.cacheHit + u.cacheMissTokens * r.cacheMiss + u.completionTokens * r.output) / 1e6).toFixed(5)}`
      : "unknown";
    const saved = r ? ` · saved $${this.savedUsd.toFixed(4)}` : "";
    return (
      `prompt ${u.promptTokens.toLocaleString()} · ` +
      `hit ${(rate * 100).toFixed(0)}% · ` +
      `out ${u.completionTokens} · ` +
      `turn ${turnCost} · ` +
      `session ${(all.requests)} turns · ` +
      `hit ${(this.hitRate * 100).toFixed(0)}%${saved}`
    );
  }
}
