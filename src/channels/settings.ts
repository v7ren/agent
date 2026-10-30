import type { LiveSettings } from "../live.ts";
import { parseBudget } from "./burst.ts";

export interface SettingDef {
  key: string;
  env: string;
  label: string;
  parse: (raw: string) => { ok: true; value: string } | { ok: false; error: string };
}

function num(min: number, max: number, unit = "") {
  return (raw: string): { ok: true; value: string } | { ok: false; error: string } => {
    const n = Number(raw.trim());
    if (!Number.isFinite(n) || n < min || n > max) {
      return { ok: false, error: `要 ${min}–${max}${unit}` };
    }
    return { ok: true, value: String(n) };
  };
}

export const SETTINGS: SettingDef[] = [
  { key: "talk", env: "DISCORD_TALK", label: "講話意願", parse: num(0.1, 5) },
  { key: "threshold", env: "JEV_THRESHOLD", label: "接話門檻", parse: num(0, 1) },
  {
    key: "to_me",
    env: "JEV_TO_ME_BONUS",
    label: "被對著說話的加成",
    parse: num(0, 3),
  },
  { key: "not_me", env: "JEV_NOT_ME_PENALTY", label: "對別人說話的懲罰", parse: num(0, 3) },
  { key: "whisper", env: "FISHD_WHISPER_P", label: "心聲出現機率", parse: num(0, 1) },
  { key: "arm_ms", env: "DISCORD_ARM_MS", label: "上膛延遲", parse: num(0, 60000, "ms") },
  { key: "cooldown", env: "DISCORD_AMBIENT_COOLDOWN", label: "接話冷卻", parse: num(0, 3600, "秒") },
  { key: "settle", env: "DISCORD_SETTLE_MIN", label: "接完話安靜", parse: num(0, 120, "分") },
  { key: "settle_bias", env: "DISCORD_SETTLE_BIAS", label: "安靜期門檻倍率", parse: num(1, 5) },
  { key: "burst", env: "DISCORD_BURST_MIN", label: "一次看多久", parse: num(1, 120, "分") },
  {
    key: "budget",
    env: "DISCORD_BUDGET",
    label: "沉默預算",
    parse: (raw) => {
      const value = raw.trim();
      const parsed = parseBudget(value);
      if (!/^\d+\s*\/\s*\d+$/.test(value) || parsed.max <= 0 || parsed.minutes <= 0) {
        return { ok: false, error: "格式要是 `次數/分鐘`，例如 4/30" };
      }
      return { ok: true, value: `${parsed.max}/${parsed.minutes}` };
    },
  },
  {
    key: "spontaneous",
    env: "DISCORD_SPONTANEOUS",
    label: "自己冒出來",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      if (["on", "1", "true", "yes", "開"].includes(value)) return { ok: true, value: "1" };
      if (["off", "0", "false", "no", "關"].includes(value)) return { ok: true, value: "0" };
      return { ok: false, error: "要 on 或 off" };
    },
  },
  { key: "spon_min", env: "DISCORD_SPON_MIN", label: "冒出最短間隔", parse: num(1, 1440, "分") },
  { key: "spon_max", env: "DISCORD_SPON_MAX", label: "冒出最長間隔", parse: num(1, 1440, "分") },
  { key: "spon_dm_min", env: "DISCORD_SPON_DM_MIN", label: "私訊最短間隔", parse: num(1, 1440, "分") },
  { key: "spon_dm_max", env: "DISCORD_SPON_DM_MAX", label: "私訊最長間隔", parse: num(1, 1440, "分") },
  { key: "spon_dm_quiet", env: "DISCORD_SPON_DM_QUIET", label: "私訊要安靜", parse: num(0, 1440, "分") },
  { key: "spon_quiet", env: "DISCORD_SPON_QUIET", label: "頻道要安靜", parse: num(0, 1440, "分") },
  {
    key: "hush",
    env: "DISCORD_SPON_HUSH",
    label: "不主動的時段",
    parse: (raw) => {
      const value = raw.trim().toLowerCase();
      if (value === "" || value === "off" || value === "0") return { ok: true, value: "off" };
      if (!/^\d{1,2}\s*-\s*\d{1,2}$/.test(value)) {
        return { ok: false, error: "格式像 1-6，或 off" };
      }
      return { ok: true, value: value.replace(/\s+/g, "") };
    },
  },
];

export function findSetting(key: string): SettingDef | undefined {
  return SETTINGS.find((setting) => setting.key === key);
}

export function describeSettings(s: LiveSettings): string {
  return [
    `\`talk\` 講話意願 **${s.talk}**　\`threshold\` 門檻 **${s.jevThreshold}**`,
    `\`arm_ms\` 上膛 **${s.armMs}ms**　\`cooldown\` 冷卻 **${s.ambientCooldown}s**`,
    `\`settle\` 接完安靜 **${s.settleMinutes} 分**　\`burst\` 一次看 **${s.burstMs / 60_000} 分**`,
    `\`budget\` 沉默預算 **${s.budget.max}/${s.budget.minutes}**`,
    `\`spontaneous\` 自己冒出來 **${s.spontaneous ? "開" : "關"}**`,
    `頻道 **${s.sponMin}–${s.sponMax} 分**（安靜 ${s.sponQuiet} 分）　私訊 **${s.sponDmMin}–${s.sponDmMax} 分**`,
    `\`hush\` 不主動時段 **${s.hushFrom === s.hushTo ? "off" : `${s.hushFrom}-${s.hushTo}`}**`,
  ].join("\n");
}
