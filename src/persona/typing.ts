// Pure in-memory tracker for "started typing, then sent nothing".
// Discord only emits typing-start events (about 10s each), so a user is
// considered to have abandoned a message when typing went quiet for 15s
// without a following message, after a real typing span of at least 8s.
// All timestamps are epoch milliseconds supplied by the caller.

export type Abandoned = {
  userId: string;
  channelId: string;
  startedAt: number;
  lastTypedAt: number;
  typedForMs: number;
};

const QUIET_MS = 15_000;
const MIN_SPAN_MS = 8_000;
const EXPIRY_MS = 10 * 60_000;
const MAX_PAIRS = 200;
const ID_PATTERN = /^[A-Za-z0-9_.-]{1,64}$/;

type Entry = {
  userId: string;
  channelId: string;
  firstTypedAt: number;
  lastTypedAt: number;
};

function validId(id: unknown): id is string {
  return typeof id === "string" && ID_PATTERN.test(id);
}

function validAt(at: unknown): at is number {
  return typeof at === "number" && Number.isFinite(at);
}

export class TypingTracker {
  // Insertion order doubles as recency order: refreshed pairs are re-inserted
  // at the end, so the first key is always the least recently active pair.
  private entries = new Map<string, Entry>();

  typingStart(userId: string, channelId: string, at: number): void {
    if (!validId(userId) || !validId(channelId) || !validAt(at)) return;
    const key = keyOf(userId, channelId);
    const prev = this.entries.get(key);
    this.entries.delete(key);
    const entry: Entry = prev
      ? { ...prev, lastTypedAt: Math.max(prev.lastTypedAt, at) }
      : { userId, channelId, firstTypedAt: at, lastTypedAt: at };
    this.entries.set(key, entry);
    while (this.entries.size > MAX_PAIRS) {
      const oldest = this.entries.keys().next().value;
      if (oldest === undefined) break;
      this.entries.delete(oldest);
    }
  }

  messageSent(userId: string, channelId: string, at: number): void {
    if (!validId(userId) || !validId(channelId) || !validAt(at)) return;
    this.entries.delete(keyOf(userId, channelId));
  }

  abandoned(now: number): Abandoned[] {
    const out: Abandoned[] = [];
    if (!validAt(now)) return out;
    for (const [key, e] of this.entries) {
      const quiet = now - e.lastTypedAt;
      if (quiet > EXPIRY_MS) {
        this.entries.delete(key);
        continue;
      }
      if (quiet < QUIET_MS) continue;
      // Quiet long enough: either reported as abandoned or ignored as a blip.
      this.entries.delete(key);
      const typedForMs = e.lastTypedAt - e.firstTypedAt;
      if (typedForMs >= MIN_SPAN_MS) {
        out.push({
          userId: e.userId,
          channelId: e.channelId,
          startedAt: e.firstTypedAt,
          lastTypedAt: e.lastTypedAt,
          typedForMs,
        });
      }
    }
    return out;
  }
}

function keyOf(userId: string, channelId: string): string {
  return `${userId}\u0000${channelId}`;
}

function durationPhrase(ms: number): string {
  if (ms < 20_000) return "幾秒";
  if (ms < 50_000) return "半分鐘";
  if (ms < 150_000) return "一兩分鐘";
  return "好幾分鐘";
}

export function renderAbandoned(
  e: { typedForMs: number; lastTypedAt: number },
  now: number,
): string {
  if (now - e.lastTypedAt > EXPIRY_MS) return "";
  const d = durationPhrase(e.typedForMs);
  return `（他剛剛好像打了${d}的字，後來沒有送出來。不知道他想說什麼，別追問太兇，可以輕輕問一句。）`;
}
