import type { Mood } from "./mood.ts";
import { rand01 } from "../core/hash.ts";

/**
 * The small things that make typing look like a person typing: how long a
 * line takes, a stop-and-start before a long one, a slip she fixes a moment
 * later. Pure functions, seeded, so they can be tested.
 */

/** How long she "types" a bubble, from its length and how she feels. */
export function typingMs(text: string, mood: Mood | undefined, seed: number): number {
  const n = [...text].length;
  const base = 450 + n * 95;
  const feel = mood === "sleepy" ? 1.4 : mood === "hungry" ? 1.1 : mood === "genki" ? 0.8 : 1;
  const wobble = 0.85 + rand01(seed) * 0.3;
  return Math.round(Math.min(5500, Math.max(500, base * feel * wobble)));
}

/** A long line is sometimes started, stopped, and started again. */
export function hesitates(text: string, seed: number): boolean {
  return [...text].length >= 18 && rand01(seed ^ 0x51ed270b) < 0.12;
}

const SKIP = /[\s\p{P}\p{S}\d]/u;

/**
 * A line sent with one slip (two neighbouring characters swapped) that she
 * edits back to the right text a moment later. Rare, and only for a plain line.
 */
export function slip(text: string, seed: number): { typo: string; fix: string } | null {
  const chars = [...text];
  if (chars.length < 6 || chars.length > 60) return null;
  if (/[`<@:/\\]|https?/.test(text)) return null;
  if (rand01(seed ^ 0x7f4a7c15) >= 0.035) return null;
  const spots: number[] = [];
  for (let i = 0; i + 1 < chars.length; i++) {
    const a = chars[i]!;
    const b = chars[i + 1]!;
    if (a !== b && !SKIP.test(a) && !SKIP.test(b)) spots.push(i);
  }
  if (spots.length === 0) return null;
  const at = spots[Math.floor(rand01(seed ^ 0x2545f491) * spots.length)]!;
  const swapped = [...chars];
  [swapped[at], swapped[at + 1]] = [chars[at + 1]!, chars[at]!];
  return { typo: swapped.join(""), fix: text };
}

/** Which message she answers when she picks an older one, counted back from the latest (1 = the one before). */
export function olderIndex(total: number, back: number | undefined): number | null {
  if (!back || back < 1 || total < back) return null;
  return total - back;
}

const DOING: Record<Mood, string[]> = {
  genki: ["水面上的氣泡", "追著飼料跑", "在魚缸裡轉圈"],
  sleepy: ["水底的沉澱", "半夢半醒", "貼著缸壁發呆"],
  hungry: ["白飯", "盯著飼料罐", "想吃飯"],
  tsundere: ["假裝沒在看", "背對著你", "不想理人"],
};

/** What her status says she is doing: her mood, bent by the hour. */
export function statusText(mood: Mood, now: Date, seed: number): string {
  const h = now.getHours();
  if (h >= 1 && h < 6) return rand01(seed) < 0.6 ? "夢裡吃白飯" : "熬夜的魚";
  if (h >= 11 && h < 13 && mood !== "sleepy") return "午餐時間，在想吃什麼";
  if (h >= 17 && h < 19 && mood === "hungry") return "晚餐在哪裡";
  const list = DOING[mood];
  return list[Math.floor(rand01(seed ^ 0x1234567) * list.length)] ?? list[0]!;
}
