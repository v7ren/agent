import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { upsertEnv } from "./web/envfile.ts";
import { invalidateLiveSettings } from "./live.ts";

/** Keys that live.ts reads on every liveSettings() refresh (no restart needed). */
export const LIVE_KEYS: ReadonlySet<string> = new Set([
  "DISCORD_TALK",
  "DISCORD_AMBIENT_COOLDOWN",
  "DISCORD_BURST_MIN",
  "DISCORD_ARM_MS",
  "DISCORD_SETTLE_MIN",
  "DISCORD_SETTLE_BIAS",
  "DISCORD_BUDGET",
  "DISCORD_SPONTANEOUS",
  "DISCORD_SPON_MIN",
  "DISCORD_SPON_MAX",
  "DISCORD_SPON_DM",
  "DISCORD_SPON_DM_MIN",
  "DISCORD_SPON_DM_MAX",
  "DISCORD_SPON_DM_QUIET",
  "DISCORD_SPON_QUIET",
  "DISCORD_SPON_HUSH",
  "JEV_THRESHOLD",
  "JEV_TO_ME_BONUS",
  "JEV_NOT_ME_PENALTY",
  "JEV_AIMED_BIAS",
]);

/** True when any of the keys is not one the live settings reader picks up. */
export function restartNeeded(keys: readonly string[]): boolean {
  return keys.some((k) => !LIVE_KEYS.has(k));
}

export function defaultEnvPath(): string {
  return join(process.cwd(), ".env");
}

/** Current .env text, falling back to .env.example, then to empty. */
function baseText(envPath: string): string {
  if (existsSync(envPath)) return readFileSync(envPath, "utf8");
  const example = join(process.cwd(), ".env.example");
  if (existsSync(example)) return readFileSync(example, "utf8");
  return "";
}

/**
 * The ONE place that writes .env. Keeps comments and unknown lines (via
 * upsertEnv), writes to a temp file and renames it over the target so a crash
 * never leaves a half-written file, then drops the live-settings cache.
 */
export function applyEnvUpdate(
  values: Record<string, string>,
  clear: string[] = [],
  envPath: string = defaultEnvPath(),
): void {
  const next = upsertEnv(baseText(envPath), values, clear);
  const tmp = `${envPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    writeFileSync(tmp, next, "utf8");
    renameSync(tmp, envPath);
  } catch (err) {
    if (existsSync(tmp)) unlinkSync(tmp);
    throw err;
  }
  invalidateLiveSettings();
}

/** Write one key into .env, keeping every comment and unknown line intact. */
export function setEnvValue(key: string, value: string, envPath = defaultEnvPath()): void {
  applyEnvUpdate({ [key]: value }, [], envPath);
}
