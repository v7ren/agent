import { SLEEPING_PHYSICS, tick } from "./mood.ts";
import type { MoodState } from "./mood.ts";
import { loadMood, loadSelf, saveMood, saveSelf } from "./persona.ts";
import { tickSelf } from "./self.ts";
import type { SelfState } from "./self.ts";

export interface Pulse {
  mood: MoodState;
  self: SelfState;
}

/**
 * One beat of her body. It is deliberately synchronous and idempotent:
 * `lastTick` in both files means a turn and a heartbeat cannot double-count
 * the same minute, and a process that was off for a day catches up once.
 */
export function pulse(stateDir: string, now = new Date()): Pulse {
  const self = tickSelf(loadSelf(stateDir, now), now);
  const mood = tick(
    loadMood(stateDir, now),
    now,
    self.sleeping ? SLEEPING_PHYSICS : undefined,
  );
  saveMood(stateDir, mood);
  saveSelf(stateDir, self);
  return { mood, self };
}

export interface BodyClockOptions {
  stateDir: string;
  /** how often to beat; the default is one minute */
  intervalMs?: number;
  now?: () => Date;
  onError?: (err: unknown) => void;
}

/**
 * Without this, time only moves when someone talks to her: a three-hour gap
 * becomes one big jump at the next message. With it, the clock keeps moving
 * and the tip at the end of a prompt can say "about two hours ago".
 */
export function startBodyClock(opts: BodyClockOptions): () => void {
  const interval = Math.max(15_000, opts.intervalMs ?? 60_000);
  const now = opts.now ?? (() => new Date());

  const beat = () => {
    try {
      pulse(opts.stateDir, now());
    } catch (err) {
      opts.onError?.(err);
    }
  };

  const timer = setInterval(beat, interval);
  // A timer alone must not keep a CLI process alive.
  timer.unref?.();
  return () => clearInterval(timer);
}
