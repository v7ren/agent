import type { ToolCall } from "../types.ts";

/**
 * DeepSeek's native tool-call markup sometimes comes back as plain message text
 * instead of structured tool_calls, e.g.
 *   <｜｜DSML｜｜ calls><｜｜DSML｜｜ invoke name="memory_diary">
 *   <｜｜DSML｜｜ parameter name="date" string="true">2026-10-31</｜｜DSML｜｜ parameter>
 *   </｜｜DSML｜｜ invoke></｜｜DSML｜｜ calls>
 * Without handling, that text is posted to the chat. This reads it back into
 * real tool calls and makes sure none of the markup is ever shown.
 */

const BAR = "[｜|]{1,2}";
const OPEN = `<\\s*${BAR}\\s*DSML\\s*${BAR}\\s*`;
const CLOSE = `<\\/\\s*${BAR}\\s*DSML\\s*${BAR}\\s*`;

const INVOKE = new RegExp(
  `${OPEN}invoke\\s+name\\s*=\\s*"([^"]+)"[^>]*>([\\s\\S]*?)${CLOSE}invoke\\s*>`,
  "g",
);
const PARAM = new RegExp(
  `${OPEN}parameter\\s+name\\s*=\\s*"([^"]+)"([^>]*)>([\\s\\S]*?)${CLOSE}parameter\\s*>`,
  "g",
);
const ANY_TAG = new RegExp(`<\\/?\\s*${BAR}\\s*DSML\\s*${BAR}[^>]*>`, "g");
const FIRST_TAG = new RegExp(`<\\/?\\s*${BAR}\\s*DSML\\s*${BAR}`);

export function hasDsml(text: string): boolean {
  return FIRST_TAG.test(text);
}

function readValue(raw: string, attrs: string): unknown {
  const value = raw.trim();
  // string="true" means the value is literal text; otherwise it is JSON.
  if (/string\s*=\s*"true"/i.test(attrs)) return value;
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return value;
  }
}

export interface DsmlResult {
  calls: ToolCall[];
  /** the message text with every piece of markup removed */
  text: string;
}

const MAX_CALLS = 8;

export function parseDsml(input: string): DsmlResult {
  if (!hasDsml(input)) return { calls: [], text: input };

  const calls: ToolCall[] = [];
  let index = 0;
  for (const m of input.matchAll(INVOKE)) {
    if (calls.length >= MAX_CALLS) break;
    const name = (m[1] ?? "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(name)) continue;

    const args: Record<string, unknown> = {};
    for (const p of (m[2] ?? "").matchAll(PARAM)) {
      const key = (p[1] ?? "").trim();
      if (!/^[A-Za-z0-9_-]{1,64}$/.test(key) || key === "__proto__") continue;
      args[key] = readValue(p[3] ?? "", p[2] ?? "");
    }
    calls.push({ id: `dsml_${index++}`, name, arguments: JSON.stringify(args) });
  }

  // Drop whole invoke blocks, then any stray wrapper tags (calls / function_calls).
  let text = input.replace(INVOKE, "").replace(ANY_TAG, "");
  // A reply cut off mid-tag leaves a fragment with no closing '>': drop it.
  const cut = text.search(FIRST_TAG);
  if (cut !== -1) text = text.slice(0, cut);
  return { calls, text: text.trim() };
}
