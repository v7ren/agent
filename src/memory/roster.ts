import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * Who was in a room, kept next to its saved history. Without it, a restart
 * forgets everybody's id and the compaction cannot attach what it learned to
 * the right person's note.
 */
export interface RosterEntry {
  id: string;
  name: string;
  lastAt: number;
  rooms: string[];
}

const ID = /^[A-Za-z0-9_-]{1,32}$/;
const MAX_PEOPLE = 50;

/** history/<stem>.json -> history/<stem>.roster.json */
export function rosterPath(historyFile: string): string {
  return historyFile.replace(/\.json$/i, "") + ".roster.json";
}

export function saveRoster(path: string, people: readonly RosterEntry[]): void {
  try {
    const clean = people
      .filter((p) => ID.test(p.id) && p.name.trim() !== "")
      .sort((a, b) => b.lastAt - a.lastAt)
      .slice(0, MAX_PEOPLE)
      .map((p) => ({
        id: p.id,
        name: p.name.slice(0, 60),
        lastAt: Number.isFinite(p.lastAt) ? p.lastAt : 0,
        rooms: p.rooms.slice(0, 10).map((r) => r.slice(0, 60)),
      }));
    mkdirSync(dirname(path), { recursive: true });
    const tmp = `${path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(clean), "utf8");
    renameSync(tmp, path);
  } catch {
    // The roster is a convenience; never cost a reply over it.
  }
}

export function loadRoster(path: string): RosterEntry[] {
  try {
    const raw: unknown = JSON.parse(readFileSync(path, "utf8"));
    if (!Array.isArray(raw)) return [];
    const out: RosterEntry[] = [];
    for (const item of raw.slice(0, MAX_PEOPLE)) {
      if (typeof item !== "object" || item === null) continue;
      const o = item as Record<string, unknown>;
      if (typeof o.id !== "string" || !ID.test(o.id)) continue;
      if (typeof o.name !== "string" || o.name.trim() === "") continue;
      out.push({
        id: o.id,
        name: o.name.slice(0, 60),
        lastAt: typeof o.lastAt === "number" && Number.isFinite(o.lastAt) ? o.lastAt : 0,
        rooms: Array.isArray(o.rooms)
          ? o.rooms.filter((r): r is string => typeof r === "string").slice(0, 10)
          : [],
      });
    }
    return out;
  } catch {
    return [];
  }
}
