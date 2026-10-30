import { existsSync } from "node:fs";
import { join } from "node:path";
import type { Provider } from "../types.ts";
import { diaryPath, writeDiary } from "./diary.ts";
import { dayKey, journalPath } from "./vault.ts";

type WriteFn = typeof writeDiary;

/** Days already handled (or deliberately skipped) in this process. */
const handled = new Set<string>();

export interface EnsureDiariesOptions {
  root: string;
  provider: Provider;
  model?: string;
  now: Date;
  /** how many finished days back to look; today is never written (it is still going) */
  daysBack?: number;
  /** injectable for tests */
  write?: WriteFn;
  handledDays?: Set<string>;
}

/**
 * Finished days get a diary without anyone asking for it, so each day has an
 * ending she can look back on. One attempt per day per run: a failed attempt
 * is retried on the next start, never in a loop.
 */
export async function ensureDiaries(opts: EnsureDiariesOptions): Promise<string[]> {
  const write = opts.write ?? writeDiary;
  const seen = opts.handledDays ?? handled;
  const made: string[] = [];

  for (let back = 1; back <= (opts.daysBack ?? 3); back++) {
    const day = new Date(
      opts.now.getFullYear(),
      opts.now.getMonth(),
      opts.now.getDate() - back,
      12,
    );
    const key = dayKey(day);
    if (seen.has(key)) continue;
    seen.add(key);

    if (!existsSync(journalPath(opts.root, day))) continue;
    if (existsSync(join(opts.root, diaryPath(day)))) continue;

    try {
      const result = await write({
        root: opts.root,
        date: day,
        provider: opts.provider,
        ...(opts.model ? { model: opts.model } : {}),
      });
      if (result) made.push(result.path);
    } catch (err) {
      console.error("[diary]", err instanceof Error ? err.message : err);
    }
  }
  return made;
}
