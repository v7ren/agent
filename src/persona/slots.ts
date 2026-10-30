import { randomUUID } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export const MIN_SLOTS = 5;
export const MAX_SLOTS = 10;

const MAX_TEXT = 120;
const MAX_WHY = 80;
const MAX_LOG = 50;

export type Pinner = "self" | "owner";

export type Slot = {
  id: string;
  text: string;
  why: string;
  createdAt: string;
  lastReadAt: string;
  pinnedBy: Pinner;
};

export type LogEntry = {
  at: string;
  action: "add" | "remove" | "replace" | "prune";
  id: string;
  text: string;
};

export type SlotStore = { slots: Slot[]; log: LogEntry[] };

export type SlotInput = { text: string; why: string };

export type SlotResult = { store: SlotStore; ok: boolean; reason?: string };

export type PruneResult = { store: SlotStore; removed: Slot[] };

export function emptyStore(): SlotStore {
  return { slots: [], log: [] };
}

function appendLog(log: LogEntry[], entry: LogEntry): LogEntry[] {
  const next = [...log, entry];
  return next.length > MAX_LOG ? next.slice(next.length - MAX_LOG) : next;
}

const CONTROL_CHARS = /[\x00-\x1f\x7f-\x9f]/g;

/**
 * A slot is rendered as one prompt line, so it must be a single line of plain
 * text: control chars and runs of whitespace collapse to one space, and a
 * leading '-' or markdown heading marker is removed so it cannot imitate structure.
 */
function normalizeText(raw: string): string {
  return raw
    .replace(CONTROL_CHARS, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/^(?:#{1,6}\s*|-\s*)+/, "")
    .trim();
}

function normalizeInput(input: SlotInput): SlotInput {
  return { text: normalizeText(input.text), why: normalizeText(input.why) };
}

function validateInput(input: SlotInput): string | null {
  const { text, why } = normalizeInput(input);
  if (text.length < 1) return "text is empty";
  if (text.length > MAX_TEXT) return `text exceeds ${MAX_TEXT} chars`;
  if (why.length > MAX_WHY) return `why exceeds ${MAX_WHY} chars`;
  return null;
}

function leastRecentlyRead(slots: Slot[]): Slot | undefined {
  const sorted = [...slots].sort(
    (a, b) =>
      (Date.parse(a.lastReadAt) || 0) - (Date.parse(b.lastReadAt) || 0) ||
      (Date.parse(a.createdAt) || 0) - (Date.parse(b.createdAt) || 0),
  );
  return sorted[0];
}

export function addSlot(
  store: SlotStore,
  input: SlotInput,
  now: string,
  by: Pinner,
): SlotResult {
  const err = validateInput(input);
  if (err) return { store, ok: false, reason: err };

  const { text, why } = normalizeInput(input);

  if (store.slots.some((s) => s.text === text)) {
    return { store, ok: false, reason: "duplicate slot text" };
  }

  if (store.slots.length >= MAX_SLOTS) {
    const lru = leastRecentlyRead(store.slots);
    return {
      store,
      ok: false,
      reason: `slots full (${MAX_SLOTS}/${MAX_SLOTS}); least recently read: ${lru?.id ?? "none"}; replace or remove it first`,
    };
  }

  const slot: Slot = {
    id: randomUUID(),
    text,
    why,
    createdAt: now,
    lastReadAt: now,
    pinnedBy: by,
  };

  return {
    store: {
      slots: [...store.slots, slot],
      log: appendLog(store.log, { at: now, action: "add", id: slot.id, text }),
    },
    ok: true,
  };
}

export function replaceSlot(
  store: SlotStore,
  id: string,
  input: SlotInput,
  now: string,
  by: Pinner,
): SlotResult {
  const old = store.slots.find((s) => s.id === id);
  if (!old) return { store, ok: false, reason: "slot not found" };
  if (old.pinnedBy === "owner" && by !== "owner") {
    return { store, ok: false, reason: "slot is pinned by owner" };
  }
  const err = validateInput(input);
  if (err) return { store, ok: false, reason: err };

  const { text, why } = normalizeInput(input);

  if (store.slots.some((s) => s.id !== id && s.text === text)) {
    return { store, ok: false, reason: "duplicate slot text" };
  }

  const next: Slot = { ...old, text, why, lastReadAt: now, pinnedBy: by };
  return {
    store: {
      slots: store.slots.map((s) => (s.id === id ? next : s)),
      log: appendLog(store.log, { at: now, action: "replace", id, text }),
    },
    ok: true,
  };
}

export function removeSlot(
  store: SlotStore,
  id: string,
  now: string,
  by: Pinner,
): SlotResult {
  const old = store.slots.find((s) => s.id === id);
  if (!old) return { store, ok: false, reason: "slot not found" };
  if (old.pinnedBy === "owner" && by !== "owner") {
    return { store, ok: false, reason: "slot is pinned by owner" };
  }
  return {
    store: {
      slots: store.slots.filter((s) => s.id !== id),
      log: appendLog(store.log, { at: now, action: "remove", id, text: old.text }),
    },
    ok: true,
  };
}

export function touchSlot(store: SlotStore, id: string, now: string): SlotStore {
  return {
    ...store,
    slots: store.slots.map((s) => (s.id === id ? { ...s, lastReadAt: now } : s)),
  };
}

export function pruneStale(
  store: SlotStore,
  now: string,
  olderThanDays: number,
): PruneResult {
  const cutoff = Date.parse(now) - olderThanDays * 24 * 60 * 60 * 1000;
  const candidates = store.slots
    .filter((s) => s.pinnedBy === "self" && Date.parse(s.lastReadAt) < cutoff)
    .sort((a, b) => Date.parse(a.lastReadAt) - Date.parse(b.lastReadAt));

  let current = store;
  const removed: Slot[] = [];
  for (const slot of candidates) {
    if (current.slots.length <= MIN_SLOTS) break;
    removed.push(slot);
    current = {
      slots: current.slots.filter((s) => s.id !== slot.id),
      log: appendLog(current.log, { at: now, action: "prune", id: slot.id, text: slot.text }),
    };
  }
  return { store: current, removed };
}

export function renderSlots(store: SlotStore): string {
  if (store.slots.length === 0) return "";
  const lines = store.slots.map((s) =>
    s.why ? `- ${s.text}（${s.why}）` : `- ${s.text}`,
  );
  return ["永久記憶：", ...lines].join("\n");
}

function isSlot(v: unknown): v is Slot {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.id === "string" &&
    o.id.length > 0 &&
    typeof o.text === "string" &&
    typeof o.why === "string" &&
    typeof o.createdAt === "string" &&
    typeof o.lastReadAt === "string" &&
    (o.pinnedBy === "self" || o.pinnedBy === "owner")
  );
}

function isLogEntry(v: unknown): v is LogEntry {
  if (typeof v !== "object" || v === null) return false;
  const o = v as Record<string, unknown>;
  return (
    typeof o.at === "string" &&
    (o.action === "add" || o.action === "remove" || o.action === "replace" || o.action === "prune") &&
    typeof o.id === "string" &&
    typeof o.text === "string"
  );
}

function clamp(raw: unknown): SlotStore {
  if (typeof raw !== "object" || raw === null) return emptyStore();
  const o = raw as Record<string, unknown>;

  const seen = new Set<string>();
  const valid: Slot[] = [];
  if (Array.isArray(o.slots)) {
    for (const item of o.slots) {
      if (!isSlot(item) || seen.has(item.id)) continue;
      // Loaded text is normalised the same way as input, then length-checked.
      const { text, why } = normalizeInput(item);
      if (text.length < 1 || text.length > MAX_TEXT || why.length > MAX_WHY) continue;
      seen.add(item.id);
      valid.push({ ...item, text, why });
    }
  }

  let slots = valid;
  if (slots.length > MAX_SLOTS) {
    const keep = new Set(
      [...valid]
        .sort((a, b) => (Date.parse(b.lastReadAt) || 0) - (Date.parse(a.lastReadAt) || 0))
        .slice(0, MAX_SLOTS)
        .map((s) => s.id),
    );
    slots = valid.filter((s) => keep.has(s.id));
  }

  const log = Array.isArray(o.log) ? o.log.filter(isLogEntry) : [];
  return { slots, log: log.length > MAX_LOG ? log.slice(log.length - MAX_LOG) : log };
}

export function loadStore(path: string): SlotStore {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return emptyStore();
  }
  return clamp(raw);
}

export function saveStore(path: string, store: SlotStore): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, path);
}
