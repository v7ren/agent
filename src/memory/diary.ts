import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import type { Provider } from "../types.ts";
import { condense } from "./checkpoint.ts";
import { journalPath, readDoc } from "./vault.ts";

function dayKey(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

export function diaryPath(date: Date): string {
  return `diary/${dayKey(date)}.md`;
}

const DIARY_SYSTEM =
  "你是一隻叫「藍色大肥魚」的藍色胖魚，有點傲嬌，最喜歡白飯。" +
  "一律使用繁體中文（台灣用語），不要簡體字。" +
  "你要用第一人稱寫今天的日記，300 字以內，口語、短句、自然。" +
  "不要條列、不要標題、不要說「今天」開頭，直接寫。";

/**
 * One first-person entry per day, generated from the journal. This is both a
 * readable diary and the compaction artifact: tomorrow she can recall the
 * day without replaying every message. Long days are condensed in chunks
 * (map-reduce), never cut short.
 */
export async function writeDiary(opts: {
  root: string;
  date: Date;
  provider: Provider;
  model?: string;
  maxTokens?: number;
}): Promise<{ path: string; text: string } | null> {
  const abs = journalPath(opts.root, opts.date);
  if (!existsSync(abs)) return null;

  const rel = relative(resolve(opts.root), abs).replace(/\\/g, "/");
  const journal = readDoc(opts.root, rel);
  const day = dayKey(opts.date);

  const body = await condense({
    provider: opts.provider,
    ...(opts.model ? { model: opts.model } : {}),
    text: journal,
    mapSystem:
      "你是藍色大肥魚，整理今天一段聊天紀錄裡你真心在意的事。" +
      "條列最多 5 條，每條一行，用繁體中文（台灣用語），不要客套。",
    reduceSystem: DIARY_SYSTEM,
    reduceMaxTokens: opts.maxTokens ?? 800,
    reduceUser: (material, condensed) =>
      condensed
        ? `今天（${day}）的紀錄已經分段整理過，重點如下：\n${material}\n\n寫今天的日記。只寫你真心在意的事，不要逐句摘要。`
        : `今天（${day}）的紀錄：\n${material}\n\n寫今天的日記。只寫你真心在意的事，不要逐句摘要。`,
  });
  if (body === "") return null;

  const doc = [
    "---",
    `date: ${day}`,
    "type: diary",
    "---",
    "",
    `# ${day}`,
    "",
    body,
    "",
    `> 來源：[[${rel}]]`,
    "",
  ].join("\n");

  const relOut = diaryPath(opts.date);
  const outAbs = join(opts.root, relOut);
  mkdirSync(join(opts.root, "diary"), { recursive: true });
  writeFileSync(outAbs, doc, "utf8");

  return { path: relOut, text: body };
}
