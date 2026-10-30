import type { Mood } from "./mood.ts";

export interface Mark {
  at: string;
  note: string;
}

/**
 * Everything the fish can change about herself. Mood/energy/hunger live in
 * mood.json; this is the rest of her inner life.
 */
export interface SelfState {
  /** 0..100, rises when nobody talks to her */
  boredom: number;
  /**
   * 0..100, a different animal from boredom: it keeps growing while he is
   * away and only partly drains when she reaches out.
   */
  longing: number;
  /** ISO time of the last human message, "" when she has never met anyone */
  lastSeen: string;
  /** ISO time of the last physics tick, so a heartbeat and a turn agree */
  lastTick: string;
  /** she chose to sleep; spontaneous turns stay quiet until she wakes */
  sleeping: boolean;
  /** ISO time she will wake on her own; "" when awake or no alarm */
  sleepUntil: string;
  slacking: boolean;
  /** what she is doing right now, in her own words */
  task: { what: string; since: string } | null;
  /** when she next wants to speak up, and about what */
  plan: { at: string; topic: string; why: string; deferred: number } | null;
  /** something she wanted to say but never got to say */
  pending: string | null;
  /** small marks left while thinking of him; newest last */
  marks: Mark[];
}

export interface SelfPatch {
  hunger?: number;
  energy?: number;
  mood?: Mood;
  intensity?: 1 | 2 | 3;
  boredom?: number;
  longing?: number;
  sleeping?: boolean;
  /** how long this sleep lasts; default 8 hours */
  sleepMinutes?: number;
  slacking?: boolean;
  task?: string | null;
  planMinutes?: number;
  planTopic?: string;
  planWhy?: string;
  clearPlan?: boolean;
  pending?: string | null;
  /** leave a small mark that he can notice later */
  mark?: string;
  clearMarks?: boolean;
  /** push the current plan forward; used when it is not a good time */
  planDeferMinutes?: number;
}

export function emptySelf(): SelfState {
  return {
    boredom: 20,
    longing: 0,
    lastSeen: "",
    lastTick: "",
    sleeping: false,
    sleepUntil: "",
    slacking: false,
    task: null,
    plan: null,
    pending: null,
    marks: [],
  };
}

const clamp = (n: number) => Math.min(100, Math.max(0, n));

function validMs(value: string): number | null {
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/**
 * Advance the slow metabolism. `lastTick` makes this safe to call from both
 * the minute heartbeat and a turn: the same elapsed minute is never counted
 * twice, and a machine that was off for a day catches up once.
 */
export function tickSelf(s: SelfState, now: Date): SelfState {
  const wakeAt = validMs(s.sleepUntil);
  const woke = s.sleeping && wakeAt !== null && now.getTime() >= wakeAt;
  const base = woke ? { ...s, sleeping: false, sleepUntil: "" } : s;

  const last = validMs(s.lastTick);
  if (last === null) return { ...base, lastTick: now.toISOString() };

  const elapsedMin = Math.max(0, (now.getTime() - last) / 60_000);
  if (elapsedMin === 0) return base;

  const seen = validMs(s.lastSeen);
  const near = seen !== null && now.getTime() - seen < 5 * 60_000;

  const boredomRate = base.sleeping ? 0.1 : 0.35;
  const longingRate = base.sleeping ? 0.08 : 0.18;

  return {
    ...base,
    boredom: clamp(base.boredom + (near ? 0 : elapsedMin * boredomRate)),
    longing: clamp(base.longing + (near ? 0 : elapsedMin * longingRate)),
    lastTick: now.toISOString(),
  };
}

/** A human message: the room gets warmer, the number drains a lot. */
export function touchSelf(s: SelfState, now: Date): SelfState {
  return {
    ...s,
    lastSeen: now.toISOString(),
    lastTick: now.toISOString(),
    sleeping: false,
    sleepUntil: "",
    boredom: clamp(s.boredom - 25),
    longing: clamp(s.longing - 45),
  };
}

/** She reaches out herself: the pressure drops, but not to zero. */
export function reachOut(s: SelfState, now: Date): SelfState {
  return { ...s, longing: clamp(s.longing - 15), lastTick: now.toISOString() };
}

export function applySelf(
  s: SelfState,
  patch: SelfPatch,
  now: Date,
): { state: SelfState; log: string[] } {
  const next: SelfState = { ...s };
  const log: string[] = [];

  if (typeof patch.boredom === "number") {
    next.boredom = clamp(patch.boredom);
    log.push(`boredom=${Math.round(next.boredom)}`);
  }

  if (typeof patch.longing === "number") {
    next.longing = clamp(patch.longing);
    log.push(`longing=${Math.round(next.longing)}`);
  }

  if (typeof patch.sleeping === "boolean") {
    next.sleeping = patch.sleeping;
    if (patch.sleeping) {
      const minutes = Math.min(1440, Math.max(30, patch.sleepMinutes ?? 480));
      next.sleepUntil = new Date(now.getTime() + minutes * 60_000).toISOString();
      log.push(`去睡了 ${Math.round(minutes / 60)} 小時`);
    } else {
      next.sleepUntil = "";
      log.push("醒了");
    }
  }

  if (typeof patch.slacking === "boolean") {
    next.slacking = patch.slacking;
    log.push(patch.slacking ? "摸魚" : "不摸魚了");
  }

  if (patch.task !== undefined) {
    if (patch.task === null || patch.task.trim() === "") {
      next.task = null;
      log.push("放下手邊的事");
    } else {
      next.task = { what: patch.task.trim().slice(0, 120), since: now.toISOString() };
      log.push(`開始：${next.task.what}`);
    }
  }

  if (patch.pending !== undefined) {
    const text = (patch.pending ?? "").trim().slice(0, 120);
    if (text === "") {
      next.pending = null;
      log.push("放下沒說出口的話");
    } else {
      next.pending = text;
      log.push(`先記著：${text}`);
    }
  }

  if (patch.clearMarks) {
    next.marks = [];
    log.push("擦掉記號");
  }

  if (typeof patch.mark === "string") {
    const note = patch.mark.replace(/\s+/g, " ").trim().slice(0, 40);
    if (note !== "") {
      next.marks = [...next.marks, { at: now.toISOString(), note }].slice(-8);
      log.push(`留記號：${note}`);
    }
  }

  if (patch.clearPlan) {
    next.plan = null;
    log.push("取消計畫");
  } else if (typeof patch.planDeferMinutes === "number" && next.plan) {
    const minutes = Math.min(2880, Math.max(1, patch.planDeferMinutes));
    next.plan = {
      ...next.plan,
      at: new Date(now.getTime() + minutes * 60_000).toISOString(),
      deferred: next.plan.deferred + 1,
    };
    log.push(`往後延 ${minutes} 分`);
  } else if (typeof patch.planMinutes === "number" && patch.planMinutes > 0) {
    const topic = (patch.planTopic ?? "").trim().slice(0, 80);
    if (topic !== "") {
      const minutes = Math.min(2880, Math.max(1, patch.planMinutes));
      next.plan = {
        at: new Date(now.getTime() + minutes * 60_000).toISOString(),
        topic,
        why: (patch.planWhy ?? "").trim().slice(0, 80),
        deferred: 0,
      };
      log.push(`計畫 ${minutes} 分後聊「${topic}」`);
    }
  }

  return { state: next, log };
}

export function planDue(s: SelfState, now: Date): boolean {
  if (!s.plan) return false;
  const at = Date.parse(s.plan.at);
  return Number.isFinite(at) && at <= now.getTime();
}

function band(value: number): string {
  if (value >= 80) return "想他想到尾巴拍地";
  if (value >= 50) return "很想他";
  if (value >= 20) return "有點想他";
  return "";
}

/** One compact line for the prompt tail. */
export function renderSelf(s: SelfState, now: Date): string {
  const parts: string[] = [];

  if (s.sleeping) {
    const wakeAt = validMs(s.sleepUntil);
    const hours = wakeAt === null ? null : Math.max(0, (wakeAt - now.getTime()) / 3_600_000);
    parts.push(hours === null ? "你正在睡" : `你正在睡（大約 ${Math.ceil(hours)} 小時後會自己醒）`);
  }
  if (s.slacking) parts.push("你正在摸魚");
  if (s.boredom >= 60) parts.push("有點無聊");
  else if (s.boredom <= 10) parts.push("現在挺有精神");

  const miss = band(s.longing);
  if (miss !== "") parts.push(miss);

  if (s.task) parts.push(`手頭的事：${s.task.what}`);
  if (s.plan) {
    const at = Date.parse(s.plan.at);
    if (Number.isFinite(at)) {
      const minutes = Math.round((at - now.getTime()) / 60_000);
      const held = s.plan.deferred > 0 ? "（已經忍過一次）" : "";
      parts.push(
        minutes > 0
          ? `你打算 ${minutes} 分鐘後聊「${s.plan.topic}」${held}`
          : `你本來想聊「${s.plan.topic}」${held}`,
      );
    }
  }
  if (s.pending) parts.push(`有句話還沒跟他說：${s.pending}`);

  const mark = s.marks[s.marks.length - 1];
  if (mark) {
    const mins = Math.max(0, Math.round((now.getTime() - Date.parse(mark.at)) / 60_000));
    const when = mins < 60 ? `${mins} 分鐘前` : `${Math.round(mins / 60)} 小時前`;
    parts.push(`你${when}留過記號：「${mark.note}」`);
  }

  const seen = validMs(s.lastSeen);
  if (seen !== null) {
    const hours = (now.getTime() - seen) / 3_600_000;
    if (hours >= 1) parts.push(`你們上次說話是 ${Math.round(hours)} 小時前`);
  }

  return parts.length === 0 ? "" : `（你自己：${parts.join("；")}）`;
}
