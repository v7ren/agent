import { MOODS } from "./mood.ts";
import type { Intensity, Mood } from "./mood.ts";
import { isFeel } from "./kaomoji.ts";
import type { Feel } from "./kaomoji.ts";
import { rand01 } from "../core/hash.ts";

export const TONES = ["softcute", "playful", "healing", "energetic", "whisper"] as const;
export type Tone = (typeof TONES)[number];

export interface Expression {
  mood?: Mood;
  intensity?: Intensity;
  why?: string;
  feel?: Feel;
  segments?: 1 | 2 | 3;
  /** seconds she waits before each later bubble (gaps[0] is before the 2nd) */
  gaps?: number[];
  /** answer an older message: 1 = the one before the latest */
  replyBack?: number;
  tone?: Tone;
  react?: string;
  /** a quiet inner thought, shown occasionally as subtext */
  whisper?: string;
}

const MARKER = "::state";

function isMood(x: unknown): x is Mood {
  return typeof x === "string" && (MOODS as readonly string[]).includes(x);
}

function isTone(x: unknown): x is Tone {
  return typeof x === "string" && (TONES as readonly string[]).includes(x);
}

function isIntensity(x: unknown): x is Intensity {
  return x === 1 || x === 2 || x === 3;
}

/**
 * Split the reply from its delivery instructions.
 * The state block is optional; most turns should not have one.
 */
export function parseExpression(raw: string): { text: string; expression: Expression } {
  const marks = [...raw.matchAll(/:{2,}state\b/g)];
  if (marks.length === 0) return { text: raw.trim(), expression: {} };
  if (marks.length === 1) return parseOne(raw, marks[0]!.index!, marks[0]![0].length);

  // The model wrote the block more than once (a draft, then "wait, let me redo
  // it"). The words after the first block are the real reply; the earlier
  // draft and every block's directive lines never reach the room.
  const expression: Expression = {};
  const texts: string[] = [raw.slice(0, marks[0]!.index!)];
  marks.forEach((m, k) => {
    const end = marks[k + 1]?.index ?? raw.length;
    const one = parseOne(raw.slice(m.index!, end), 0, m[0].length, true);
    Object.assign(expression, one.expression);
    texts.push(one.text);
  });
  const later = texts.slice(1).map(cleanDirectives).filter((t) => t !== "");
  const text = later.length > 0 ? later[later.length - 1]! : cleanDirectives(texts[0]!);
  return { text: dropMeta(text), expression };
}

/** Lines like `:::react 🐋` are state, not speech. */
function cleanDirectives(text: string): string {
  return text
    .split("\n")
    .filter((l) => !/^\s*:{2,}\w+/.test(l))
    .join("\n")
    .replace(/:+\s*$/, "")
    .trim();
}

/** "Wait, format — I should just say the line." in front of the real line. */
function dropMeta(text: string): string {
  const m = /^(?:wait|hmm|oops|let me)\b[^「"“]*?(?=[「"“])/i.exec(text);
  return m ? text.slice(m[0].length).trim() : text;
}

/**
 * One marker: the words before it are the reply (or, when `after`, the words
 * after its block are), the JSON that follows is the state.
 */
function parseOne(
  raw: string,
  idx: number,
  len: number,
  after = false,
): { text: string; expression: Expression } {
  const before = cleanDirectives(raw.slice(0, idx));
  const text = before;
  let body = raw.slice(idx + len).trim();
  if (body.startsWith("```")) {
    body = body.replace(/^```(?:json)?/i, "").replace(/```$/, "").trim();
  }

  const open = body.indexOf("{");
  const close = after ? matchBrace(body, open) : body.lastIndexOf("}");
  if (open === -1 || close <= open) return { text: after ? "" : text, expression: {} };

  let parsed: unknown;
  try {
    parsed = JSON.parse(body.slice(open, close + 1));
  } catch {
    return { text: after ? "" : text, expression: {} };
  }
  if (!parsed || typeof parsed !== "object") return { text: after ? "" : text, expression: {} };
  const tail = after ? body.slice(close + 1) : "";
  const expression = readState(parsed as Record<string, unknown>);
  const directive = /^\s*:{2,}react\s+(\S{1,8})\s*$/m.exec(tail);
  if (directive && !expression.react) expression.react = directive[1]!;
  return { text: after ? tail : text, expression };
}

function matchBrace(s: string, open: number): number {
  if (open === -1) return -1;
  let depth = 0;
  let inStr = false;
  for (let i = open; i < s.length; i++) {
    const c = s[i]!;
    if (inStr) {
      if (c === "\\") i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i;
  }
  return -1;
}

function readState(o: Record<string, unknown>): Expression {
  const expression: Expression = {};

  if (isMood(o.mood)) expression.mood = o.mood;
  if (isIntensity(o.intensity)) expression.intensity = o.intensity;
  if (typeof o.why === "string") expression.why = o.why.slice(0, 120);
  if (isFeel(o.feel)) expression.feel = o.feel;
  if (o.segments === 1 || o.segments === 2 || o.segments === 3) expression.segments = o.segments;
  if (Array.isArray(o.gaps) || typeof o.gaps === "number") {
    const raw = Array.isArray(o.gaps) ? o.gaps : [o.gaps];
    const gaps = raw
      .slice(0, 2)
      .map((g) => (typeof g === "number" && Number.isFinite(g) ? Math.min(300, Math.max(0.5, g)) : NaN))
      .filter((g) => !Number.isNaN(g));
    if (gaps.length > 0) expression.gaps = gaps;
  }
  if (typeof o.replyBack === "number" && Number.isInteger(o.replyBack) && o.replyBack >= 1 && o.replyBack <= 8) {
    expression.replyBack = o.replyBack;
  }
  if (isTone(o.tone)) expression.tone = o.tone;
  if (typeof o.react === "string" && o.react.length <= 8) expression.react = o.react;
  if (typeof o.whisper === "string") {
    const w = o.whisper.trim();
    if (w !== "") expression.whisper = w.slice(0, 80);
  }

  return expression;
}

/**
 * Split into 1..3 chat bubbles at sentence boundaries.
 * Never cuts a sentence in half.
 */
export function splitMessage(text: string, n: 1 | 2 | 3 = 1): string[] {
  const trimmed = text.trim();
  if (n <= 1 || trimmed === "") return [trimmed];

  const parts = trimmed
    .split(/(?<=[。！？!?…\n])/)
    .map((s) => s.trim())
    .filter(Boolean);

  if (parts.length <= 1) return [trimmed];

  const groups: string[] = [];
  const per = Math.ceil(parts.length / n);
  for (let i = 0; i < parts.length; i += per) {
    groups.push(parts.slice(i, i + per).join(""));
  }
  return groups.slice(0, 3);
}

export interface VoicePolicy {
  enabled: boolean;
  probability: number;
  maxChars: number;
}

/**
 * The 50% lottery lives in code, not in the prompt, and is seeded from the
 * message id so it is reproducible and testable.
 */
export function shouldVoice(
  text: string,
  seed: number,
  policy: VoicePolicy,
  hasEmotion: boolean,
): boolean {
  if (!policy.enabled) return false;
  if (!hasEmotion) return false;
  if ([...text].length > policy.maxChars) return false;
  return rand01(seed) < policy.probability;
}

/** Inner thoughts should be rare; otherwise they stop feeling like thoughts. */
export function shouldWhisper(seed: number, probability: number): boolean {
  if (probability <= 0) return false;
  return rand01(seed ^ 0x9e3779b9) < probability;
}

/** Mood drives prosody, so the model doesn't have to remember the mapping. */
export function toneForMood(mood: Mood): Tone {
  switch (mood) {
    case "sleepy":
      return "whisper";
    case "genki":
      return "energetic";
    case "tsundere":
      return "playful";
    case "hungry":
      return "softcute";
  }
}
