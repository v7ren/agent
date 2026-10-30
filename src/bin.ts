import { CONFIG } from "./config.ts";
import { execFileSync } from "node:child_process";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { makeProvider } from "./core/provider.ts";
import { CacheLog } from "./core/cache.ts";
import { estimateTokens } from "./core/budget.ts";
import { Agent } from "./core/loop.ts";
import { appendMoodLog, appendSelfLog, loadPersona, moodStore, saveMood, selfStore } from "./persona/persona.ts";
import { resolvePersonaDir } from "./persona/packs.ts";
import { startBodyClock } from "./persona/clock.ts";
import { DriveKit } from "./persona/drives.ts";
import { DeclineLimiter, declineMaxFromEnv } from "./persona/decline.ts";
import { IgnoreBook } from "./persona/ignorebook.ts";
import { StandingRules } from "./persona/standing.ts";
import { log } from "./log.ts";
import { windowFromEnv } from "./core/window.ts";
import { markAlive, markStart, markStop } from "./persona/presence.ts";
import type { OfflineInfo } from "./persona/presence.ts";
import { ensureDiaries } from "./memory/autodiary.ts";
import { createPetLink } from "./channels/petLink.ts";
import { VaultMemory } from "./memory/vaultMemory.ts";
import { runCli } from "./channels/cli.ts";
import { parseBudget } from "./channels/burst.ts";
import { envNumber } from "./env.ts";

function listEnv(name: string): string[] {
  return (process.env[name] ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

/**
 * One shared vault, one shared mood, one shared cache log — but a separate
 * conversation window per room, so private messages never leak into a
 * public channel's verbatim history.
 */
function personaTokens(pack?: string): number {
  return loadPersona(CONFIG.personaDir, pack).reduce(
    (n, block) => n + estimateTokens(block.content),
    0,
  );
}

/** Owners, read live: DISCORD_OWNER_IDS, or the DM list when that is empty. */
function currentOwnerIds(): string[] {
  const owners = listEnv("DISCORD_OWNER_IDS");
  return owners.length > 0 ? owners : listEnv("DISCORD_DM_USERS");
}

function makeAgentFactory(
  offline: OfflineInfo | null = null,
  ignoreBook?: IgnoreBook,
): (where?: string, key?: string) => Agent {
  const pack = (process.env.FISHD_PACK ?? "").trim();
  const persona = loadPersona(CONFIG.personaDir, pack);
  const notesDir = resolvePersonaDir(CONFIG.personaDir, pack);
  const memory = new VaultMemory(CONFIG.vaultRoot);
  const cache = new CacheLog();
  const store = moodStore(CONFIG.stateDir);
  const self = selfStore(CONFIG.stateDir);
  const personaLoader = () => loadPersona(CONFIG.personaDir, (process.env.FISHD_PACK ?? "").trim());
  // File-backed, so every room's agent shares one set of drives, slots and tuning.
  const drives = new DriveKit({ dir: CONFIG.stateDir });
  // What the owner told her to do from now on. One file for every room.
  const rules = new StandingRules(join(CONFIG.stateDir, "standing-rules.json"));
  // One limiter for every room, so "3 declines an hour" means the whole fish.
  const decliner = new DeclineLimiter(declineMaxFromEnv(process.env));
  // dsh-pet reads this local JSONL bus; `FISHD_PET=0` disables it completely.
  const petEvents =
    (process.env.FISHD_PET_EVENTS ?? "").trim() ||
    join(CONFIG.stateDir, "pet-events.jsonl");
  const petLink =
    process.env.FISHD_PET === "0" ? null : createPetLink(petEvents);

  // One big window for the whole fish, from FISHD_CONTEXT_TOKENS (default 100k);
  // "off" brings back the old turn-count window.
  const window = windowFromEnv(process.env);

  return (where?: string, key?: string) =>
    new Agent({
      ...(window ? { window } : {}),
      ...(key ? { historyKey: key } : {}),
      drives,
      offline,
      decliner,
      ...(ignoreBook ? { ignores: ignoreBook } : {}),
      rules,
      stateDir: CONFIG.stateDir,
      provider: makeProvider(),
      persona,
      personaLoader,
      mood: store.load(),
      moodStore: store,
      selfStore: self,
      onSelfChange: (_next, lines) => {
        appendSelfLog(CONFIG.stateDir, lines.join("；"));
        log.info("self", lines.join("；"));
      },
      memory,
      cache,
      budget: {
        static: CONFIG.staticBudget,
        stable: CONFIG.stableBudget,
        chain: 8000,
        hot: 12000,
        tip: 1500,
      },
      hotTurns: CONFIG.hotTurns,
      maxTokens: CONFIG.maxTokens,
      temperature: CONFIG.temperature,
      voice: CONFIG.voice,
      where,
      notesDir,
      sessionsDir: CONFIG.vaultRoot,
      shareDir: CONFIG.shareDir,
      compactEvery: CONFIG.hotTurns,
      onMoodChange: (_next, line) => {
        appendMoodLog(CONFIG.stateDir, line);
        log.info("mood", line);
      },
      onState: petLink?.emit,
    });
}

async function runCheck(): Promise<void> {
  const { makeGate } = await import("./channels/gate.ts");

  try {
    const provider = makeProvider();
    console.log(`provider : ${provider.name}`);
  } catch (err) {
    console.log(`provider : ✗ ${err instanceof Error ? err.message : String(err)}`);
  }
  console.log(`model    : ${process.env.FISHD_MODEL || "(default)"}`);

  const pack = (process.env.FISHD_PACK ?? "").trim();
  const tokens = personaTokens(pack);
  console.log(
    `persona  : ${tokens} tok / ${CONFIG.staticBudget}` +
      (tokens > CONFIG.staticBudget ? "  ⚠ 超過上限" : ""),
  );

  const { gate, label } = makeGate();
  console.log(`gate     : ${label}`);

  if (gate.name !== "heuristic") {
    const started = Date.now();
    const verdict = await gate.decide({
      channel: "check",
      messages: [
        { author: "小明", text: "今天要吃什麼好呢", at: 0 },
        { author: "阿華", text: "去吃白飯吧", at: 1 },
      ],
      names: listEnv("DISCORD_NAMES").length ? listEnv("DISCORD_NAMES") : ["大肥魚", "肥魚"],
      lastSpokeAt: Date.now() - 3_600_000,
      now: Date.now(),
      base: 0.12,
      messageId: "check-1",
    });
    console.log(`gate test: ${verdict ? "YES" : "NO"} in ${Date.now() - started}ms`);
    const prob = (gate as { lastProbability?: number | null }).lastProbability;
    const threshold = (gate as { threshold?: number }).threshold;
    if (typeof prob === "number") {
      console.log(`gate p   : ${prob.toFixed(2)} (threshold ${threshold ?? "?"})`);
    }
  }

  console.log(`discord  : ${process.env.DISCORD_TOKEN ? "token set" : "no token"}`);
  console.log(`ambient  : ${process.env.DISCORD_AMBIENT === "1" ? "on" : "off"}`);
  console.log(`channels : ${listEnv("DISCORD_CHANNEL_IDS").length} always-reply`);
}

/**
 * Finished days get a diary on their own: once shortly after start, then every
 * half hour. A failure is logged and retried next start, never in a loop.
 */
function startDiaryWatch(): void {
  const run = async () => {
    try {
      const made = await ensureDiaries({
        root: CONFIG.vaultRoot,
        provider: makeProvider(),
        ...((process.env.FISHD_MODEL ?? "").trim() ? { model: process.env.FISHD_MODEL!.trim() } : {}),
        now: new Date(),
      });
      for (const path of made) console.log(`diary · ${path}`);
    } catch (err) {
      console.error("[diary]", err instanceof Error ? err.message : err);
    }
  };
  setTimeout(() => void run(), 30_000).unref();
  setInterval(() => void run(), 30 * 60_000).unref();
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);

  // Only a long-running bot has "being away" to remember; one-shot commands do not.
  const longRunning = args.includes("--discord") || args.includes("--web");
  const offline = longRunning ? markStart(CONFIG.stateDir, new Date()).offline : null;
  if (longRunning) {
    // Covers every way out of the process, including a failed login.
    process.once("exit", () => markStop(CONFIG.stateDir, new Date()));
    const beat = setInterval(() => markAlive(CONFIG.stateDir, new Date()), 60_000);
    beat.unref();
    startDiaryWatch();
  }
  // One list for every room and for the Discord layer, kept in a file.
  const ignoreBook = new IgnoreBook({
    path: join(CONFIG.stateDir, "ignored.json"),
    ownerIds: currentOwnerIds,
  });
  const buildAgent = makeAgentFactory(offline, ignoreBook);

  const configuredModel = (process.env.FISHD_MODEL ?? "").trim();
  if (configuredModel !== "" && /\s/.test(configuredModel)) {
    console.warn(
      `⚠ FISHD_MODEL="${configuredModel}" 含有空白，不是有效的 model id。` +
        `請在設定裡用選單挑一個，例如 deepseek-flash。`,
    );
  }

  const bootTokens = personaTokens((process.env.FISHD_PACK ?? "").trim());
  if (bootTokens > CONFIG.staticBudget) {
    console.warn(
      `⚠ 人格共 ${bootTokens} tok，超過上限 ${CONFIG.staticBudget}。` +
        `第一則訊息會失敗；設 FISHD_STATIC_BUDGET=${bootTokens + 500} 或精簡 pasted.md。`,
    );
  }

  if (args.includes("--check")) {
    await runCheck();
    return;
  }

  if (args.includes("--import-dsh")) {
    const at = args.indexOf("--import-dsh");
    const source = args[at + 1] ?? "";
    if (source === "") {
      console.error("用法：node src/bin.ts --import-dsh <資料夾或 git url>");
      process.exit(1);
    }

    const { importDshPersona } = await import("./persona/dsh-import.ts");
    let dir = source;
    let tmp: string | null = null;

    // The clone lands in a temp dir, so derive the pack name from the URL.
    const slugSource = source.replace(/[/\\]+$/, "").split(/[/\\]/).pop() ?? "";
    const slug = slugSource.replace(/\.git$/, "");

    if (/^(https?:|git@)/.test(source)) {
      tmp = join(tmpdir(), `fishd-dsh-${Date.now()}`);
      console.log(`clone · ${source}`);
      execFileSync("git", ["clone", "--depth", "1", source, tmp], { stdio: "ignore" });
      dir = tmp;
    }

    try {
      const result = importDshPersona({
        sourceDir: dir,
        personaDir: CONFIG.personaDir,
        slug,
        credit: source,
      });

      if (!result) {
        console.log("找不到 persona 區塊（需要 text: |- 或 persona: |-）。");
        return;
      }

      console.log(`pack · ${result.pack}`);
      console.log(`  ${result.path}  (${result.chars} chars, from ${result.source})`);
      console.log(`  在 .env 設 FISHD_PACK=${result.pack} 後重啟`);
    } finally {
      if (tmp) rmSync(tmp, { recursive: true, force: true });
    }
    return;
  }

  if (args.includes("--migrate")) {
    const { migrateJournals } = await import("./memory/migrate.ts");
    const result = migrateJournals(CONFIG.vaultRoot);
    console.log(
      `migrated ${result.files} file(s) · ${result.converted} line(s) · backups kept as *.md.bak`,
    );
    return;
  }

  if (args.includes("--diary")) {
    const { writeDiary } = await import("./memory/diary.ts");
    const at = args.indexOf("--diary");
    const arg = args[at + 1];
    const date =
      typeof arg === "string" && /^\d{4}-\d{2}-\d{2}$/.test(arg)
        ? new Date(`${arg}T12:00:00`)
        : new Date(Date.now() - 86_400_000);

    const result = await writeDiary({
      root: CONFIG.vaultRoot,
      date,
      provider: makeProvider(),
      maxTokens: 900,
    });

    if (!result) {
      console.log("那天沒有紀錄。");
      return;
    }
    console.log(`diary · ${result.path}`);
    console.log("");
    console.log(result.text);
    return;
  }

  // She has a pulse even when nobody is typing. The timer is unref'd, so a
  // one-shot command still exits immediately.
  const stopClock = startBodyClock({
    stateDir: CONFIG.stateDir,
    onError: (err) => console.error("[body]", err),
  });

  const wantDiscord = args.includes("--discord");
  const explicitWeb = args.includes("--web");
  const sayIdx = args.indexOf("--say");
  const oneShot = sayIdx !== -1 && !wantDiscord && !explicitWeb;

  const webAllowed = !wantDiscord || process.env.FISHD_WEB !== "0";
  // Bare `node src/bin.ts` is the terminal chat; web starts with --web or the bot.
  const wantWeb = !oneShot && webAllowed && (explicitWeb || wantDiscord);

  // Plain chat: no channels, no server.
  if (!wantDiscord && !wantWeb && sayIdx === -1) {
    const agent = buildAgent(undefined, "cli");
    try {
      await runCli(agent);
    } finally {
      stopClock();
    }
    saveMood(CONFIG.stateDir, agent.moodState);
    return;
  }

  const closers: Array<{ name: string; close: () => Promise<void> }> = [];
  let webAgent: Agent | null = null;

  if (wantWeb) {
    webAgent = buildAgent(undefined, "web");
    const { startWeb } = await import("./web/server.ts");
    try {
      const web = await startWeb(webAgent, {
        vaultRoot: CONFIG.vaultRoot,
        personaDir: CONFIG.personaDir,
        shareDir: CONFIG.shareDir,
        port: envNumber("FISHD_PORT", 7777, 1),
      });
      console.log(`web     · http://127.0.0.1:${web.port}`);
      closers.push({ name: "web", close: web.close });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      console.warn(`web     · 啟動失敗（${msg}），其餘照常`);
    }
  }

  if (wantDiscord) {
    const token = process.env.DISCORD_TOKEN ?? "";
    if (token === "") {
      console.error("缺少 DISCORD_TOKEN，寫在 .env 或環境變數裡。");
      process.exit(1);
    }

    const { startDiscord } = await import("./channels/discord.ts");
    const { makeGate } = await import("./channels/gate.ts");
    const { gate, label: gateLabel } = makeGate();

    const ambient = process.env.DISCORD_AMBIENT === "1";
    const dmUsers = listEnv("DISCORD_DM_USERS");
    const ownerIds = listEnv("DISCORD_OWNER_IDS").length > 0 ? listEnv("DISCORD_OWNER_IDS") : dmUsers;

    const sponTargets = listEnv("DISCORD_SPON_CHANNELS");
    const spontChannels = sponTargets.length > 0 ? sponTargets : listEnv("DISCORD_CHANNEL_IDS");
    const spontDm = process.env.DISCORD_SPON_DM !== "0";
    const spontaneous =
      spontChannels.length > 0 || (spontDm && ownerIds.length > 0)
        ? {
            channels: spontChannels,
            ownerIds,
            dm: spontDm,
            plan: {
              minMinutes: envNumber("DISCORD_SPON_MIN", 90, 1),
              maxMinutes: envNumber("DISCORD_SPON_MAX", 240, 1),
              quietMinutes: envNumber("DISCORD_SPON_QUIET", 20, 0),
              hushFrom: 1,
              hushTo: 6,
            },
          }
        : undefined;

    const handle = await startDiscord(buildAgent, {
      token,
      alwaysChannels: listEnv("DISCORD_CHANNEL_IDS"),
      guilds: listEnv("DISCORD_GUILD_IDS"),
      onlyChannels: listEnv("DISCORD_ONLY_CHANNELS"),
      dmUsers,
      ownerIds,
      ignoreBook,
      ping: process.env.DISCORD_PING === "1",
      singleSession: process.env.DISCORD_SINGLE_SESSION === "1",
      ignoreUsers: listEnv("DISCORD_IGNORE_USERS"),
      dms: process.env.DISCORD_DMS !== "0",
      replyAll: process.env.DISCORD_REPLY_ALL === "1",
      ambient,
      ambientChance: envNumber("DISCORD_AMBIENT_P", 0.12, 0),
      talk: envNumber("DISCORD_TALK", 1, 0.1),
      ambientCooldown: envNumber("DISCORD_AMBIENT_COOLDOWN", 45, 0),
      burstMs: envNumber("DISCORD_BURST_MIN", 10, 1) * 60_000,
      armMs: envNumber("DISCORD_ARM_MS", 3000, 0),
      settleMinutes: envNumber("DISCORD_SETTLE_MIN", 3, 0),
      budget: parseBudget(process.env.DISCORD_BUDGET ?? "4/30"),
      names: listEnv("DISCORD_NAMES"),
      gate,
      spontaneous,
    });

    const always = listEnv("DISCORD_CHANNEL_IDS");
    console.log(`discord · ${handle.tag}`);
    console.log("  回應：私訊、@她、回覆她、叫名字" + (always.length ? `、${always.join(", ")}` : ""));
    if (dmUsers.length > 0) console.log(`  私訊：只回 ${dmUsers.length} 個使用者（主人）`);
    else if (process.env.DISCORD_DM_OPEN === "1") console.log("  私訊：開放給所有人（DISCORD_DM_OPEN=1）");
    else console.log(`  私訊：只回主人（${ownerIds.length} 人，DISCORD_OWNER_IDS）`);
    if (process.env.DISCORD_DMS === "0") console.log("  私訊：關閉");
    const only = listEnv("DISCORD_ONLY_CHANNELS");
    if (only.length > 0) console.log(`  只在這些頻道回：${only.join(", ")}`);
    if (ambient) {
      console.log(`  自己接話：開 · 判斷者 ${gateLabel} · 沉默預算 ${process.env.DISCORD_BUDGET ?? "4/30"}`);
    }
    if (spontaneous) {
      const on = process.env.DISCORD_SPONTANEOUS === "1";
      const targets: string[] = [];
      if (spontChannels.length > 0) {
        targets.push(
          `頻道 ${spontChannels.length} 個（${envNumber("DISCORD_SPON_MIN", 45, 1)}–${envNumber("DISCORD_SPON_MAX", 120, 1)} 分，安靜 ${envNumber("DISCORD_SPON_QUIET", 20, 0)} 分）`,
        );
      }
      if (spontDm && ownerIds.length > 0) {
        targets.push(
          `私訊 ${ownerIds.length} 人（${envNumber("DISCORD_SPON_DM_MIN", 60, 1)}–${envNumber("DISCORD_SPON_DM_MAX", 180, 1)} 分，安靜 ${envNumber("DISCORD_SPON_DM_QUIET", envNumber("DISCORD_SPON_QUIET", 20, 0), 0)} 分）`,
        );
      }
      console.log(
        `  自己冒出來：${on ? "開" : "關"} · 頻道安靜 ${envNumber("DISCORD_SPON_QUIET", 20, 0)} 分 › ` +
          `${targets.join(" + ") || "（無，設 DISCORD_SPON_CHANNELS）"}`,
      );
    }
    console.log("  其他訊息保持安靜。");
    if (process.env.DISCORD_SINGLE_SESSION === "1") console.log("  對話：所有頻道與私訊共用同一個 session");
    console.log("  指令：/mood /stats /recall /diary /config /ping /help");

    closers.push({ name: "discord", close: handle.stop });
  }

  if (sayIdx !== -1) {
    const text = args[sayIdx + 1] ?? "";
    if (text === "") {
      console.error("--say needs text");
      process.exit(1);
    }
    const agent = webAgent ?? buildAgent();
    const r = await agent.turn(text);
    for (const s of r.segments) console.log(`🐟 ${s}`);
    console.log(r.footer);
  }

  if (closers.length === 0) return;

  const shutdown = async () => {
    stopClock();
    markStop(CONFIG.stateDir, new Date());
    for (const closer of closers) await closer.close().catch(() => {});
    saveMood(CONFIG.stateDir, (webAgent ?? buildAgent()).moodState);
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown());
  process.on("SIGTERM", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
