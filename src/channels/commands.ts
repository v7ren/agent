import { SlashCommandBuilder } from "discord.js";
import type { CacheStat } from "../types.ts";
import type { MoodState } from "../persona/mood.ts";
import { SETTINGS } from "./settings.ts";

const MOOD_LABEL: Record<string, string> = {
  genki: "元氣",
  sleepy: "想睡",
  hungry: "餓",
  tsundere: "傲嬌",
};

function bar(value: number, width = 10): string {
  const filled = Math.round((Math.min(100, Math.max(0, value)) / 100) * width);
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`;
}

export function formatMood(mood: MoodState): string {
  return [
    `心情：**${MOOD_LABEL[mood.mood] ?? mood.mood}** ${"▮".repeat(mood.intensity)}`,
    `精神：\`${bar(mood.energy)}\` ${Math.round(mood.energy)}`,
    `肚子：\`${bar(mood.hunger)}\` ${Math.round(mood.hunger)}`,
  ].join("\n");
}

export function formatStats(stat: CacheStat, turns: number): string {
  const total = stat.hitTokens + stat.missTokens;
  const rate = total === 0 ? 0 : (stat.hitTokens / total) * 100;
  const saved = Math.max(0, stat.naiveCostUsd - stat.costUsd);

  return [
    `回合：**${turns}**`,
    `快取命中：**${rate.toFixed(0)}%**（${stat.hitTokens.toLocaleString()} tok）`,
    `花費：**$${stat.costUsd.toFixed(4)}** · 省下 $${saved.toFixed(4)}`,
  ].join("\n");
}

/** Commands that expose the vault: owners only. (/config set is owner-only in discord.ts.) */
export const OWNER_ONLY = new Set(["recall", "diary", "tune", "ignore", "rule"]);

export const COMMANDS = [
  new SlashCommandBuilder().setName("ping").setDescription("看看本鯨還在不在"),
  new SlashCommandBuilder().setName("mood").setDescription("本鯨現在的心情"),
  new SlashCommandBuilder().setName("stats").setDescription("快取命中率與花費"),
  new SlashCommandBuilder()
    .setName("recall")
    .setDescription("翻本鯨的記憶（只有主人能用）")
    .addStringOption((option) =>
      option.setName("query").setDescription("關鍵字，中文或名字都可以").setRequired(true),
    ),
  new SlashCommandBuilder()
    .setName("diary")
    .setDescription("讀本鯨某天的日記（只有主人能用）")
    .addStringOption((option) =>
      option.setName("date").setDescription("YYYY-MM-DD，不填就是今天"),
    ),
  new SlashCommandBuilder()
    .setName("config")
    .setDescription("看或改行為設定（只有主人能改）")
    .addSubcommand((sub) => sub.setName("show").setDescription("看目前的設定"))
    .addSubcommand((sub) =>
      sub
        .setName("set")
        .setDescription("改一個設定，立刻生效")
        .addStringOption((option) =>
          option
            .setName("key")
            .setDescription("要改哪一個")
            .setRequired(true)
            .addChoices(
              ...SETTINGS.slice(0, 25).map((setting) => ({
                name: `${setting.key} · ${setting.label}`,
                value: setting.key,
              })),
            ),
        )
        .addStringOption((option) =>
          option.setName("value").setDescription("新值").setRequired(true),
        ),
    ),
  new SlashCommandBuilder()
    .setName("tune")
    .setDescription("她自己調的設定：看、同意、還原（只有主人能用）")
    .addSubcommand((sub) => sub.setName("list").setDescription("等待同意的和最近的改動"))
    .addSubcommand((sub) =>
      sub
        .setName("approve")
        .setDescription("同意一個超出她範圍的改動")
        .addStringOption((option) => option.setName("id").setDescription("改動的 id").setRequired(true)),
    )
    .addSubcommand((sub) =>
      sub
        .setName("undo")
        .setDescription("還原一個已套用的改動")
        .addStringOption((option) => option.setName("id").setDescription("改動的 id").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("ignore")
    .setDescription("讓她不理某個人，連 @ 她也不回（只有主人能用）")
    .addSubcommand((sub) => sub.setName("list").setDescription("現在不理誰"))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("不理某個人")
        .addUserOption((option) => option.setName("user").setDescription("誰").setRequired(true))
        .addIntegerOption((option) =>
          option
            .setName("minutes")
            .setDescription("不理多久（分鐘）；不填 = 直到你解除")
            .setMinValue(1)
            .setMaxValue(60 * 24 * 365),
        )
        .addStringOption((option) => option.setName("reason").setDescription("原因，可省略")),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("解除")
        .addUserOption((option) => option.setName("user").setDescription("誰").setRequired(true)),
    ),
  new SlashCommandBuilder()
    .setName("rule")
    .setDescription("你交代她一直要遵守的規矩（只有主人能用）")
    .addSubcommand((sub) => sub.setName("list").setDescription("現在有哪些規矩"))
    .addSubcommand((sub) =>
      sub
        .setName("add")
        .setDescription("新增一條規矩")
        .addStringOption((option) =>
          option.setName("text").setDescription("規矩的內容").setRequired(true).setMaxLength(160),
        ),
    )
    .addSubcommand((sub) =>
      sub
        .setName("remove")
        .setDescription("刪掉一條規矩")
        .addStringOption((option) =>
          option.setName("id").setDescription("編號（/rule list 看得到）").setRequired(true),
        ),
    ),
  new SlashCommandBuilder().setName("help").setDescription("指令說明"),
];

export const HELP =
  "`/mood` 心情 · `/stats` 快取與花費 · `/recall <關鍵字>` 翻記憶 · " +
  "`/diary [YYYY-MM-DD]` 讀日記 · `/config show` 看設定 · " +
  "`/config set <key> <value>` 改設定 · `/tune list|approve|undo` 她自己調的設定 · " +
  "`/ignore list|add|remove` 不理某人 · `/rule list|add|remove` 她要一直遵守的規矩 · " +
  "`/ping` 在不在 · `/help` 這頁";
