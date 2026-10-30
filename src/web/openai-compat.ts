import type { Usage } from "../types.ts";

export const FISHD_MODEL_ID = "fishd-whale";

interface WireMessage {
  role?: unknown;
  content?: unknown;
}

/** OpenAI clients put the human text in the last `user` message. */
export function extractUserText(messages: unknown): string {
  if (!Array.isArray(messages)) return "";

  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i] as WireMessage | null;
    if (!message || typeof message !== "object" || message.role !== "user") continue;

    const content = message.content;
    if (typeof content === "string") return content.trim();
    if (!Array.isArray(content)) continue;

    const text = content
      .map((part) => {
        if (typeof part === "string") return part;
        if (part && typeof part === "object" && typeof (part as { text?: unknown }).text === "string") {
          return (part as { text: string }).text;
        }
        return "";
      })
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text !== "") return text;
  }
  return "";
}

export function modelsPayload(created = Math.floor(Date.now() / 1000)) {
  return {
    object: "list",
    data: [
      {
        id: FISHD_MODEL_ID,
        object: "model",
        created,
        owned_by: "fishd",
      },
    ],
  };
}

export function completionPayload(args: {
  id: string;
  model: string;
  content: string;
  usage?: Usage;
}) {
  return {
    id: args.id,
    object: "chat.completion",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content: args.content },
        finish_reason: "stop",
      },
    ],
    usage: {
      prompt_tokens: args.usage?.promptTokens ?? 0,
      completion_tokens: args.usage?.completionTokens ?? 0,
      total_tokens:
        (args.usage?.promptTokens ?? 0) + (args.usage?.completionTokens ?? 0),
    },
  };
}

export function chunkPayload(args: {
  id: string;
  model: string;
  delta: { role?: string; content?: string };
  finish?: string | null;
}) {
  return {
    id: args.id,
    object: "chat.completion.chunk",
    created: Math.floor(Date.now() / 1000),
    model: args.model,
    choices: [
      {
        index: 0,
        delta: args.delta,
        finish_reason: args.finish ?? null,
      },
    ],
  };
}

/** Split a finished reply into small SSE deltas so the client can paint early. */
export function contentChunks(text: string, size = 24): string[] {
  const chars = [...text];
  const out: string[] = [];
  for (let i = 0; i < chars.length; i += size) {
    out.push(chars.slice(i, i + size).join(""));
  }
  return out;
}

export function sse(payload: unknown): string {
  return `data: ${JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = "data: [DONE]\n\n";
