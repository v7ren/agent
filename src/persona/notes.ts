import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Block } from "../types.ts";
import { dayKey } from "../memory/vault.ts";

const MAX_BULLETS = 12;
const MAX_CHARS = 700;
const MAX_NOTE_CHARS = 200;

const HEADER = [
  "# 她自己的筆記",
  "",
  "這是你自己的筆記本（persona_note 寫進來的），不管換哪個人格包都在。",
  "這裡寫的每一條，之後每一輪都會出現在你面前（最多留最近 12 條）；所以只寫真的長期有用的事，一條一句。",
  "核心人格在 core.md，不給你改。",
  "",
].join("\n");

export function notesPath(personaDir: string): string {
  return join(personaDir, "notes.md");
}

function bullets(text: string): string[] {
  return text
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .slice(-MAX_BULLETS);
}

export function clipNotes(text: string): string {
  const body = [HEADER, ...bullets(text)].join("\n");
  return body.length > MAX_CHARS ? body.slice(body.length - MAX_CHARS) : body;
}

/**
 * Notes go into the volatile tip, not the cached prefix: writing one must
 * never change the prefix mid-session (that would bust the cache and trip
 * the prefix guard).
 */
export function loadNotes(personaDir: string): string {
  const path = notesPath(personaDir);
  if (!existsSync(path)) return "";
  try {
    const text = readFileSync(path, "utf8").trim();
    if (text === "") return "";
    return clipNotes(text);
  } catch {
    return "";
  }
}

export function notesBlock(personaDir: string, now = new Date()): Block | null {
  const notes = loadNotes(personaDir);
  if (notes === "") return null;

  // tail-token budget: keep the newest few bullets only
  const lines = notes
    .split(/\r?\n/)
    .filter((line) => line.startsWith("- "))
    .slice(-4)
    .map((line) => (line.length > 60 ? `${line.slice(0, 60)}…` : line));

  if (lines.length === 0) return null;

  return {
    id: "notes",
    volatility: 4,
    content: `<self>${lines.join("　")}</self>`,
  };
}

/** Append one line, keeping the newest and trimming the oldest. */
export function appendNote(
  personaDir: string,
  note: string,
  now = new Date(),
): string {
  // She often writes the date herself; the file adds it, so drop hers.
  const clean = note
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^\d{4}-\d{2}-\d{2}\s*[：:,，-]?\s*/, "")
    .slice(0, MAX_NOTE_CHARS);
  if (clean === "") return "";

  const path = notesPath(personaDir);
  const existing = existsSync(path) ? bullets(readFileSync(path, "utf8")) : [];
  const line = `- ${dayKey(now)} ${clean}`;
  const next = [HEADER, ...[...existing, line].slice(-MAX_BULLETS)].join("\n");

  mkdirSync(personaDir, { recursive: true });
  writeFileSync(path, `${next}\n`, "utf8");
  return line;
}
