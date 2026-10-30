export interface EnvEntry {
  key: string;
  value: string;
  /** 0-based line index in the source text */
  line: number;
}

const LINE = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=(.*)$/;

export function parseEnv(text: string): EnvEntry[] {
  const out: EnvEntry[] = [];
  const lines = text.split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!key) continue;
    out.push({ key, value: (m[2] ?? "").trim(), line: i });
  }
  return out;
}

function sanitize(value: string): string {
  return value.replace(/[\r\n]+/g, " ").trim();
}

/**
 * Rewrite values in place, keeping comments, blank lines, ordering and any
 * keys we do not know about. New keys are appended. `clear` empties a key
 * without deleting its line, so the docs above it stay put.
 */
export function upsertEnv(
  text: string,
  values: Record<string, string>,
  clear: string[] = [],
): string {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const seen = new Set<string>();

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const m = LINE.exec(line);
    if (!m) continue;
    const key = m[1];
    if (!key) continue;

    if (Object.prototype.hasOwnProperty.call(values, key)) {
      lines[i] = `${key}=${sanitize(values[key] ?? "")}`;
      seen.add(key);
      continue;
    }
    if (clear.includes(key)) {
      lines[i] = `${key}=`;
      seen.add(key);
    }
  }

  const appended: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (seen.has(key)) continue;
    appended.push(`${key}=${sanitize(value)}`);
  }
  for (const key of clear) {
    if (seen.has(key)) continue;
    appended.push(`${key}=`);
  }

  if (appended.length > 0) {
    while (lines.length > 0 && (lines[lines.length - 1] ?? "").trim() === "") lines.pop();
    lines.push("", ...appended, "");
  }

  return lines.join(eol);
}

export function envMap(text: string): Record<string, string> {
  const map: Record<string, string> = {};
  for (const entry of parseEnv(text)) map[entry.key] = entry.value;
  return map;
}
