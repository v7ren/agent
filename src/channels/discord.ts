import {
  ActivityType,
  Client,
  Events,
  GatewayIntentBits,
  Partials,
} from "discord.js";
import type {
  Channel,
  ChatInputCommandInteraction,
  Message,
  MessageMentionOptions,
} from "discord.js";
import type { Agent } from "../core/loop.ts";
import type { Mood } from "../persona/mood.ts";
import { TypingTracker, renderAbandoned } from "../persona/typing.ts";
import { aimedElsewhere } from "./addressing.ts";
import { log, snip } from "../log.ts";
import type { IgnoreBook } from "../persona/ignorebook.ts";
import { HeuristicGate } from "./gate.ts";
import type { Gate, GateMessage } from "./gate.ts";
import {
  DM_LIMIT,
  QUEUE_LIMIT,
  TURN_LIMIT,
  emptyRules,
  queueFull,
  scopeReason,
  takeToken,
} from "./scope.ts";
import type { ScopeDeny, ScopeRules, TokenBucket } from "./scope.ts";
import { ambientCooldownElapsed } from "./ambient.ts";
import { COMMANDS, HELP, OWNER_ONLY, formatMood, formatStats } from "./commands.ts";
import { describeSettings, findSetting } from "./settings.ts";
import { setEnvValue } from "../settings-write.ts";
import { reloadEnv } from "../env.ts";
import { invalidateLiveSettings, liveSettings } from "../live.ts";
import type { LiveSettings } from "../live.ts";
import { inSettle, takeBudget, trimBurst } from "./burst.ts";
import type { BurstItem } from "./burst.ts";
import { inHush } from "./spontaneous.ts";
import { canSpeakNow, hoursUntil, nextDelayMs } from "./spontaneous.ts";
import type { SpontaneousPlan } from "./spontaneous.ts";

const ACTIVITY: Record<Mood, string> = {
  genki: "水面上的氣泡",
  sleepy: "水底的沉澱",
  hungry: "白飯",
  tsundere: "假裝沒在看",
};

const PRESENCE: Record<Mood, "online" | "idle" | "dnd"> = {
  genki: "online",
  sleepy: "idle",
  hungry: "online",
  tsundere: "dnd",
};

const PRESENCE_THROTTLE_MS = 10 * 60 * 1000;
const MAX_MESSAGE = 1900;
const RECENT_SIZE = 12;

/** Her messages never ping anyone, unless DISCORD_PING=1 names the owner. */
const NO_MENTIONS: MessageMentionOptions = { parse: [], repliedUser: false };

/** Extra queue slots only the owner can use. */
const OWNER_RESERVED = 4;
function mentionsFor(userId: string | undefined): MessageMentionOptions {
  return userId ? { parse: [], users: [userId], repliedUser: false } : NO_MENTIONS;
}

const DENY_TEXT: Record<ScopeDeny, string> = {
  ignored: "在 DISCORD_IGNORE_USERS 裡",
  "dms-off": "DISCORD_DMS=0 關掉了私訊",
  "dm-not-allowed": "不在 DISCORD_DM_USERS / DISCORD_OWNER_IDS 裡（DISCORD_DM_OPEN=1 可開放）",
  "channel-not-allowed": "不在 DISCORD_ONLY_CHANNELS 裡",
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function chunk(text: string, max: number): string[] {
  const chars = [...text];
  if (chars.length <= max) return [text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += max) out.push(chars.slice(i, i + max).join(""));
  return out;
}

export interface DiscordOptions {
  token: string;
  /** channel ids where she answers every message, no mention needed */
  alwaysChannels?: string[];
  /** if set, only these guild ids are served */
  guilds?: string[];
  /** answer every message in every allowed guild channel */
  replyAll?: boolean;
  /** chime in on unaddressed messages, at her own discretion */
  ambient?: boolean;
  /** base chance for the heuristic gate */
  ambientChance?: number;
  /** 1 = default, 2 = chattier, 0.5 = quieter */
  talk?: number;
  /** seconds to stay quiet after one unaddressed reply, per channel */
  ambientCooldown?: number;
  /** how long messages stay part of the same conversation (default 10 min) */
  burstMs?: number;
  /** human-like delay between deciding and speaking */
  armMs?: number;
  /** quiet minutes after an unprompted reply */
  settleMinutes?: number;
  /** interjection budget: N per M minutes */
  budget?: { max: number; minutes: number };
  /** the person the bot belongs to: closer, and may receive DMs she starts */
  ownerIds?: string[];
  /** people she is ignoring right now (by her own choice or the owner's) */
  ignoreBook?: IgnoreBook;
  /** actually ping the owner (repliedUser / mention) instead of staying silent */
  ping?: boolean;
  /** one conversation shared by every channel and DM */
  singleSession?: boolean;
  /** words that count as calling her by name */
  names?: string[];
  /** decides unaddressed messages; defaults to the heuristic */
  gate?: Gate;
  /** hard boundary: which channels and users may reach her at all */
  onlyChannels?: string[];
  /** if non-empty, only these user ids may DM her */
  dmUsers?: string[];
  ignoreUsers?: string[];
  dms?: boolean;
  /** she starts a topic by herself, on a timer, into quiet channels */
  spontaneous?: {
    channels: string[];
    ownerIds: string[];
    dm: boolean;
    plan: SpontaneousPlan;
  };
}

export interface DiscordHandle {
  tag: string;
  gate: string;
  stop: () => Promise<void>;
}

/**
 * Where she answers:
 *   DM                      always
 *   @mention                always
 *   reply to her message    always
 *   called by name          always
 *   DISCORD_CHANNEL_IDS     always
 *   DISCORD_REPLY_ALL=1     every message in allowed guilds
 *   DISCORD_AMBIENT=1       the gate decides
 *   anything else           silence, on purpose
 */
class DiscordBot {
  private client: Client;
  private opts: DiscordOptions;
  private createAgent: (where: string) => Agent;
  private gate: Gate;
  private rules: ScopeRules;
  private pool = new Map<string, Agent>();
  private recent = new Map<string, GateMessage[]>();
  private chain: Promise<unknown> = Promise.resolve();
  private lastPresence = 0;  private lastSpoke = new Map<string, number>();
  private lastActivity = new Map<string, number>();
  private lastAmbient = new Map<string, number>();
  private bursts = new Map<string, BurstItem[]>();
  private armed = new Map<string, NodeJS.Timeout>();
  private settleUntil = new Map<string, number>();
  private budget = new Map<string, number[]>();
  private channelRefs = new Map<string, Channel>();
  /** where each agent last spoke; needed when the key is "global" */
  private lastChannel = new Map<string, Channel>();
  private spontTargets: Array<{ kind: "channel" | "dm"; id: string }> = [];
  private lastLive = "";
  /** per-user explicit-trigger budget (owners exempt) */
  private turnBuckets = new Map<string, TokenBucket>();
  /** per-user DM rate limit (owners exempt) */
  private dmBuckets = new Map<string, TokenBucket>();
  /** turns queued or running on the serial chain */
  private pending = 0;

  /** Behaviour settings reload from .env within ~3s; no restart needed. */
  private live(): LiveSettings {
    const settings = liveSettings();
    const key = JSON.stringify(settings);
    if (this.lastLive !== "" && key !== this.lastLive) {
      console.log("[discord] settings reloaded:", key);
    }
    this.lastLive = key;
    return settings;
  }
  private pendingGates = new Set<string>();
  private spontTimer: NodeJS.Timeout | null = null;
  private liveTimer: NodeJS.Timeout | null = null;
  private spontNext = new Map<string, number>();
  private typing = new TypingTracker();
  private typingTimer: NodeJS.Timeout | null = null;
  /** "he typed something and never sent it", waiting for his next message */
  private typedNotes = new Map<string, { text: string; at: number }>();

  constructor(createAgent: (where: string) => Agent, opts: DiscordOptions) {
    this.createAgent = createAgent;
    this.opts = opts;
    this.gate = opts.gate ?? new HeuristicGate();
    this.rules = {
      ...emptyRules(),
      onlyChannels: opts.onlyChannels ?? [],
      dmUsers: opts.dmUsers ?? [],
      owners: opts.ownerIds ?? [],
      dmOpen: process.env.DISCORD_DM_OPEN === "1",
      ignoreUsers: opts.ignoreUsers ?? [],
      dms: opts.dms ?? true,
    };
    this.client = new Client({
      intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.DirectMessages,
        // Typing indicators are not privileged; they only say "started typing".
        GatewayIntentBits.GuildMessageTyping,
        GatewayIntentBits.DirectMessageTyping,
      ],
      partials: [Partials.Channel],
    });
  }

  get tag(): string {
    return this.client.user?.tag ?? "discord";
  }

  get gateName(): string {
    return this.gate.name;
  }

  async start(): Promise<void> {
    this.client.on(Events.MessageCreate, (msg) => {
      void this.onMessage(msg);
    });
    this.client.on(Events.InteractionCreate, (interaction) => {
      if (!interaction.isChatInputCommand()) return;
      void this.onCommand(interaction);
    });
    this.client.on(Events.TypingStart, (typing) => {
      // Only the owner's typing is watched: it is a private signal, not surveillance.
      if (!this.isOwner(typing.user.id)) return;
      this.typing.typingStart(typing.user.id, typing.channel.id, Date.now());
    });
    this.typingTimer = setInterval(() => {
      for (const gone of this.typing.abandoned(Date.now())) {
        this.typedNotes.set(gone.userId, {
          text: renderAbandoned(gone, Date.now()),
          at: Date.now(),
        });
      }
    }, 5000);
    this.typingTimer.unref?.();
    this.client.on(Events.Error, (err) => console.error("[discord]", err));
    this.client.on(Events.Warn, (msg) => console.warn("[discord]", msg));

    await new Promise<void>((resolve, reject) => {
      this.client.once(Events.ClientReady, () => resolve());
      this.client.once(Events.Error, (err) => reject(err));
      this.client.login(this.opts.token).catch(reject);
    });

    this.applyPresence("genki", true);
    this.startSpontaneous();
    await this.registerCommands();

    // Watch .env so behaviour tweaks apply without a restart (and log them).
    this.liveTimer = setInterval(() => {
      this.live();
    }, 15_000);
  }

  async stop(): Promise<void> {
    if (this.spontTimer) clearInterval(this.spontTimer);
    if (this.liveTimer) clearInterval(this.liveTimer);
    if (this.typingTimer) clearInterval(this.typingTimer);
    await this.client.destroy();
  }

  /** Guild-scoped when guilds are configured (instant), global otherwise. */
  private async registerCommands(): Promise<void> {
    const app = this.client.application;
    if (!app) return;

    const bodies = COMMANDS.map((command) => command.toJSON());

    try {
      const guilds = this.opts.guilds ?? [];
      if (guilds.length > 0) {
        for (const id of guilds) await app.commands.set(bodies, id);
        console.log(`  slash commands: ${bodies.length} 個（伺服器 ${guilds.length} 個，立即生效）`);
      } else {
        await app.commands.set(bodies);
        console.log(`  slash commands: ${bodies.length} 個（全域，可能要等幾分鐘）`);
      }
    } catch (err) {
      console.error("[discord] command registration failed:", err);
    }
  }

  private async onCommand(interaction: ChatInputCommandInteraction): Promise<void> {
    const name = interaction.commandName;

    if (
      !this.admit(
        interaction.inGuild(),
        interaction.guildId,
        interaction.channelId ?? "",
        interaction.user.id,
      )
    ) {
      await interaction.reply({ content: "這裡我不接指令。", ephemeral: true }).catch(() => {});
      return;
    }
    if (!this.isOwner(interaction.user.id) && this.opts.ignoreBook?.isIgnored(interaction.user.id)) {
      // An interaction must be answered; this is the smallest answer there is.
      await interaction.reply({ content: "……", ephemeral: true }).catch(() => {});
      return;
    }
    if (OWNER_ONLY.has(name) && !this.isOwner(interaction.user.id)) {
      await interaction.reply({ content: "這只有主人能用。", ephemeral: true }).catch(() => {});
      return;
    }

    try {
      await interaction.deferReply({ ephemeral: true });

      if (name === "ping") {
        await interaction.editReply(`本鯨在。${Math.round(this.client.ws.ping)}ms`);
        return;
      }

      if (name === "help") {
        await interaction.editReply(HELP);
        return;
      }

      if (name === "config") {
        const sub = interaction.options.getSubcommand();

        if (sub === "show") {
          await interaction.editReply(`\`\`\`\n${describeSettings(this.live())}\n\`\`\``);
          return;
        }

        const owners = this.opts.ownerIds ?? [];
        if (owners.length === 0 || !owners.includes(interaction.user.id)) {
          await interaction.editReply("這只有主人能改。設定 `DISCORD_OWNER_IDS` 之後再試。");
          return;
        }

        const key = interaction.options.getString("key", true);
        const raw = interaction.options.getString("value", true);
        const def = findSetting(key);
        if (!def) {
          await interaction.editReply(`沒有 \`${key}\` 這個設定。`);
          return;
        }

        const parsed = def.parse(raw);
        if (!parsed.ok) {
          await interaction.editReply(`${def.label}：${parsed.error}`);
          return;
        }

        setEnvValue(def.env, parsed.value);
        reloadEnv();
        invalidateLiveSettings();

        await interaction.editReply(
          `✅ ${def.label} → **${parsed.value}**\n\`\`\`\n${describeSettings(this.live())}\n\`\`\``,
        );
        return;
      }

      const agent = this.agentFor(interaction.channelId ?? "command", "指令");

      if (name === "ignore") {
        const book = this.opts.ignoreBook;
        if (!book) {
          await interaction.editReply("現在沒有開不理人的功能。");
          return;
        }
        const sub = interaction.options.getSubcommand();
        const now = new Date();
        if (sub === "list") {
          const active = book.active(now);
          // Times are shown on this machine's own clock, never as raw UTC.
          const local = (iso: string) => {
            const d = new Date(iso);
            const p = (n: number) => String(n).padStart(2, "0");
            return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
          };
          await interaction.editReply(
            active.length === 0
              ? "現在沒有不理任何人。"
              : active
                  .map(
                    (e) =>
                      `<@${e.id}> ${e.until === "" ? "直到你解除" : `到 ${local(e.until)}`}` +
                      `${e.reason ? `｜${e.reason}` : ""}｜${e.by === "owner" ? "你設的" : "她自己決定的"}`,
                  )
                  .join("\n")
                  .slice(0, 1900),
          );
          return;
        }
        const user = interaction.options.getUser("user", true);
        if (sub === "remove") {
          const r = book.remove(user.id, "owner", now);
          await interaction.editReply(r.ok ? `又開始理 ${user.username} 了。` : (r.reason ?? "沒有這個人。"));
          return;
        }
        const minutes = interaction.options.getInteger("minutes") ?? 0;
        const reason = interaction.options.getString("reason") ?? "";
        const r = book.add(
          { id: user.id, name: user.globalName ?? user.username, minutes, reason },
          "owner",
          now,
        );
        await interaction.editReply(
          r.ok
            ? `好，不理 ${user.username}（${minutes > 0 ? `${minutes} 分鐘` : "直到你解除"}）。`
            : (r.reason ?? "不行。"),
        );
        return;
      }

      if (name === "tune") {
        const kit = agent.driveKit;
        if (!kit) {
          await interaction.editReply("現在沒有開自我調整。");
          return;
        }
        const sub = interaction.options.getSubcommand();
        const now = new Date();
        if (sub === "approve" || sub === "undo") {
          const id = interaction.options.getString("id", true).trim();
          const done = sub === "approve" ? kit.approve(id, now) : kit.undo(id, now);
          reloadEnv();
          invalidateLiveSettings();
          await interaction.editReply(done.slice(0, 1900));
          return;
        }
        const pending = kit.pendingChanges();
        const recent = kit.recentChanges().slice(-8);
        const lines = [
          pending.length === 0
            ? "沒有等著同意的。"
            : `等你同意：\n${pending.map((c) => `\`${c.id}\` ${c.key} ${c.from || "（空）"} → ${c.to}`).join("\n")}`,
          recent.length === 0
            ? ""
            : `最近：\n${recent.map((c) => `\`${c.id}\` ${c.key} → ${c.to}（${c.status}）`).join("\n")}`,
        ].filter(Boolean);
        await interaction.editReply(lines.join("\n\n").slice(0, 1900));
        return;
      }

      if (name === "mood") {
        await interaction.editReply(formatMood(agent.moodState));
        return;
      }

      if (name === "stats") {
        await interaction.editReply(formatStats(agent.cacheStat, agent.turns));
        return;
      }

      if (name === "recall") {
        const query = interaction.options.getString("query", true);
        const hits = agent.search(query, 6);
        if (hits.length === 0) {
          await interaction.editReply("沒翻到相關的東西。");
          return;
        }
        const lines = hits.map(
          (hit) => `\`${hit.path}#L${hit.line}\` ${hit.why}`,
        );
        await interaction.editReply(lines.join("\n").slice(0, 1900));
        return;
      }

      if (name === "diary") {
        const raw = interaction.options.getString("date");
        const date =
          typeof raw === "string" && /^\d{4}-\d{2}-\d{2}$/.test(raw)
            ? new Date(`${raw}T12:00:00`)
            : new Date();
        const text = agent.diary(date);
        await interaction.editReply(
          text ? text.slice(0, 1900) : "那天還沒有日記。",
        );
        return;
      }

      await interaction.editReply(HELP);
    } catch (err) {
      console.error("[discord] command failed:", err);
      try {
        await interaction.editReply("本鯨卡住了，等一下再試。");
      } catch {
        // interaction may already be gone
      }
    }
  }

  /**
   * Serial chain with a bound: when QUEUE_LIMIT turns are already pending the
   * new one is dropped and onDrop (if any) runs instead.
   */
  private enqueue(fn: () => Promise<void>, onDrop?: () => void, priority = false): void {
    // The owner gets a few reserved slots, so a crowd cannot lock them out.
    if (queueFull(this.pending, priority ? QUEUE_LIMIT + OWNER_RESERVED : QUEUE_LIMIT)) {
      log.warn("queue", `排隊的有 ${this.pending} 個，這一個被丟掉`);
      onDrop?.();
      return;
    }
    this.pending++;
    this.chain = this.chain
      .then(fn)
      .catch((err) => {
        console.error("[discord] turn failed:", err);
      })
      .finally(() => {
        this.pending--;
      });
  }

  /** Every entry point (messages and slash commands) passes through here. */
  private admit(inGuild: boolean, guildId: string | null, channelId: string, authorId: string): boolean {
    if (inGuild && this.opts.guilds?.length && !this.opts.guilds.includes(guildId ?? "")) {
      return false;
    }

    const deny = scopeReason({ inGuild, channelId, authorId }, this.rules);
    if (deny) {
      if (!inGuild) console.log(`[discord] DM dropped from ${authorId}: ${DENY_TEXT[deny]}`);
      return false;
    }

    if (!inGuild && !this.isOwner(authorId)) {
      const taken = takeToken(this.dmBuckets.get(authorId), Date.now(), DM_LIMIT);
      this.dmBuckets.set(authorId, taken.bucket);
      if (!taken.ok) {
        console.log(`[discord] DM dropped from ${authorId}: rate limit`);
        return false;
      }
    }
    return true;
  }

  /** A "typed but never sent" note, handed over once and only while it is fresh. */
  private takeTypedNote(userId: string): string {
    const note = this.typedNotes.get(userId);
    if (!note) return "";
    this.typedNotes.delete(userId);
    return Date.now() - note.at <= 10 * 60_000 ? note.text : "";
  }

  private async onMessage(msg: Message): Promise<void> {
    if (!msg.inGuild() && !msg.channel.isDMBased()) return;
    if (msg.author.bot) return;

    const me = this.client.user;
    if (me && msg.author.id === me.id) return;

    if (!this.admit(msg.inGuild(), msg.guildId, msg.channelId, msg.author.id)) return;

    // He did send something, so whatever he was typing is no longer abandoned.
    this.typing.messageSent(msg.author.id, msg.channelId, Date.now());

    let text = this.readText(msg);
    if (text === "") {
      // A bare "@藍色大肥魚" used to vanish here. It is a poke, so answer it.
      // She just sees what was typed: her own name, as a mention.
      const me = this.client.user;
      if (me && msg.mentions.users.has(me.id)) text = `@${me.displayName ?? me.username}`;
      else return;
    }

    if (msg.inGuild()) {
      this.remember(msg.channelId, this.displayName(msg), text);
      this.channelRefs.set(msg.channelId, msg.channel);
    } else {
      // DM targets are keyed by user, not by the ephemeral DM channel id.
      this.lastActivity.set(`dm:${msg.author.id}`, Date.now());
    }

    log.info(
      "msg",
      `${this.where(msg)} ${this.displayName(msg)}${this.isOwner(msg.author.id) ? "★" : ""}：「${snip(text, 60)}」`,
    );
    const agent = this.agentFor(this.agentKey(msg), this.where(msg));
    agent.logHeard({
      text,
      speaker: { id: msg.author.id, name: this.displayName(msg) },
      where: this.where(msg),
    });

    // Ignored means ignored: no reply and no joining in, even when they @ her.
    // She still heard it (logged above), so she keeps what was said.
    if (!this.isOwner(msg.author.id) && this.opts.ignoreBook?.isIgnored(msg.author.id)) {
      log.info("ignore", `${this.displayName(msg)} 在說話，不理他`);
      return;
    }

    if (this.hardAddressed(msg, text)) {
      if (!this.isOwner(msg.author.id)) {
        const taken = takeToken(this.turnBuckets.get(msg.author.id), Date.now(), TURN_LIMIT);
        this.turnBuckets.set(msg.author.id, taken.bucket);
        if (!taken.ok) {
          log.warn("limit", `${this.displayName(msg)} 5 分鐘內超過 6 次，這句不回（掛 ⏳）`);
          // Not a silent ignore: a small hourglass says she saw it and is pacing herself.
          void msg.react("⏳").catch(() => {});
          return;
        }
      }
      log.info("decide", `→ 回（${this.whyHard(msg, text)}）`);
      this.enqueue(
        () => this.respond(msg, text),
        () => {
          void msg
            .reply({
              content: "人太多了，本鯨消化不過來，等一下再找我啦。",
              allowedMentions: NO_MENTIONS,
              failIfNotExists: false,
            })
            .catch(() => {});
        },
        this.isOwner(msg.author.id),
      );
      return;
    }
    if (!this.opts.ambient) return;

    // She hears this as part of the room. If it was aimed at someone else, the
    // speaker tag says who it was for ([ren → 輕輕鬆鬆啊]); the text stays as typed.
    const aimed = this.aimedTargets(msg, text);
    log.info(
      "decide",
      aimed.length > 0 ? `→ 這句是對 ${aimed.join("、")} 說的，問 Jev 要不要插話` : "→ 沒叫她，問 Jev 要不要接話",
    );
    this.pushBurst(msg, text, aimed);
    // Someone else's conversation: she listens. Whether she chimes in is left to
    // Jev, which has to be much more confident than for an ordinary message.
    void this.considerAmbient(msg, text, aimed.length > 0);
  }

  private pushBurst(msg: Message, text: string, to: string[] = []): void {
    const now = Date.now();
    const list = this.bursts.get(msg.channelId) ?? [];
    list.push({
      id: msg.id,
      author: this.displayName(msg),
      authorId: msg.author.id,
      text,
      at: now,
      where: this.where(msg),
      ...(to.length > 0 ? { to } : {}),
    });
    this.bursts.set(msg.channelId, trimBurst(list, now, this.live().burstMs, 12));
  }

  private clearBurst(channelId: string): void {
    const timer = this.armed.get(channelId);
    if (timer) {
      clearTimeout(timer);
      this.armed.delete(channelId);
    }
    this.bursts.delete(channelId);
  }

  /** Names of who a message is plainly for, when it is not for her; empty otherwise. */
  private aimedTargets(msg: Message, text: string): string[] {
    const me = this.client.user;
    const ids = [...msg.mentions.users.keys()];
    if (!aimedElsewhere({ meId: me?.id, mentionedIds: ids, text, names: this.names() })) return [];
    return [...msg.mentions.users.values()]
      .filter((u) => !me || u.id !== me.id)
      .map((u) => this.mentionName(msg, u).slice(0, 30));
  }

  /** The name people see for a mentioned user; readText and the tags must agree on it. */
  private mentionName(msg: Message, user: { id: string; globalName: string | null; username: string }): string {
    return (msg.mentions.members?.get(user.id)?.displayName ?? user.globalName ?? user.username).replace(
      /\s+/g,
      " ",
    );
  }

  /** Why a message counts as a call to her, for the terminal log. */
  private whyHard(msg: Message, text: string): string {
    if (!msg.inGuild()) return "私訊";
    const me = this.client.user;
    if (me && msg.mentions.users.has(me.id)) return "@她";
    if (me && msg.mentions.repliedUser?.id === me.id) return "回覆她";
    if (this.names().some((n) => n !== "" && text.includes(n))) return "叫了她的名字";
    if (this.opts.alwaysChannels?.includes(msg.channelId)) return "她固定回的頻道";
    if (this.opts.replyAll) return "全部都回模式";
    return "被叫到";
  }

  private hardAddressed(msg: Message, text: string): boolean {
    if (!msg.inGuild()) return true;

    const me = this.client.user;
    if (me && msg.mentions.users.has(me.id)) return true;
    if (me && msg.mentions.repliedUser?.id === me.id) return true;

    // "Answer everything" still does not cover a message plainly aimed at
    // someone else: that goes to the ambient path like any other chatter.
    if (
      aimedElsewhere({
        meId: me?.id,
        mentionedIds: [...msg.mentions.users.keys()],
        text,
        names: this.names(),
      })
    ) {
      return false;
    }

    if (this.opts.alwaysChannels?.includes(msg.channelId)) return true;
    if (this.opts.replyAll) return true;

    const names = this.names();
    return names.some((n) => n !== "" && text.includes(n));
  }

  /**
   * Decided off the reply queue: a slow gate must never delay an @mention,
   * and at most three decisions may be in flight.
   */
  private async considerAmbient(
    msg: Message,
    text: string,
    aimedElsewhere = false,
  ): Promise<void> {
    const settings = this.live();
    const now = Date.now();

    // Being in "settle" is a signal, not a veto: Jev still gets to decide,
    // it just has to be more confident.
    const agent = this.agentFor(this.agentKey(msg), this.where(msg));
    const settle = inSettle(now, this.settleUntil.get(msg.channelId) ?? 0)
      ? settings.settleBias
      : 1;
    // 摸魚 = she asked to be left alone, so demand more confidence.
    // A message plainly meant for someone else needs more still: Jev is
    // told so, instead of having to guess it from the text.
    const bias =
      settle * (agent.slacking ? 1.6 : 1) * (aimedElsewhere ? settings.aimedBias : 1);

    if (
      !ambientCooldownElapsed(
        now,
        this.lastAmbient.get(msg.channelId) ?? 0,
        settings.ambientCooldown,
      )
    ) {
      return;
    }
    if (this.armed.has(msg.channelId)) return;
    if (this.pendingGates.size >= 3) return;

    this.pendingGates.add(msg.id);
    try {
      const burst = this.bursts.get(msg.channelId) ?? [];

      const ok = await this.gate.decide({
        channel: msg.channelId,
        messages: burst.map((item) => ({
          author: item.author,
          text: item.text,
          at: item.at,
        })),
        names: this.names(),
        lastSpokeAt: this.lastSpoke.get(msg.channelId) ?? 0,
        now: Date.now(),
        base: (this.opts.ambientChance ?? 0.12) * settings.talk,
        bias,
        messageId: msg.id,
      });
      log.info(
        "gate",
        `Jev ${ok ? "要插話" : "不插話"}` +
          (aimedElsewhere ? `（別人之間的對話，門檻 ×${settings.aimedBias}）` : ""),
      );
      if (!ok) return;

      const taken = takeBudget(
        this.budget.get(msg.channelId) ?? [],
        Date.now(),
        settings.budget.max,
        settings.budget.minutes * 60_000,
      );
      this.budget.set(msg.channelId, taken.stamps);
      if (!taken.ok) {
        log.info("gate", `沉默預算用完了（${settings.budget.max}/${settings.budget.minutes} 分），不插話`);
        return;
      }

      this.arm(msg.channelId);
    } finally {
      this.pendingGates.delete(msg.id);
    }
  }

  /** Decide now, speak a few seconds later — and only once per burst. */
  private arm(channelId: string): void {
    if (this.armed.has(channelId)) return;

    const timer = setTimeout(() => {
      this.armed.delete(channelId);
      this.enqueue(() => this.pounce(channelId));
    }, this.live().armMs);

    this.armed.set(channelId, timer);
  }

  /** Speak into the room, answering the whole burst rather than its last line. */
  private async pounce(channelId: string): Promise<void> {
    const burst = this.bursts.get(channelId) ?? [];
    const last = burst[burst.length - 1];
    if (!last) return;
    if (inSettle(Date.now(), this.settleUntil.get(channelId) ?? 0)) return;

    const source = this.channelRefs.get(channelId);
    if (!source) return;

    const channel = source as unknown as {
      sendTyping: () => Promise<void>;
      send: (options: {
        content?: string;
        files?: string[];
        allowedMentions?: MessageMentionOptions;
      }) => Promise<unknown>;
    };
    if (typeof channel.send !== "function") return;

    let firstSent: { react?: (emoji: string) => Promise<unknown> } | null = null;
    const send = async (options: {
      content?: string;
      files?: string[];
      allowedMentions?: MessageMentionOptions;
    }) => {
      const sent = await channel.send({ allowedMentions: NO_MENTIONS, ...options });
      if (!firstSent && sent && typeof (sent as { react?: unknown }).react === "function") {
        firstSent = sent as { react: (emoji: string) => Promise<unknown> };
      }
      return sent;
    };

    this.bursts.delete(channelId);
    this.settleUntil.set(
      channelId,
      Date.now() + this.live().settleMinutes * 60_000,
    );
    this.lastAmbient.set(channelId, Date.now());

    const ticker = setInterval(() => {
      void channel.sendTyping().catch(() => {});
    }, 8000);

    let sending = false;
    try {
      await channel.sendTyping();
      const agent = this.agentFor(channelId, last.where);
      this.lastChannel.set(channelId, source as Channel);
      const prior = burst.slice(0, -1).map((item) => ({
        name: item.author,
        text: item.text,
        ...(item.to ? { to: item.to } : {}),
      }));

      const result = await agent.turn(last.text, {
        speaker: { id: last.authorId, name: last.author },
        group: true,
        heardLogged: true,
        prior,
        owner: this.isOwner(last.authorId),
        ...(this.hasOwners() && !this.isOwner(last.authorId) ? { notOwner: true } : {}),
        ...(last.to ? { aimedAt: last.to } : {}),
        where: last.where,
      });

      const segments = result.segments.filter((s) => s.trim() !== "");
      sending = segments.length > 0;
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) await sleep(360 + Math.random() * 420);
        const body =
          i === segments.length - 1 && result.kaomoji
            ? `${segments[i]} ${result.kaomoji}`
            : (segments[i] ?? "");
        for (const part of chunk(body, MAX_MESSAGE)) {
          await send({ content: part });
        }
      }
      if (sending) agent.noteDelivery(true, undefined, segments.length);

      if (result.share) {
        await send({ files: [result.share.path] }).catch((err) =>
          console.error("[discord] share failed:", err),
        );
      }

      if (result.whisper) {
        await send({ content: `-# （${result.whisper}）` }).catch(() => {});
      }

      if (result.react) {
        const sent = firstSent as { react?: (emoji: string) => Promise<unknown> } | null;
        await sent?.react?.(result.react).catch(() => {});
      }

      this.lastSpoke.set(channelId, Date.now());
      this.applyPresence(result.mood.mood, false);
    } catch (err) {
      console.error("[discord] pounce failed:", err);
      if (sending) this.agentFor(channelId, last.where).noteDelivery(false, err);
    } finally {
      clearInterval(ticker);
    }
  }

  private names(): string[] {
    return this.opts.names && this.opts.names.length > 0
      ? this.opts.names
      : ["大肥魚", "肥魚"];
  }

  private remember(channelId: string, author: string, text: string): void {
    const list = this.recent.get(channelId) ?? [];
    list.push({ author, text, at: Date.now() });
    if (list.length > RECENT_SIZE) list.splice(0, list.length - RECENT_SIZE);
    this.recent.set(channelId, list);
    this.lastActivity.set(channelId, Date.now());
  }

  private displayName(msg: Message): string {
    return msg.member?.displayName ?? msg.author.displayName ?? msg.author.username;
  }

  private readText(msg: Message): string {
    const me = this.client.user;
    let text = msg.content;
    if (me) {
      // Her own mention reads as her name, like everyone else's, not as nothing.
      const own = `@${(me.displayName ?? me.username).replace(/\s+/g, " ")}`;
      for (const token of [`<@${me.id}>`, `<@!${me.id}>`]) text = text.split(token).join(own);
    }
    // Other people's mentions are raw ids to her; show the names people see.
    for (const user of msg.mentions.users.values()) {
      if (me && user.id === me.id) continue;
      const name = this.mentionName(msg, user);
      for (const token of [`<@${user.id}>`, `<@!${user.id}>`]) {
        text = text.split(token).join(`@${name}`);
      }
    }
    // Roles and channels read as names too, and nothing is left as a raw id.
    for (const role of msg.mentions.roles.values()) {
      text = text.split(`<@&${role.id}>`).join(`@${role.name}`);
    }
    for (const channel of msg.mentions.channels.values()) {
      const name = "name" in channel && channel.name ? channel.name : "頻道";
      text = text.split(`<#${channel.id}>`).join(`#${name}`);
    }
    text = text
      .replace(/<@&\d+>/g, "@某個身分組")
      .replace(/<@!?\d+>/g, "@某人")
      .replace(/<#\d+>/g, "#某個頻道");
    return text.replace(/\s+/g, " ").trim();
  }

  /** Who and what a Discord reply points at; null when it is not a reply or cannot be fetched. */
  private async replyContext(
    msg: Message,
  ): Promise<{ name: string; text: string; isMe: boolean } | null> {
    if (!msg.reference?.messageId) return null;
    try {
      const ref = await msg.fetchReference();
      const me = this.client.user;
      const member = ref.member;
      const name = (member?.displayName ?? ref.author.globalName ?? ref.author.username).replace(
        /\s+/g,
        " ",
      );
      const text = this.readText(ref);
      if (text === "") return null;
      return { name, text, isMe: me !== null && ref.author.id === me.id };
    } catch {
      return null;
    }
  }

  private where(msg: Message): string {
    if (!msg.inGuild()) return "私訊";
    const name = "name" in msg.channel ? msg.channel.name : undefined;
    return name ? `#${name}` : "#頻道";
  }

  /** One agent per room. DMs must key by user, or her spontaneous DMs land in
   * a different session than the replies and she forgets she sent them. */
  private agentKey(msg: Message): string {
    return msg.inGuild() ? msg.channelId : `dm:${msg.author.id}`;
  }

  private agentFor(channelId: string, where: string): Agent {
    // One fish, one memory: every room shares the same conversation window.
    const key = this.opts.singleSession ? "global" : channelId;
    const existing = this.pool.get(key);
    if (existing) return existing;
    const agent = this.createAgent(where);
    this.pool.set(key, agent);
    return agent;
  }

  private async respond(msg: Message, text: string): Promise<void> {
    const channel = msg.channel;
    if (!channel.isSendable()) return;

    const ticker = setInterval(() => {
      void channel.sendTyping().catch(() => {});
    }, 8000);

    let sending = false;
    try {
      await channel.sendTyping();
      const agent = this.agentFor(this.agentKey(msg), this.where(msg));
      this.lastChannel.set(this.agentKey(msg), channel as unknown as Channel);
      const prior = (this.bursts.get(msg.channelId) ?? [])
        .filter((item) => item.id !== msg.id)
        .slice(-8)
        .map((item) => ({ name: item.author, text: item.text }));

      const typedNote = this.takeTypedNote(msg.author.id);
      const replyTo = await this.replyContext(msg);
      const result = await agent.turn(text, {
        ...(replyTo ? { replyTo } : {}),
        speaker: { id: msg.author.id, name: this.displayName(msg) },
        group: msg.inGuild(),
        heardLogged: true,
        prior,
        owner: this.isOwner(msg.author.id),
        ...(this.hasOwners() && !this.isOwner(msg.author.id) ? { notOwner: true } : {}),
        where: this.where(msg),
        ...(typedNote ? { note: typedNote } : {}),
      });
      const segments = result.segments.filter((s) => s.trim() !== "");
      sending = segments.length > 0;

      for (let i = 0; i < segments.length; i++) {
        if (i > 0) await sleep(360 + Math.random() * 420);
        const body =
          i === segments.length - 1 && result.kaomoji
            ? `${segments[i]} ${result.kaomoji}`
            : (segments[i] ?? "");

        const parts = chunk(body, MAX_MESSAGE);
        for (let c = 0; c < parts.length; c++) {
          const content = parts[c] ?? "";
          if (i === 0 && c === 0) {
            const pingOwner =
              this.opts.ping === true && this.isOwner(msg.author.id);
            await msg.reply({
              content,
              allowedMentions: mentionsFor(pingOwner ? msg.author.id : undefined),
              failIfNotExists: false,
            });
          } else {
            await channel.send({ content, allowedMentions: NO_MENTIONS });
          }
        }
      }

      if (sending) agent.noteDelivery(true, undefined, segments.length);

      if (result.share) {
        await channel
          .send({ files: [result.share.path], allowedMentions: NO_MENTIONS })
          .catch((err) => console.error("[discord] share failed:", err));
      }

      if (result.whisper) {
        await channel
          .send({ content: `-# （${result.whisper}）`, allowedMentions: NO_MENTIONS })
          .catch(() => {});
      }

      if (result.react) {
        await msg.react(result.react).catch(() => {});
      }

      this.lastSpoke.set(msg.channelId, Date.now());
      this.clearBurst(msg.channelId);
      this.applyPresence(result.mood.mood, false);
    } catch (err) {
      console.error("[discord] respond failed:", err);
      // She should know when her words did not arrive, instead of assuming they did.
      if (sending) this.agentFor(this.agentKey(msg), this.where(msg)).noteDelivery(false, err);
      await msg.react("⚠️").catch(() => {});
    } finally {
      clearInterval(ticker);
    }
  }

  /** Is anyone configured as the owner at all? Without one, nobody is told "not your owner". */
  private hasOwners(): boolean {
    return (this.opts.ownerIds ?? []).length > 0;
  }

  private isOwner(userId: string): boolean {
    return (this.opts.ownerIds ?? []).includes(userId);
  }

  private startSpontaneous(): void {
    const conf = this.opts.spontaneous;
    if (!conf) return;

    const channels = conf.channels.map((id) => ({ kind: "channel" as const, id }));
    const dms = conf.dm ? conf.ownerIds.map((id) => ({ kind: "dm" as const, id })) : [];
    this.spontTargets = [...channels, ...dms];
    if (this.spontTargets.length === 0) return;

    const now = Date.now();
    for (const id of conf.channels) this.lastActivity.set(id, now);

    // Each target keeps its own clock: DMs and channels have separate tempos.
    for (const target of this.spontTargets) {
      this.spontNext.set(this.targetKey(target), now + this.spontDelay(target.kind));
    }

    this.spontTimer = setInterval(() => {
      // Same queue as replies: one fish, one turn at a time.
      this.enqueue(() => this.spontTick());
    }, 30_000);
  }

  /** Spontaneous plans only reach the spontaneous channel list, or owners by DM. */
  private spontAllowed(key: string): boolean {
    const conf = this.opts.spontaneous;
    if (!conf) return false;
    if (key.startsWith("dm:")) return conf.dm && conf.ownerIds.includes(key.slice(3));
    return conf.channels.includes(key);
  }

  private duePlan(): { key: string; topic: string; why: string; deferred: number } | null {
    const now = new Date();
    for (const [key, agent] of this.pool) {
      if (!this.spontAllowed(key)) continue;
      const plan = agent.duePlan(now);
      if (plan) return { key, topic: plan.topic, why: plan.why, deferred: plan.deferred };
    }
    return null;
  }

  private async firePlan(plan: {
    key: string;
    topic: string;
    why: string;
    deferred: number;
  }): Promise<void> {
    const agent = this.pool.get(plan.key);
    if (!agent || !this.spontAllowed(plan.key)) return;

    // She chose to sleep. Keep the plan, but let her wake up first.
    if (agent.sleeping) {
      agent.postponePlan(30 + Math.random() * 30, new Date());
      return;
    }

    const settings = this.live();
    const now = new Date();
    const hour = now.getHours() + now.getMinutes() / 60;
    const base: SpontaneousPlan = {
      minMinutes: settings.sponMin,
      maxMinutes: settings.sponMax,
      quietMinutes: settings.sponQuiet,
      hushFrom: settings.hushFrom,
      hushTo: settings.hushTo,
    };

    // Not a good moment: hold the thought, do not burn it.
    if (inHush(hour, base)) {
      const wait = hoursUntil(settings.hushTo, hour) * 60;
      agent.postponePlan(Math.min(720, Math.max(20, wait + 5 + Math.random() * 15)), now);
      return;
    }
    const last = this.lastActivity.get(plan.key) ?? 0;
    const quietMinutes = plan.key.startsWith("dm:") ? settings.sponDmQuiet : settings.sponQuiet;
    if (last > 0 && now.getTime() - last < quietMinutes * 60_000) {
      agent.postponePlan(12 + Math.random() * 18, now);
      return;
    }

    try {
      const channel: Channel | null = plan.key.startsWith("dm:")
        ? await this.client.users.createDM(plan.key.slice(3))
        : (this.channelRefs.get(plan.key) ??
          this.lastChannel.get(plan.key) ??
          (await this.client.channels.fetch(plan.key).catch(() => null)));
      if (!channel || !channel.isTextBased()) {
        // Under DISCORD_SINGLE_SESSION the key is "global", not an id. If we
        // still cannot find a room, keep the thought and try again later.
        agent.postponePlan(30 + Math.random() * 30, now);
        return;
      }

      const where = plan.key.startsWith("dm:") ? "私訊" : "#頻道";
      const mentionId =
        this.opts.ping === true && !plan.key.startsWith("dm:")
          ? this.opts.ownerIds?.[0]
          : undefined;

      await this.speakUp(channel, plan.key, where, {
        planTopic: plan.topic,
        reason: plan.why,
        deferred: plan.deferred,
        mentionId,
      });
      agent.clearPlan();
    } catch (err) {
      console.error("[discord] plan failed:", err);
      agent.postponePlan(45, now);
    }
  }

  private targetKey(target: { kind: "channel" | "dm"; id: string }): string {
    return target.kind === "dm" ? `dm:${target.id}` : target.id;
  }

  private spontDelay(kind: "channel" | "dm"): number {
    const s = this.live();
    return nextDelayMs(
      {
        minMinutes: kind === "dm" ? s.sponDmMin : s.sponMin,
        maxMinutes: kind === "dm" ? s.sponDmMax : s.sponMax,
        quietMinutes: s.sponQuiet,
        hushFrom: s.hushFrom,
        hushTo: s.hushTo,
      },
      Math.random(),
    );
  }

  private async spontTick(): Promise<void> {
    const settings = this.live();
    if (!settings.spontaneous) return;

    // A plan she made herself wins over the normal spontaneous timer.
    const planned = this.duePlan();
    if (planned) {
      await this.firePlan(planned);
      return;
    }

    const now = Date.now();
    const due = [...this.spontNext.entries()]
      .filter(([, at]) => at <= now)
      .sort((a, b) => a[1] - b[1]);

    const key = due[0]?.[0];
    if (!key) return;

    const target = this.spontTargets.find((item) => this.targetKey(item) === key);
    if (!target) {
      this.spontNext.delete(key);
      return;
    }

    this.spontNext.set(key, now + this.spontDelay(target.kind));
    await this.maybeSpeakUp(target, settings);
  }

  private async maybeSpeakUp(
    target: { kind: "channel" | "dm"; id: string },
    settings: LiveSettings,
  ): Promise<void> {
    const plan: SpontaneousPlan = {
      minMinutes: settings.sponMin,
      maxMinutes: settings.sponMax,
      quietMinutes: target.kind === "dm" ? settings.sponDmQuiet : settings.sponQuiet,
      hushFrom: settings.hushFrom,
      hushTo: settings.hushTo,
    };

    const date = new Date();
    const hour = date.getHours() + date.getMinutes() / 60;
    if (inHush(hour, plan)) return;

    const key = this.targetKey(target);
    const last = this.lastActivity.get(key) ?? 0;
    if (
      !canSpeakNow({ now: date.getTime(), lastMessageAt: last, hour, plan })
    ) {
      return;
    }

    try {
      const channel: Channel | null =
        target.kind === "dm"
          ? await this.client.users.createDM(target.id)
          : await this.client.channels.fetch(target.id);
      if (!channel || !channel.isTextBased()) return;

      const where =
        target.kind === "dm"
          ? "私訊"
          : "name" in channel && channel.name
            ? `#${channel.name}`
            : "#頻道";

      const gapHours = last === 0 ? 0 : (Date.now() - last) / 3_600_000;
      const mentionId =
        this.opts.ping === true && target.kind === "channel"
          ? this.opts.ownerIds?.[0]
          : undefined;

      // She should never open her mouth for no reason at all.
      const agent = this.agentFor(key, where);
      if (agent.sleeping) return;

      const reason =
        agent.pendingThought !== null
          ? "你有句話一直沒跟他說"
          : agent.wakeReasons.length > 0
            ? `你的「${agent.wakeReasons.join("、")}」滿了`
            : agent.longingLevel >= 70
            ? "你想他想到尾巴拍地"
            : gapHours >= 8
              ? "他很久沒出現了"
              : agent.boredomLevel >= 55
                ? "你待著有點無聊"
                : "你忽然想到他";

      await this.speakUp(channel, key, where, { gapHours, mentionId, reason });
    } catch (err) {
      console.error("[discord] spontaneous failed:", err);
    }
  }

  /** No trigger, no reply target: she just says something into a quiet room. */
  private async speakUp(
    fetched: Channel,
    key: string,
    where: string,
    opts: {
      gapHours?: number;
      mentionId?: string;
      planTopic?: string;
      reason?: string;
      deferred?: number;
    } = {},
  ): Promise<void> {
    const channel = fetched as unknown as {
      sendTyping: () => Promise<void>;
      send: (options: {
        content?: string;
        files?: string[];
        allowedMentions?: MessageMentionOptions;
      }) => Promise<unknown>;
      recipient?: { username?: string };
    };
    if (typeof channel.send !== "function") return;

    let firstSent: { react?: (emoji: string) => Promise<unknown> } | null = null;
    const send = async (options: {
      content?: string;
      files?: string[];
      allowedMentions?: MessageMentionOptions;
    }) => {
      const sent = await channel.send({ allowedMentions: NO_MENTIONS, ...options });
      if (!firstSent && sent && typeof (sent as { react?: unknown }).react === "function") {
        firstSent = sent as { react: (emoji: string) => Promise<unknown> };
      }
      return sent;
    };

    const ticker = setInterval(() => {
      void channel.sendTyping().catch(() => {});
    }, 8000);

    let sending = false;
    try {
      await channel.sendTyping();
      const agent = this.agentFor(key, where);
      this.lastChannel.set(key, fetched);
      const pending = agent.pendingThought;
      const dm = key.startsWith("dm:");
      const speaker = dm
        ? { id: key.slice(3), name: channel.recipient?.username ?? "主人" }
        : undefined;

      const result = await agent.turn("", {
        spontaneous: true,
        gapHours: opts.gapHours ?? 0,
        ...(opts.planTopic ? { planTopic: opts.planTopic } : {}),
        ...(opts.reason ? { reason: opts.reason } : {}),
        ...(opts.deferred === undefined ? {} : { deferred: opts.deferred }),
        ...(pending ? { pending } : {}),
        ...(speaker ? { speaker } : {}),
        ...(dm ? { owner: true } : {}),
      });

      const segments = result.segments.filter((s) => s.trim() !== "");
      let pinged = false;
      sending = segments.length > 0;
      for (let i = 0; i < segments.length; i++) {
        if (i > 0) await sleep(360 + Math.random() * 420);
        const body =
          i === segments.length - 1 && result.kaomoji
            ? `${segments[i]} ${result.kaomoji}`
            : (segments[i] ?? "");
        for (const part of chunk(body, MAX_MESSAGE)) {
          // "吵我" mode: the first thing she says in a channel mentions you.
          const mention = !pinged && opts.mentionId ? opts.mentionId : undefined;
          const content = mention ? `<@${mention}> ${part}` : part;
          pinged = true;
          await send({ content, allowedMentions: mentionsFor(mention) });
        }
      }
      if (sending) agent.noteDelivery(true, undefined, segments.length);

      if (result.share) {
        await send({ files: [result.share.path] }).catch((err) =>
          console.error("[discord] share failed:", err),
        );
      }

      if (result.whisper) {
        await send({ content: `-# （${result.whisper}）` }).catch(() => {});
      }

      if (result.react) {
        const sent = firstSent as { react?: (emoji: string) => Promise<unknown> } | null;
        await sent?.react?.(result.react).catch(() => {});
      }

      // A decline said nothing, so the thought is still unsaid and the clock is not reset.
      if (result.declined) return;
      if (pending) agent.clearPending();
      this.lastActivity.set(key, Date.now());
      this.lastSpoke.set(key, Date.now());
      this.applyPresence(result.mood.mood, false);
    } catch (err) {
      if (sending) this.agentFor(key, where).noteDelivery(false, err);
      throw err;
    } finally {
      clearInterval(ticker);
    }
  }

  private applyPresence(mood: Mood, force: boolean): void {    const now = Date.now();
    if (!force && now - this.lastPresence < PRESENCE_THROTTLE_MS) return;
    this.lastPresence = now;

    const user = this.client.user;
    if (!user) return;
    user.setPresence({
      status: PRESENCE[mood],
      activities: [{ name: ACTIVITY[mood], type: ActivityType.Watching }],
    });
  }
}

export async function startDiscord(
  createAgent: (where: string) => Agent,
  opts: DiscordOptions,
): Promise<DiscordHandle> {
  const bot = new DiscordBot(createAgent, opts);
  await bot.start();
  return { tag: bot.tag, gate: bot.gateName, stop: () => bot.stop() };
}
