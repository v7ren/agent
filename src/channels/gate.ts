import { ambientChime } from "./ambient.ts";
import { makeProvider } from "../core/provider.ts";
import { OpenAICompatProvider } from "../core/openai.ts";
import { readAuthKey } from "../core/opencode-auth.ts";
import { envNumber } from "../env.ts";
import { liveSettings } from "../live.ts";

export interface GateMessage {
  author: string;
  text: string;
  at: number;
  /** who the line was for, when it was plainly for someone ("她" = her) */
  to?: string[];
  /** a line she said herself */
  self?: boolean;
}

export interface GateInput {
  channel: string;
  /** most recent last */
  messages: GateMessage[];
  names: string[];
  lastSpokeAt: number;
  now: number;
  /** base chance for the heuristic fallback */
  base: number;
  messageId: string;
  /** >1 means "she just spoke, demand more confidence"; 1 = no penalty */
  bias?: number;
}

export interface Gate {
  readonly name: string;
  decide(input: GateInput): Promise<boolean>;
}

export class HeuristicGate implements Gate {
  readonly name = "heuristic";

  async decide(input: GateInput): Promise<boolean> {
    const last = input.messages[input.messages.length - 1];
    if (!last) return false;
    const prev = input.messages[input.messages.length - 2];

    return ambientChime({
      text: last.text,
      messageId: input.messageId,
      authorId: last.author,
      prevAuthor: prev?.author,
      lastSpokeAt: input.lastSpokeAt,
      now: input.now,
      base: input.base / Math.max(1, input.bias ?? 1),
      names: input.names,
    });
  }
}

export function buildGatePrompt(input: GateInput): string {
  const lines = input.messages
    .slice(-10)
    .map((m) => `${m.author}：${m.text}`)
    .join("\n");
  const quiet = Math.max(0, Math.round((input.now - input.lastSpokeAt) / 60_000));

  return [
    "你是一隻叫「大肥魚」的藍色胖魚，有點傲嬌，最喜歡白飯。你在一群人聊天的 Discord 頻道裡。",
    "你不是助理，不需要回應每一句話。只有真的有話想說、被點名、或話題剛好戳到你時才開口。",
    "不要搶別人的話，也不要每句都接。安靜是預設值。",
    "",
    "最近的訊息（舊到新）：",
    lines,
    "",
    `大家叫你的名字：${input.names.join("、")}`,
    `距離你上次開口：${quiet} 分鐘`,
    "",
    "看完最後一則訊息，你要不要插話？只回一個字：YES 或 NO。",
  ].join("\n");
}

/** Tolerant on purpose: small models like to add punctuation or an explanation. */
export function parseVerdict(raw: string): boolean | null {
  const word = /[A-Za-z]+/.exec(raw);
  if (word) {
    const head = (word[0] ?? "").toUpperCase();
    if (head === "YES" || head === "Y" || head === "TRUE" || head === "YEAH") return true;
    if (head === "NO" || head === "N" || head === "FALSE" || head === "NAH") return false;
    return null;
  }

  // Negatives first: 不是 contains 是, so order matters.
  if (/不是|不好|不要|不用|不必|不想|不行|沒有|没有|否|別|别/.test(raw)) return false;
  if (/好|要|是|行|可以/.test(raw)) return true;
  return null;
}

export interface LlmGateOptions {
  complete: (prompt: string, signal: AbortSignal) => Promise<string>;
  fallback: Gate;
  timeoutMs?: number;
  maxPerMinute?: number;
}

/**
 * A model reads the room and answers one question: should she speak?
 * Any failure — no network, timeout, rate limit, gibberish answer — falls
 * back to the heuristic, so the bot never goes silent because a gate broke.
 */
export class LlmGate implements Gate {
  readonly name = "llm";
  readonly model: string;
  private opts: LlmGateOptions;
  private stamps: number[] = [];

  constructor(opts: LlmGateOptions, model = "?" ) {
    this.opts = opts;
    this.model = model;
  }

  private allowed(now: number): boolean {
    const cutoff = now - 60_000;
    this.stamps = this.stamps.filter((t) => t >= cutoff);
    if (this.stamps.length >= (this.opts.maxPerMinute ?? 6)) return false;
    this.stamps.push(now);
    return true;
  }

  async decide(input: GateInput): Promise<boolean> {
    if (!this.allowed(input.now)) return this.opts.fallback.decide(input);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.opts.timeoutMs ?? 6000);

    try {
      const raw = await this.opts.complete(buildGatePrompt(input), controller.signal);
      const verdict = parseVerdict(raw);
      if (verdict === null) return this.opts.fallback.decide(input);
      return verdict;
    } catch {
      return this.opts.fallback.decide(input);
    } finally {
      clearTimeout(timer);
    }
  }
}

export interface GateSelection {
  gate: Gate;
  label: string;
}

function splitList(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
}

function withTimeout(ms: number): { signal: AbortSignal; done: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ms);
  return { signal: controller.signal, done: () => clearTimeout(timer) };
}

/**
 * Talkativeness divides the threshold, so 2.0 means "speak at half the
 * probability", i.e. much more often. Clamped so it can never reach 0
 * (always talks) or 1 (never talks).
 */
export function scaledThreshold(base: number, talk: number): number {
  const factor = Number.isFinite(talk) && talk > 0 ? talk : 1;
  return Math.min(0.95, Math.max(0.02, base / factor));
}

/* ------------------------------------------------------------------ */
/* Jev — System One. Returns a probability, not a sentence.           */
/* ------------------------------------------------------------------ */

export interface JevOptions {
  apiKey: string;
  baseUrl?: string;
  model?: string;
  threshold?: number;
  /** read per decision, so the threshold can change without a restart */
  thresholdFn?: () => number;
  /** how much being addressed lowers the bar (0 = ignore, 1 = halve it) */
  toMeBonusFn?: () => number;
  /** how much talking to someone else raises the bar */
  notMePenaltyFn?: () => number;
  fallback: Gate;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

interface JevAnswer {
  type?: string;
  noul?: number;
}

export function buildJevState(input: GateInput): string {
  const recent = input.messages.slice(-10);
  const lines = recent
    .map((m) => {
      if (m.self) return `她（大肥魚）：${m.text}`;
      const to = m.to && m.to.length > 0 ? ` → ${m.to.join("、")}` : "";
      return `[${m.author}${to}]：${m.text}`;
    })
    .join("\n");
  const quiet = Math.max(0, Math.round((input.now - input.lastSpokeAt) / 60_000));

  // The strongest hint that a line without a name is for her: it came right
  // after she spoke, from someone she was just talking to.
  const last = recent[recent.length - 1];
  const before = recent[recent.length - 2];
  const followUp =
    last !== undefined &&
    before?.self === true &&
    last.self !== true &&
    (!last.to || last.to.length === 0 || last.to.includes("她"))
      ? `最後一則 [${last.author}] 緊接在她剛說完的話之後，很可能是在接她的話。`
      : "";

  return [
    "她是一隻叫「大肥魚」的藍色胖魚，有點傲嬌，最喜歡白飯。",
    "她在一個多人聊天的 Discord 頻道裡。她不是助理，只在意見有用、被點名、或話題剛好戳到她時才開口。",
    "",
    "判斷重點：",
    "- 如果最後一則是在叫她、問她、或對著整個房間說 → 她可以接。",
    "- 如果最後一則是在回她剛說的話（接在她後面、沒有叫別人）→ 她可以接。",
    "- [A → B] 表示那句是 A 對 B 說的；B 不是她時，她不要插話。",
    "- 如果兩個人在互相對話、內容跟魚無關 → 她不要插話。",
    "- 看不出來就當作不是在對她說。",
    "",
    "最近的訊息（舊到新）：",
    lines,
    ...(followUp ? ["", followUp] : []),
    "",
    `大家叫她的名字：${input.names.join("、")}`,
    `距離她上次開口：${quiet} 分鐘`,
  ].join("\n");
}
export class JevGate implements Gate {
  readonly name = "jev";
  readonly model: string;
  /** last probability returned by the model, for `--check` and tuning */
  lastProbability: number | null = null;
  /** last P(addressed to her), for `--check` and tuning */
  lastToMe: number | null = null;
  /** the bar the last probability was held against */
  lastThreshold: number | null = null;
  private opts: JevOptions;
  private baseUrl: string;
  private doFetch: typeof fetch;
  private thresholdFn: () => number;
  private toMeBonusFn: () => number;
  private notMePenaltyFn: () => number;

  constructor(opts: JevOptions) {
    this.opts = opts;
    this.model = opts.model ?? "jev-1.13-free";
    this.baseUrl = (opts.baseUrl ?? "https://opencode.ai/inference/systemone/v1").replace(/\/+$/, "");
    this.doFetch = opts.fetchImpl ?? fetch;
    this.thresholdFn = opts.thresholdFn ?? (() => opts.threshold ?? 0.55);
    this.toMeBonusFn = opts.toMeBonusFn ?? (() => 0);
    this.notMePenaltyFn = opts.notMePenaltyFn ?? (() => 0);
  }

  get threshold(): number {
    return this.thresholdFn();
  }

  async decide(input: GateInput): Promise<boolean> {
    const { signal, done } = withTimeout(this.opts.timeoutMs ?? 4000);

    try {
      const res = await this.doFetch(`${this.baseUrl}/systemone`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.opts.apiKey}`,
          "User-Agent": "fishd/0.1",
        },
        body: JSON.stringify({
          model: this.model,
          state: buildJevState(input),
          questions: {
            speak: {
              type: "noul",
              instructions: "她現在應該在最後一則訊息之後插話嗎？",
            },
            to_me: {
              type: "noul",
              instructions:
                "最後一則訊息是在對她說（叫她、問她、對整個房間說），還是在對另一個真人說？是在對她說才給高分。",
            },
          },
        }),
        signal,
      });

      if (!res.ok) throw new Error(`jev ${res.status}`);

      const data = (await res.json()) as { answers?: Record<string, JevAnswer> };
      const p = data.answers?.["speak"]?.noul;
      if (typeof p !== "number" || Number.isNaN(p)) throw new Error("jev: no answer");

      const toMe = data.answers?.["to_me"]?.noul;
      const addressed = typeof toMe === "number" && !Number.isNaN(toMe) ? toMe : 0;

      this.lastProbability = p;
      this.lastToMe = addressed;

      // Addressed -> lower the bar. Addressed to another human -> raise it.
      const factor = Math.max(
        0.25,
        1 + this.toMeBonusFn() * addressed - this.notMePenaltyFn() * (1 - addressed),
      );
      const threshold = (this.threshold * Math.max(1, input.bias ?? 1)) / factor;

      this.lastThreshold = threshold;
      return p >= threshold;
    } catch {
      this.lastProbability = null;
      this.lastToMe = null;
      this.lastThreshold = null;
      return this.opts.fallback.decide(input);
    } finally {
      done();
    }
  }
}

/* ------------------------------------------------------------------ */
/* Composition                                                        */
/* ------------------------------------------------------------------ */

function buildMainLlmGate(tail: Gate): { gate: Gate; label: string } | null {
  // Empty means "whatever the main provider uses", so switching provider
  // cannot leave a model id from the other catalog stranded here.
  const model = (process.env.GATE_MODEL ?? "").trim();
  let provider;
  try {
    provider = makeProvider();
  } catch {
    return null;
  }
  if (provider.name === "stub") return null;

  const gate = new LlmGate(
    {
      complete: async (prompt, signal) => {
        const r = await provider.chat({
          messages: [{ role: "user", content: prompt }],
          ...(model === "" ? {} : { model }),
          maxTokens: envNumber("GATE_MAX_TOKENS", 200, 1),
          temperature: 0,
          signal,
        });
        return r.text;
      },
      fallback: tail,
      timeoutMs: envNumber("GATE_TIMEOUT_MS", 8000, 1),
      maxPerMinute: envNumber("GATE_MAX_PER_MIN", 6, 1),
    },
    model === "" ? provider.name : model,
  );

  return { gate, label: `llm:${model === "" ? provider.name : model}` };
}

function buildOpenRouterChain(tail: Gate): { gate: Gate; label: string } | null {
  const base = (process.env.GATE_BASE_URL ?? "").trim();
  const key =
    (process.env.GATE_API_KEY ?? "").trim() || (process.env.OPENROUTER_API_KEY ?? "").trim();
  const models = splitList(process.env.GATE_MODELS).slice(0, 3);

  if (base === "" || key === "" || models.length === 0) return null;

  const provider = new OpenAICompatProvider({
    name: "gate",
    apiKey: key,
    baseUrl: base,
    model: models[0] as string,
    headers: { "X-Title": "fishd" },
  });

  let gate = tail;
  for (let i = models.length - 1; i >= 0; i--) {
    const model = models[i] as string;
    gate = new LlmGate(
      {
        complete: async (prompt, signal) => {
          const r = await provider.chat({
            messages: [{ role: "user", content: prompt }],
            model,
            maxTokens: envNumber("GATE_MAX_TOKENS", 200, 1),
            temperature: 0,
            signal,
          });
          return r.text;
        },
        fallback: gate,
        timeoutMs: envNumber("GATE_TIMEOUT_MS", 8000, 1),
        maxPerMinute: envNumber("GATE_MAX_PER_MIN", 6, 1),
      },
      model,
    );
  }

  return { gate, label: `openrouter:${models.join("|")}` };
}

export function buildJevGate(tail: Gate): { gate: Gate; label: string } | null {
  const key =
    (process.env.JEV_API_KEY ?? "").trim() ||
    (process.env.OPENCODE_API_KEY ?? "").trim() ||
    readAuthKey("opencode-go") ||
    readAuthKey("opencode");
  if (!key) return null;

  const model = process.env.JEV_MODEL ?? "jev-1.13-free";
  const gate = new JevGate({
    apiKey: key,
    model,
    thresholdFn: () => {
      const s = liveSettings();
      return scaledThreshold(s.jevThreshold, s.talk);
    },
    toMeBonusFn: () => liveSettings().jevToMeBonus,
    notMePenaltyFn: () => liveSettings().jevNotMePenalty,
    fallback: tail,
    timeoutMs: envNumber("JEV_TIMEOUT_MS", 4000, 1),
  });

  return { gate, label: `jev:${model}` };
}

/**
 * FISHD_GATE:
 *   heuristic  no model at all
 *   jev        System One probability, then heuristic
 *   llm        one chat model, then heuristic
 *   chain      jev -> openrouter models -> main provider -> heuristic
 *
 * Built bottom-up, so the last gate added is the first one tried.
 */
export function makeGate(): GateSelection {
  const mode = (process.env.FISHD_GATE ?? "heuristic").trim().toLowerCase();
  const heuristic = new HeuristicGate();
  const labels: string[] = [];
  let tail: Gate = heuristic;

  if (mode === "llm" || mode === "chain") {
    const main = buildMainLlmGate(tail);
    if (main) {
      tail = main.gate;
      labels.push(main.label);
    }

    const remote = buildOpenRouterChain(tail);
    if (remote) {
      tail = remote.gate;
      labels.push(remote.label);
    }
  }

  if (mode === "jev" || mode === "chain") {
    const jev = buildJevGate(tail);
    if (jev) {
      tail = jev.gate;
      labels.push(jev.label);
    }
  }

  if (labels.length === 0) return { gate: heuristic, label: "heuristic" };
  return { gate: tail, label: [...labels].reverse().concat("heuristic").join(" → ") };
}
