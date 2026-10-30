import { rand01, seedOf } from "../core/hash.ts";

export interface AmbientInput {
  text: string;
  messageId: string;
  authorId: string;
  prevAuthor?: string;
  lastSpokeAt: number;
  now: number;
  base: number;
  names: string[];
  cooldownMs?: number;
}

const QUESTION = /[?？]|嗎|呢|什麼|怎麼|為什麼|要不要|是不是/;

/**
 * Even a permissive gate must not answer back-to-back. This is the guard
 * that keeps her from becoming a reply machine when the threshold is low.
 */
export function ambientCooldownElapsed(
  now: number,
  lastAt: number,
  cooldownSeconds: number,
): boolean {
  if (cooldownSeconds <= 0) return true;
  return now - lastAt >= cooldownSeconds * 1000;
}

/**
 * Should she join a conversation she was not invited into?
 *
 * Pure and deterministic per message, so the same feed always replays the
 * same way. Biased hard toward silence: she is a fish, not a chatbot that
 * must answer. Being called by name overrides everything else.
 */
export function ambientChime(input: AmbientInput): boolean {
  if (input.base <= 0) return false;

  const chars = [...input.text].length;
  if (chars < 4) return false;

  if (input.names.some((n) => n !== "" && input.text.includes(n))) return true;

  const cooldown = input.cooldownMs ?? 45_000;
  if (input.now - input.lastSpokeAt < cooldown) return false;

  let score = 1;
  if (QUESTION.test(input.text)) score += 0.55;
  if (chars > 12) score += 0.1;
  if (input.prevAuthor !== undefined && input.prevAuthor !== input.authorId) score -= 0.15;

  const chance = Math.min(0.85, input.base * score);
  return rand01(seedOf(input.messageId)) < chance;
}
