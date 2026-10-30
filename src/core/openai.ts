import type { ChatRequest, ChatResult, Msg, Provider, ToolCall, Usage } from "../types.ts";
import { estimateTokens } from "./budget.ts";

export interface OpenAIOptions {
  apiKey: string;
  /** e.g. https://api.deepseek.com or https://opencode.ai/inference/go/openai/v1 */
  baseUrl: string;
  model: string;
  name?: string;
  headers?: Record<string, string>;
  /**
   * "auto" sends nothing and lets the server decide (DeepSeek enables thinking
   * by default). Only providers known to accept the field are given a value.
   */
  thinking?: "auto" | "enabled" | "disabled";
  /** low | high | max — DeepSeek maps medium/xhigh/ultra itself */
  reasoningEffort?: string;
  /** per-attempt timeout in ms; default FISHD_TIMEOUT_MS or 60000 */
  timeoutMs?: number;
  /**
   * retries after the first attempt on a connection error raised before any
   * response, 429 and 5xx (default 2). Timeouts and aborts are never retried.
   */
  retries?: number;
  /** first backoff in ms, doubled per retry; Retry-After overrides it; each wait capped at 10s (default 500) */
  backoffMs?: number;
  /** wall-clock cap for one chat() call across all attempts; default FISHD_CALL_BUDGET_MS or 90000 */
  callBudgetMs?: number;
  /** injectable for tests */
  fetch?: FetchLike;
  sleep?: (ms: number) => Promise<void>;
}

export type FetchLike = (url: string, init: RequestInit) => Promise<Response>;

interface UsageShape {
  prompt_tokens?: number;
  completion_tokens?: number;
  prompt_cache_hit_tokens?: number;
  prompt_cache_miss_tokens?: number;
  prompt_tokens_details?: { cached_tokens?: number };
}

function promptTokensOf(messages: Msg[]): number {
  return messages.reduce((n, m) => n + estimateTokens(m.content), 0);
}

function toWire(msg: Msg): Record<string, unknown> {
  const wire: Record<string, unknown> = { role: msg.role, content: msg.content };
  if (msg.toolCalls && msg.toolCalls.length > 0) {
    wire["tool_calls"] = msg.toolCalls.map((call) => ({
      id: call.id,
      type: "function",
      function: { name: call.name, arguments: call.arguments },
    }));
  }
  if (msg.toolCallId) wire["tool_call_id"] = msg.toolCallId;
  // DeepSeek: with `tools` in the request, prior reasoning must come back
  // verbatim or the API rejects the whole round.
  if (msg.reasoning && msg.role === "assistant") wire["reasoning_content"] = msg.reasoning;
  return wire;
}

interface WireToolCall {
  id?: unknown;
  function?: { name?: unknown; arguments?: unknown };
}

function parseToolCalls(raw: unknown): ToolCall[] {
  if (!Array.isArray(raw)) return [];
  const calls: ToolCall[] = [];
  for (const item of raw as WireToolCall[]) {
    const name = typeof item?.function?.name === "string" ? item.function.name : "";
    if (name === "") continue;
    calls.push({
      id: typeof item.id === "string" ? item.id : `call-${calls.length}`,
      name,
      arguments:
        typeof item.function?.arguments === "string" ? item.function.arguments : "{}",
    });
  }
  return calls;
}

const DEFAULT_TIMEOUT_MS = 60_000;
const DEFAULT_CALL_BUDGET_MS = 90_000;
const MAX_RETRY_WAIT_MS = 10_000;

export function timeoutFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["FISHD_TIMEOUT_MS"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_TIMEOUT_MS;
}

export function callBudgetFromEnv(env: Record<string, string | undefined> = process.env): number {
  const n = Number(env["FISHD_CALL_BUDGET_MS"]);
  return Number.isFinite(n) && n > 0 ? n : DEFAULT_CALL_BUDGET_MS;
}

function isTimeoutOrAbort(err: unknown): boolean {
  const name = (err as { name?: unknown } | null)?.name;
  return name === "TimeoutError" || name === "AbortError";
}

function retryAfterMs(res: Response): number | undefined {
  const raw = res.headers.get("retry-after");
  if (!raw) return undefined;
  const secs = Number(raw);
  if (Number.isFinite(secs)) return Math.max(0, secs * 1000);
  const at = Date.parse(raw);
  return Number.isNaN(at) ? undefined : Math.max(0, at - Date.now());
}

function retryableStatus(status: number): boolean {
  return status === 429 || status >= 500;
}

/**
 * Any OpenAI-compatible chat completions endpoint: DeepSeek, OpenCode Go,
 * OpenRouter, vLLM, llama.cpp. One implementation, no SDK.
 */
export class OpenAICompatProvider implements Provider {
  readonly name: string;
  private apiKey: string;
  private baseUrl: string;
  private defaultModel: string;
  private extraHeaders: Record<string, string>;
  private thinking: "auto" | "enabled" | "disabled";
  private reasoningEffort: string;
  private fetchImpl: FetchLike;
  private timeoutMs: number;
  private retries: number;
  private backoffMs: number;
  private callBudgetMs: number;
  private sleepImpl: (ms: number) => Promise<void>;

  constructor(opts: OpenAIOptions) {
    this.name = opts.name ?? "openai-compatible";
    this.apiKey = opts.apiKey;
    this.baseUrl = opts.baseUrl.replace(/\/+$/, "");
    this.defaultModel = opts.model;
    this.extraHeaders = opts.headers ?? {};
    this.thinking = opts.thinking ?? "auto";
    this.reasoningEffort = (opts.reasoningEffort ?? "").trim().toLowerCase();
    this.fetchImpl = opts.fetch ?? ((url, init) => fetch(url, init));
    this.timeoutMs = opts.timeoutMs ?? timeoutFromEnv();
    this.retries = Math.max(0, opts.retries ?? 2);
    this.backoffMs = opts.backoffMs ?? 500;
    this.callBudgetMs = opts.callBudgetMs ?? callBudgetFromEnv();
    this.sleepImpl = opts.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
  }

  private delayFor(attempt: number): number {
    return Math.min(this.backoffMs * 2 ** attempt, MAX_RETRY_WAIT_MS);
  }

  private fitsBudget(wait: number, deadline: number): boolean {
    return Date.now() + wait < deadline;
  }

  /**
   * POST with a per-attempt timeout, all attempts sharing one wall-clock deadline.
   * Only connection errors raised before any response, 429 and 5xx are retried,
   * with exponential backoff (Retry-After wins when present, capped at 10s).
   * Timeouts and aborts are never retried. The caller's abort is checked before
   * every backoff sleep, so an aborted call returns without waiting.
   */
  private async send(
    url: string,
    init: RequestInit,
    outer: AbortSignal | undefined,
    deadline: number,
  ): Promise<Response> {
    for (let attempt = 0; ; attempt++) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new Error(`${this.name}: call budget exhausted`);
      const timeout = AbortSignal.timeout(Math.min(this.timeoutMs, remaining));
      const signal = outer ? AbortSignal.any([outer, timeout]) : timeout;

      let res: Response;
      try {
        res = await this.fetchImpl(url, { ...init, signal });
      } catch (err) {
        if (isTimeoutOrAbort(err) || outer?.aborted || attempt >= this.retries) throw err;
        const wait = this.delayFor(attempt);
        if (!this.fitsBudget(wait, deadline)) throw err;
        await this.sleepImpl(wait);
        continue;
      }

      if (res.ok || !retryableStatus(res.status) || attempt >= this.retries) return res;
      const wait = Math.min(retryAfterMs(res) ?? this.delayFor(attempt), MAX_RETRY_WAIT_MS);
      if (outer?.aborted) throw outer.reason;
      if (!this.fitsBudget(wait, deadline)) return res; // chat() reports the status
      await res.text().catch(() => "");
      if (outer?.aborted) throw outer.reason;
      await this.sleepImpl(wait);
    }
  }

  async chat(req: ChatRequest): Promise<ChatResult> {
    const model = req.model ?? this.defaultModel;

    const res = await this.send(`${this.baseUrl}/chat/completions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${this.apiKey}`,
        "User-Agent": "fishd/0.1",
        ...this.extraHeaders,
      },
      body: JSON.stringify({
        model,
        messages: req.messages.map(toWire),
        ...(req.tools && req.tools.length > 0
          ? {
              tools: req.tools.map((tool) => ({
                type: "function",
                function: {
                  name: tool.name,
                  description: tool.description,
                  parameters: tool.parameters,
                },
              })),
            }
          : {}),
        temperature: req.temperature ?? 1.0,
        max_tokens: req.maxTokens ?? 400,
        ...(this.thinking === "auto" ? {} : { thinking: { type: this.thinking } }),
        ...(this.reasoningEffort === "" || this.reasoningEffort === "auto"
          ? {}
          : { reasoning_effort: this.reasoningEffort }),
        stream: false,
      }),
    }, req.signal, Date.now() + this.callBudgetMs);

    if (!res.ok) {
      const body = (await res.text()).slice(0, 400);
      throw new Error(`${this.name} ${res.status}: ${body}`);
    }

    const data = (await res.json()) as {
      choices?: Array<{
        message?: { content?: string; reasoning_content?: string; tool_calls?: unknown };
        finish_reason?: string;
      }>;
      usage?: UsageShape;
    };

    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const toolCalls = parseToolCalls(choice?.message?.tool_calls);
    const reasoning = choice?.message?.reasoning_content ?? "";

    if (text.trim() === "" && toolCalls.length === 0) {
      const finish = choice?.finish_reason ?? "unknown";
      throw new Error(
        `${this.name}/${model}: empty reply (finish=${finish}). ` +
          `Reasoning models spend the budget thinking before answering — raise max_tokens or pick a non-reasoning model.`,
      );
    }
    const u = data.usage ?? {};
    const promptTokens = u.prompt_tokens ?? promptTokensOf(req.messages);
    const reported = u.prompt_cache_hit_tokens ?? u.prompt_tokens_details?.cached_tokens ?? 0;
    const hit = Math.max(0, Math.min(reported, promptTokens));
    const miss = u.prompt_cache_miss_tokens ?? Math.max(0, promptTokens - hit);

    const usage: Usage = {
      promptTokens,
      completionTokens: u.completion_tokens ?? estimateTokens(text),
      cacheHitTokens: hit,
      cacheMissTokens: miss,
    };

    return {
      text,
      usage,
      model,
      toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
      reasoning: reasoning === "" ? undefined : reasoning,
    };
  }
}
