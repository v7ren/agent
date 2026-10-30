import { envFlag, envNumber, reloadEnv } from "./env.ts";
import { parseBudget } from "./channels/burst.ts";
import { parseHush } from "./channels/spontaneous.ts";

export interface LiveSettings {
  /** responsiveness: divides the gate threshold */
  talk: number;
  ambientCooldown: number;
  burstMs: number;
  armMs: number;
  settleMinutes: number;
  settleBias: number;
  budget: { max: number; minutes: number };
  spontaneous: boolean;
  sponMin: number;
  sponMax: number;
  sponDm: boolean;
  sponDmMin: number;
  sponDmMax: number;
  sponDmQuiet: number;
  sponQuiet: number;
  hushFrom: number;
  hushTo: number;
  jevThreshold: number;
  jevToMeBonus: number;
  jevNotMePenalty: number;
  /** how much more confident Jev must be before she speaks on a line meant for someone else */
  aimedBias: number;
}

/** Pure read of the current environment, so it is testable. */
export function readLiveSettings(): LiveSettings {
  const hush = parseHush(process.env.DISCORD_SPON_HUSH);

  return {
    talk: envNumber("DISCORD_TALK", 1, 0.1),
    ambientCooldown: envNumber("DISCORD_AMBIENT_COOLDOWN", 60, 0),
    burstMs: envNumber("DISCORD_BURST_MIN", 10, 1) * 60_000,
    armMs: envNumber("DISCORD_ARM_MS", 3000, 0),
    settleMinutes: envNumber("DISCORD_SETTLE_MIN", 3, 0),
    settleBias: envNumber("DISCORD_SETTLE_BIAS", 1, 0.1),
    budget: parseBudget(process.env.DISCORD_BUDGET ?? "4/30"),
    spontaneous: envFlag("DISCORD_SPONTANEOUS"),
    sponMin: envNumber("DISCORD_SPON_MIN", 90, 1),
    sponMax: envNumber("DISCORD_SPON_MAX", 240, 1),
    sponDm: envFlag("DISCORD_SPON_DM", true),
    sponDmMin: envNumber("DISCORD_SPON_DM_MIN", 60, 1),
    sponDmMax: envNumber("DISCORD_SPON_DM_MAX", 180, 1),
    sponDmQuiet: envNumber(
      "DISCORD_SPON_DM_QUIET",
      envNumber("DISCORD_SPON_QUIET", 20, 0),
      0,
    ),
    sponQuiet: envNumber("DISCORD_SPON_QUIET", 20, 0),
    hushFrom: hush.from,
    hushTo: hush.to,
    jevThreshold: envNumber("JEV_THRESHOLD", 0.32, 0),
    jevToMeBonus: envNumber("JEV_TO_ME_BONUS", 0.5, 0),
    jevNotMePenalty: envNumber("JEV_NOT_ME_PENALTY", 0.35, 0),
    aimedBias: envNumber("JEV_AIMED_BIAS", 2.5, 1),
  };
}

let cached: { at: number; value: LiveSettings } | null = null;
const TTL = 3000;

/**
 * Settings that take effect within a few seconds of editing .env: how eager
 * she is, how long she waits, how often she speaks up. Model, persona and
 * Discord login still need a restart.
 */
export function liveSettings(): LiveSettings {
  const now = Date.now();
  if (cached && now - cached.at < TTL) return cached.value;

  reloadEnv();
  const value = readLiveSettings();
  cached = { at: now, value };
  return value;
}

/** After writing settings ourselves, skip the 3s wait. */
export function invalidateLiveSettings(): void {
  cached = null;
}
