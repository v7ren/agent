/**
 * Terminal log for the bot, written for a person watching it run:
 *   01:35:12 msg    #bot ren: 「你是不是討厭他」
 *   01:35:12 decide → 回 (叫了她)
 * Times are the machine's own clock. Colour only when the terminal supports it.
 *
 * FISHD_LOG: "info" (default) · "debug" (also gate details, tool arguments)
 *            · "quiet" (warnings and errors only) · "off"
 * Tests run silent unless FISHD_LOG is set.
 */

export type LogLevel = "off" | "quiet" | "info" | "debug";

const ORDER: Record<LogLevel, number> = { off: 0, quiet: 1, info: 2, debug: 3 };

function levelFromEnv(): LogLevel {
  const raw = (process.env.FISHD_LOG ?? "").trim().toLowerCase();
  if (raw === "off" || raw === "quiet" || raw === "info" || raw === "debug") return raw;
  // node --test child processes: stay out of the test output unless asked.
  if (process.env.NODE_TEST_CONTEXT !== undefined) return "off";
  return "info";
}

const COLORS: Record<string, string> = {
  msg: "36", // cyan
  decide: "33", // yellow
  turn: "32", // green
  send: "32",
  tool: "35", // magenta
  mood: "34",
  drive: "34",
  ignore: "31", // red
  tune: "35",
  spont: "33",
  body: "90",
  warn: "33",
  error: "31",
};

function useColor(): boolean {
  return Boolean(process.stdout.isTTY) && process.env.NO_COLOR === undefined;
}

function stamp(now: Date): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return `${p(now.getHours())}:${p(now.getMinutes())}:${p(now.getSeconds())}`;
}

/** One line, no control characters, so message text cannot break the log layout. */
export function snip(text: string, max = 60): string {
  const flat = text
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  const chars = Array.from(flat);
  return chars.length <= max ? flat : `${chars.slice(0, max).join("")}…`;
}

export function formatLine(tag: string, message: string, now: Date, color: boolean): string {
  const label = tag.padEnd(6);
  const code = COLORS[tag];
  const shown = color && code ? `\u001b[${code}m${label}\u001b[0m` : label;
  const time = color ? `\u001b[90m${stamp(now)}\u001b[0m` : stamp(now);
  return `${time} ${shown} ${message}`;
}

function emit(need: LogLevel, tag: string, message: string, stream: "out" | "err"): void {
  if (ORDER[levelFromEnv()] < ORDER[need]) return;
  const line = formatLine(tag, message, new Date(), useColor());
  if (stream === "err") console.error(line);
  else console.log(line);
}

export const log = {
  info(tag: string, message: string): void {
    emit("info", tag, message, "out");
  },
  debug(tag: string, message: string): void {
    emit("debug", tag, message, "out");
  },
  warn(tag: string, message: string): void {
    emit("quiet", "warn", `${tag}: ${message}`, "err");
  },
  error(tag: string, message: string): void {
    emit("quiet", "error", `${tag}: ${message}`, "err");
  },
};
