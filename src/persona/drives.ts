import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ToolSpec } from "../types.ts";
import { applyEnvUpdate, defaultEnvPath } from "../settings-write.ts";
import {
  MAX_RULES,
  acknowledgeWake,
  loadRules,
  loadState,
  parseRules,
  renderStats,
  saveState,
  tickStats,
} from "./stats.ts";
import type { StatRule, StatsState } from "./stats.ts";
import {
  addSlot,
  loadStore,
  pruneStale,
  removeSlot,
  renderSlots,
  replaceSlot,
  saveStore,
  touchSlot,
} from "./slots.ts";
import type { SlotStore } from "./slots.ts";
import {
  TUNABLE,
  appendLog,
  approveChange,
  loadLog,
  proposeChange,
  renderTuneState,
  saveLog,
  undoChange,
} from "./selftune.ts";
import type { Change } from "./selftune.ts";

/** Slots she has not looked at for this long may be pruned (never below the floor). */
const STALE_DAYS = 60;

export interface DriveKitOptions {
  /** state directory; files are drives-rules.json, drives-state.json, keep.json, tune-log.json */
  dir: string;
  /** write a setting into .env (injectable for tests) */
  applyEnv?: (values: Record<string, string>) => void;
  /** the .env text to validate a change against (injectable for tests) */
  readEnv?: () => string;
}

export const DRIVE_TOOLS: ToolSpec[] = [
  {
    name: "drive",
    description:
      "管理你自己的『數值』（想你、餓、想被摸這類會慢慢漲的感覺）。" +
      "action=list 看全部；set 新增或修改一個（name 必填，其餘可省略）；remove 刪掉；ack 表示你已經處理了被喚醒的原因。" +
      "數值到門檻時會喚醒你：onThreshold=wake 留著等你處理；reset 歸零；halve 折半。最多 12 個。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set", "remove", "ack"] },
        name: { type: "string", description: "數值名稱，20 字內" },
        gain_per_hour: { type: "number", description: "每小時加多少，-200 到 200" },
        gain_on_message: { type: "number", description: "他每說一句話加多少，可以是負的" },
        threshold: { type: "number", description: "到這個值就觸發" },
        max: { type: "number", description: "上限，1-1000" },
        start_value: { type: "number" },
        on_threshold: { type: "string", enum: ["wake", "reset", "halve"] },
        record_peak: { type: "boolean", description: "是否記錄最高紀錄" },
        quiet_gain: { type: "number", description: "凌晨 1-6 點的增長倍率，0 到 1" },
      },
      required: ["action"],
    },
  },
  {
    name: "keep",
    description:
      "永久記憶格，只能放 5 到 10 條，真的很重要才放（第一次吃白飯、有人誇你之類）。" +
      "action=list 看全部（含 id）；add 新增（text、why）；replace 換掉一條（id、text、why）；remove 刪掉（id）。滿了就要先換或刪。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "add", "replace", "remove"] },
        id: { type: "string" },
        text: { type: "string", description: "120 字內" },
        why: { type: "string", description: "為什麼重要，80 字內" },
      },
      required: ["action"],
    },
  },
  {
    name: "tune",
    description:
      "調整你自己的少數行為設定（例如多久主動找他一次、私訊間隔、凌晨靜音時段）。" +
      "在小範圍內會直接生效；超出範圍要等主人同意；金鑰、名單、模型這類不能動。每天次數有限，而且主人可以還原。" +
      "action=set 要給 key 和 value；list 看可調整的項目和最近的改動；undo 要給 id。",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["list", "set", "undo"] },
        key: { type: "string" },
        value: { type: "string" },
        id: { type: "string" },
      },
      required: ["action"],
    },
  },
];

function writeJson(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(data, null, 2), "utf8");
  renameSync(tmp, path);
}

function num(v: unknown): number | undefined {
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}

export class DriveKit {
  private rulesPath: string;
  private statePath: string;
  private slotsPath: string;
  private tunePath: string;
  private applyEnv: (values: Record<string, string>) => void;
  private readEnv: () => string;

  constructor(opts: DriveKitOptions) {
    this.rulesPath = join(opts.dir, "drives-rules.json");
    this.statePath = join(opts.dir, "drives-state.json");
    this.slotsPath = join(opts.dir, "keep.json");
    this.tunePath = join(opts.dir, "tune-log.json");
    this.applyEnv = opts.applyEnv ?? ((values) => applyEnvUpdate(values));
    this.readEnv =
      opts.readEnv ??
      (() => {
        const p = defaultEnvPath();
        return existsSync(p) ? readFileSync(p, "utf8") : "";
      });
  }

  tools(): ToolSpec[] {
    return DRIVE_TOOLS;
  }

  owns(name: string): boolean {
    return DRIVE_TOOLS.some((t) => t.name === name);
  }

  rules(): StatRule[] {
    return loadRules(this.rulesPath);
  }

  private state(rules: StatRule[], now: Date): StatsState {
    let state = loadState(this.statePath);
    const values = { ...state.values };
    for (const r of rules) if (values[r.name] === undefined) values[r.name] = r.startValue;
    state = { ...state, values, lastTickAt: state.lastTickAt || now.toISOString() };
    return state;
  }

  /** Advance every drive. Returns the names that just crossed their threshold. */
  tick(now: Date, userMessages: number): string[] {
    const rules = this.rules();
    const { state, woke } = tickStats(this.state(rules, now), rules, now, { userMessages });
    saveState(this.statePath, state);

    const store = loadStore(this.slotsPath);
    const pruned = pruneStale(store, now.toISOString(), STALE_DAYS);
    if (pruned.removed.length > 0) saveStore(this.slotsPath, pruned.store);
    return woke;
  }

  /** Drives that woke her and have not been handled yet. */
  wakeNames(): string[] {
    return loadState(this.statePath).pendingWake;
  }

  acknowledge(names: string[], now: Date): void {
    if (names.length === 0) return;
    const rules = this.rules();
    saveState(this.statePath, acknowledgeWake(this.state(rules, now), names, rules));
  }

  /** One block for the prompt tip. */
  render(now: Date): string {
    const rules = this.rules();
    const stats = renderStats(this.state(rules, now), rules);
    const slots = renderSlots(loadStore(this.slotsPath));
    const woke = this.wakeNames();
    const wake = woke.length > 0 ? `（你被這些喚醒了：${woke.join("、")}。處理完用 drive ack。）` : "";
    const pending = this.pendingChanges();
    const tune =
      pending.length > 0 ? `（你有 ${pending.length} 項設定改動在等主人同意。）` : "";
    return [stats, wake, slots, tune].filter(Boolean).join("\n");
  }

  pendingChanges(): Change[] {
    return loadLog(this.tunePath).filter((c) => c.status === "pending");
  }

  recentChanges(): Change[] {
    return loadLog(this.tunePath);
  }

  /** Owner approves a pending change. Returns a message for the owner. */
  approve(id: string, now: Date): string {
    const log = loadLog(this.tunePath);
    const r = approveChange(this.readEnv(), log, id, now);
    if (!r.change || r.newEnvText === undefined) return "找不到這個等待中的改動。";
    this.applyEnv({ [r.change.key]: r.change.to });
    saveLog(this.tunePath, appendLog(log, r.change));
    return `已套用：${r.change.key} ${r.change.from || "（空）"} → ${r.change.to}`;
  }

  /** Owner (or she herself) undoes an applied change. */
  undo(id: string, now: Date): string {
    const log = loadLog(this.tunePath);
    const r = undoChange(this.readEnv(), log, id, now);
    if (!r.change) return "找不到這個改動。";
    if (r.newEnvText === undefined) return r.change.reason ?? "沒有還原。";
    this.applyEnv({ [r.change.key]: r.change.from });
    saveLog(this.tunePath, appendLog(log, r.change));
    return `已還原：${r.change.key} → ${r.change.from || "（空）"}`;
  }

  /** Run one of our tools. `self` is her; owner actions go through approve/undo. */
  run(name: string, args: Record<string, unknown>, now: Date): string {
    const action = String(args["action"] ?? "");
    if (name === "drive") return this.runDrive(action, args, now);
    if (name === "keep") return this.runKeep(action, args, now);
    if (name === "tune") return this.runTune(action, args, now);
    return `不認識的工具：${name}`;
  }

  private runDrive(action: string, args: Record<string, unknown>, now: Date): string {
    const rules = this.rules();

    if (action === "list") {
      const state = this.state(rules, now);
      if (rules.length === 0) return "你現在沒有任何數值。";
      return rules
        .map((r) => {
          const peak = state.peaks[r.name];
          return (
            `${r.name}：${Math.round(state.values[r.name] ?? 0)}/${r.max}，門檻 ${r.threshold}，` +
            `每小時 +${r.gainPerHour}，到了${r.onThreshold}` +
            (peak ? `，最高 ${Math.round(peak.value)}` : "")
          );
        })
        .join("\n");
    }

    const name = String(args["name"] ?? "").trim();

    if (action === "ack") {
      const names = name === "" ? this.wakeNames() : [name];
      this.acknowledge(names, now);
      return names.length === 0 ? "沒有等著處理的。" : `好，${names.join("、")}處理完了。`;
    }

    if (name === "") return "要給數值名稱。";

    if (action === "remove") {
      const left = rules.filter((r) => r.name !== name);
      if (left.length === rules.length) return `沒有叫「${name}」的數值。`;
      writeJson(this.rulesPath, { rules: left });
      return `刪掉了「${name}」。`;
    }

    if (action === "set") {
      const existing = rules.find((r) => r.name === name);
      const base: StatRule = existing ?? {
        name,
        startValue: 0,
        gainPerHour: 3,
        max: 100,
        threshold: 80,
        onThreshold: "wake",
        recordPeak: true,
      };
      const next: Record<string, unknown> = { ...base };
      const gph = num(args["gain_per_hour"]);
      if (gph !== undefined) next["gainPerHour"] = gph;
      const gom = num(args["gain_on_message"]);
      if (gom !== undefined) next["gainOnUserMessage"] = gom;
      const th = num(args["threshold"]);
      if (th !== undefined) next["threshold"] = th;
      const mx = num(args["max"]);
      if (mx !== undefined) next["max"] = mx;
      const sv = num(args["start_value"]);
      if (sv !== undefined) next["startValue"] = sv;
      const qg = num(args["quiet_gain"]);
      if (qg !== undefined) next["quietHoursGain"] = qg;
      if (typeof args["on_threshold"] === "string") next["onThreshold"] = args["on_threshold"];
      if (typeof args["record_peak"] === "boolean") next["recordPeak"] = args["record_peak"];

      const others = rules.filter((r) => r.name !== name);
      const parsed = parseRules([...others, next]);
      if (!parsed.rules.some((r) => r.name === name)) {
        return `不行：${parsed.errors.join("；") || `最多 ${MAX_RULES} 個數值`}`;
      }
      writeJson(this.rulesPath, { rules: parsed.rules });
      return existing ? `改好了「${name}」。` : `新增了「${name}」。`;
    }

    return "action 要是 list、set、remove 或 ack。";
  }

  private runKeep(action: string, args: Record<string, unknown>, now: Date): string {
    let store: SlotStore = loadStore(this.slotsPath);
    const iso = now.toISOString();

    if (action === "list") {
      if (store.slots.length === 0) return "還沒有永久記憶。";
      for (const s of store.slots) store = touchSlot(store, s.id, iso);
      saveStore(this.slotsPath, store);
      return store.slots.map((s) => `[${s.id}] ${s.text}${s.why ? `（${s.why}）` : ""}`).join("\n");
    }

    const text = String(args["text"] ?? "");
    const why = String(args["why"] ?? "");
    const id = String(args["id"] ?? "");

    let result;
    if (action === "add") result = addSlot(store, { text, why }, iso, "self");
    else if (action === "replace") result = replaceSlot(store, id, { text, why }, iso, "self");
    else if (action === "remove") result = removeSlot(store, id, iso, "self");
    else return "action 要是 list、add、replace 或 remove。";

    if (!result.ok) return `不行：${result.reason ?? "原因不明"}`;
    saveStore(this.slotsPath, result.store);
    return `好，現在有 ${result.store.slots.length} 條永久記憶。`;
  }

  private runTune(action: string, args: Record<string, unknown>, now: Date): string {
    const log = loadLog(this.tunePath);

    if (action === "list") {
      const keys = Object.entries(TUNABLE)
        .map(([k, s]) => `${k}（${s.softMin}-${s.softMax}）`)
        .join("、");
      return `可調整：${keys}\n${renderTuneState(log, now)}`.trim();
    }

    if (action === "undo") {
      return this.undo(String(args["id"] ?? ""), now);
    }

    if (action === "set") {
      const key = String(args["key"] ?? "");
      const value = String(args["value"] ?? "");
      const r = proposeChange(this.readEnv(), key, value, now, "self", log);
      saveLog(this.tunePath, appendLog(log, r.change));
      if (r.change.status === "applied" && r.newEnvText !== undefined) {
        this.applyEnv({ [r.change.key]: r.change.to });
        return `改好了：${key} ${r.change.from || "（空）"} → ${r.change.to}（id ${r.change.id}）`;
      }
      if (r.change.status === "pending") {
        return `超出你能自己決定的範圍，已送給主人等他同意（id ${r.change.id}）。`;
      }
      return `不行：${r.change.reason ?? "原因不明"}`;
    }

    return "action 要是 list、set 或 undo。";
  }
}
