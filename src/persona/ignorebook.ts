import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * People she has chosen (or been told) to ignore, even when they @ her.
 * She can only do it to non-owners, only for a limited time, and only a few
 * at once; the owner can ignore anyone indefinitely and can lift any of it.
 */
export interface IgnoreEntry {
  id: string;
  name: string;
  /** ISO time the ignoring ends; "" means until the owner lifts it */
  until: string;
  reason: string;
  by: "self" | "owner";
  at: string;
}

export const SELF_MIN_MINUTES = 5;
export const SELF_DEFAULT_MINUTES = 60;
export const SELF_MAX_MINUTES = 24 * 60;
export const SELF_MAX_ENTRIES = 8;
const HARD_MAX_ENTRIES = 50;

const ID = /^[A-Za-z0-9_-]{1,32}$/;

function oneLine(value: unknown, max: number): string {
  return String(value ?? "")
    .replace(/[\r\n\t]+/g, " ")
    .replace(/[<>@`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, max);
}

function isEntry(v: unknown): v is IgnoreEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    ID.test(o.id) &&
    typeof o.name === "string" &&
    typeof o.until === "string" &&
    typeof o.reason === "string" &&
    (o.by === "self" || o.by === "owner") &&
    typeof o.at === "string"
  );
}

export interface IgnoreResult {
  ok: boolean;
  reason?: string;
  entry?: IgnoreEntry;
}

export class IgnoreBook {
  private path: string;
  private ownerIds: () => readonly string[];

  constructor(opts: { path: string; ownerIds: () => readonly string[] }) {
    this.path = opts.path;
    this.ownerIds = opts.ownerIds;
  }

  private load(): IgnoreEntry[] {
    try {
      if (!existsSync(this.path)) return [];
      const raw: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (!Array.isArray(raw)) return [];
      return raw.filter(isEntry).slice(0, HARD_MAX_ENTRIES);
    } catch {
      return [];
    }
  }

  private save(entries: IgnoreEntry[]): void {
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(entries, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  private live(entries: IgnoreEntry[], now: Date): IgnoreEntry[] {
    const owners = new Set(this.ownerIds());
    return entries.filter((e) => {
      // An owner is never ignored, even if the list says so.
      if (owners.has(e.id)) return false;
      if (e.until === "") return true;
      const end = Date.parse(e.until);
      return Number.isFinite(end) && end > now.getTime();
    });
  }

  /** Everyone currently ignored. */
  active(now: Date = new Date()): IgnoreEntry[] {
    return this.live(this.load(), now);
  }

  isIgnored(id: string, now: Date = new Date()): boolean {
    return this.active(now).some((e) => e.id === id);
  }

  add(
    args: { id: string; name: string; minutes?: number; reason?: string },
    by: "self" | "owner",
    now: Date = new Date(),
  ): IgnoreResult {
    const id = String(args.id ?? "").trim();
    if (!ID.test(id)) return { ok: false, reason: "不認得這個人" };
    if (this.ownerIds().includes(id)) return { ok: false, reason: "那是主人，不能不理" };

    let until = "";
    if (by === "self") {
      const asked = Number.isFinite(args.minutes) ? Number(args.minutes) : SELF_DEFAULT_MINUTES;
      const minutes = Math.min(SELF_MAX_MINUTES, Math.max(SELF_MIN_MINUTES, Math.round(asked)));
      until = new Date(now.getTime() + minutes * 60_000).toISOString();
    } else if (Number.isFinite(args.minutes) && Number(args.minutes) > 0) {
      until = new Date(now.getTime() + Number(args.minutes) * 60_000).toISOString();
    }

    const current = this.active(now);
    const mine = current.filter((e) => e.by === "self" && e.id !== id);
    if (by === "self") {
      const existing = current.find((e) => e.id === id);
      // She may not shorten or replace something the owner set.
      if (existing && existing.by === "owner") {
        return { ok: false, reason: "這是主人設的，你不能改" };
      }
      if (mine.length >= SELF_MAX_ENTRIES) {
        return { ok: false, reason: `你同時最多只能不理 ${SELF_MAX_ENTRIES} 個人` };
      }
    }

    const entry: IgnoreEntry = {
      id,
      name: oneLine(args.name, 30) || id,
      until,
      reason: oneLine(args.reason, 40),
      by,
      at: now.toISOString(),
    };
    this.save([...current.filter((e) => e.id !== id), entry].slice(-HARD_MAX_ENTRIES));
    return { ok: true, entry };
  }

  remove(id: string, by: "self" | "owner", now: Date = new Date()): IgnoreResult {
    const current = this.active(now);
    const found = current.find((e) => e.id === id);
    if (!found) return { ok: false, reason: "沒有在不理這個人" };
    if (found.by === "owner" && by !== "owner") {
      return { ok: false, reason: "這是主人設的，只有主人能解除" };
    }
    this.save(current.filter((e) => e.id !== id));
    return { ok: true, entry: found };
  }

  /** A short line for her prompt, so she knows who she is not talking to. */
  render(now: Date = new Date()): string {
    const list = this.active(now);
    if (list.length === 0) return "";
    const p = (n: number) => String(n).padStart(2, "0");
    const bits = list.map((e) => {
      const end = e.until === "" ? "直到主人解除" : (() => {
        const d = new Date(e.until);
        return `到 ${p(d.getHours())}:${p(d.getMinutes())}`;
      })();
      return `${e.name}（${end}${e.reason ? `，${e.reason}` : ""}${e.by === "owner" ? "，主人設的" : ""}）`;
    });
    return `（你現在不理的人：${bits.join("；")}。他們說話你不會回，也不用為此解釋。）`;
  }
}
