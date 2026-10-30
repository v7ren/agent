import { createServer } from "node:http";
import type { IncomingMessage, ServerResponse } from "node:http";
import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, relative, resolve, sep } from "node:path";
import type { Agent } from "../core/loop.ts";
import { journalPath, readDoc } from "../memory/vault.ts";
import { envMap, parseEnv, upsertEnv } from "./envfile.ts";
import { FIELDS, GROUPS, fieldOf } from "./config-schema.ts";
import { applyEnvUpdate, defaultEnvPath, restartNeeded } from "../settings-write.ts";
import { listModels, resolveModelSource } from "../core/models.ts";
import { listPacks } from "../persona/packs.ts";
import {
  chunkPayload,
  completionPayload,
  contentChunks,
  extractUserText,
  FISHD_MODEL_ID,
  modelsPayload,
  sse,
  SSE_DONE,
} from "./openai-compat.ts";

const PUBLIC = fileURLToPath(new URL("./public/", import.meta.url));
const MAX_BODY = 512 * 1024;

const MODELS_TTL = 10 * 60 * 1000;
const modelsCache = new Map<string, { at: number; models: string[] }>();

const ASSETS: Record<string, string> = {
  "/": "index.html",
  "/app.css": "app.css",
  "/app.js": "app.js",
};

const TYPES: Record<string, string> = {
  html: "text/html; charset=utf-8",
  css: "text/css; charset=utf-8",
  js: "text/javascript; charset=utf-8",
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  mp4: "video/mp4",
  webm: "video/webm",
  mov: "video/quicktime",
};

function sendJson(res: ServerResponse, code: number, body: unknown): void {
  const json = JSON.stringify(body);
  res.writeHead(code, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "content-length": Buffer.byteLength(json),
  });
  res.end(json);
}

function sendOpenAiError(res: ServerResponse, code: number, message: string): void {
  sendJson(res, code, {
    error: { message, type: "fishd_error", code: String(code) },
  });
}

function shareJson(
  share: { name: string; kind: string } | null,
): { name: string; kind: string; url: string } | null {
  if (!share) return null;
  return {
    name: share.name,
    kind: share.kind,
    url: `/api/share/${encodeURIComponent(share.name)}`,
  };
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = Buffer.from(chunk as Uint8Array);
    size += buf.length;
    if (size > MAX_BODY) throw new Error("body too large");
    chunks.push(buf);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function journalTail(root: string, lines = 40): string[] {
  const abs = journalPath(root, new Date());
  if (!existsSync(abs)) return [];
  const rel = relative(resolve(root), abs).replace(/\\/g, "/");
  try {
    const text = readDoc(root, rel);
    return text
      .split(/\r?\n/)
      .filter((l) => l.startsWith("- "))
      .slice(-lines);
  } catch {
    return [];
  }
}

export interface WebOptions {
  vaultRoot: string;
  personaDir: string;
  /** folder the share tool picks from; also served read-only */
  shareDir?: string;
  port?: number;
  host?: string;
}

function readEnvFile(): string {
  const p = defaultEnvPath();
  if (existsSync(p)) return readFileSync(p, "utf8");
  const example = join(process.cwd(), ".env.example");
  if (existsSync(example)) return readFileSync(example, "utf8");
  return "";
}

/** Host header must be exactly 127.0.0.1 or localhost on our port (blocks DNS rebinding). */
export function hostOk(hostHeader: string | undefined, port: number): boolean {
  if (!hostHeader) return false;
  const h = hostHeader.toLowerCase();
  return h === `127.0.0.1:${port}` || h === `localhost:${port}`;
}

/** Origin must be the page's own origin: http://<the validated Host>. Missing or "null" fails. */
export function sameOrigin(origin: string | undefined, hostHeader: string | undefined, port: number): boolean {
  if (!origin || !hostOk(hostHeader, port)) return false;
  return origin.toLowerCase() === `http://${hostHeader?.toLowerCase()}`;
}

/** Only keys the config form knows about may be written to .env. */
export function keyAllowed(key: string): boolean {
  return fieldOf(key) !== undefined;
}

function looksSecret(key: string): boolean {
  return /KEY|TOKEN|SECRET|PASSWORD/i.test(key);
}

export function startWeb(agent: Agent, opts: WebOptions): Promise<{ port: number; close: () => Promise<void> }> {
  const port = opts.port ?? 7777;
  const host = opts.host ?? "127.0.0.1";
  let listenPort = port;
  let inFlight = false;

  const stats = () => {
    const s = agent.cacheStat;
    const total = s.hitTokens + s.missTokens;
    return {
      turns: agent.turns,
      hitRate: total === 0 ? 0 : s.hitTokens / total,
      cost: s.costUsd,
      saved: Math.max(0, s.naiveCostUsd - s.costUsd),
      prefix: agent.personalityHash,
      promptTokens: s.promptTokens,
    };
  };

  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", `http://${host}`);

    try {
      // Every route: Host must be ours (DNS rebinding). Every POST: Origin must be ours.
      if (!hostOk(req.headers.host, listenPort)) {
        sendJson(res, 403, { error: "host not allowed" });
        return;
      }
      // Local OpenAI-compatible clients (dsh-pet, CLI tools) send no Origin.
      // They still have to match the Host check above.
      const isOpenAiRoute = url.pathname.startsWith("/v1/");
      if (
        req.method === "POST" &&
        !isOpenAiRoute &&
        !sameOrigin(req.headers.origin, req.headers.host, listenPort)
      ) {
        sendJson(res, 403, { error: "origin not allowed" });
        return;
      }

      if (req.method === "GET" && ASSETS[url.pathname]) {
        const file = join(PUBLIC, ASSETS[url.pathname] as string);
        const body = readFileSync(file);
        const ext = file.slice(file.lastIndexOf(".") + 1);
        res.writeHead(200, {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(body);
        return;
      }

      if (req.method === "GET" && url.pathname.startsWith("/api/share/")) {
        const name = decodeURIComponent(url.pathname.slice("/api/share/".length));
        const root = opts.shareDir;
        if (!root) {
          sendJson(res, 404, { error: "沒有分享夾" });
          return;
        }
        const base = resolve(root);
        const abs = resolve(base, name);
        if (!abs.startsWith(base + sep) || !existsSync(abs)) {
          sendJson(res, 404, { error: "找不到" });
          return;
        }
        const ext = abs.slice(abs.lastIndexOf(".") + 1).toLowerCase();
        res.writeHead(200, {
          "content-type": TYPES[ext] ?? "application/octet-stream",
          "cache-control": "no-store",
        });
        res.end(readFileSync(abs));
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/state") {
        sendJson(res, 200, {
          transcript: agent.transcript,
          mood: agent.moodState,
          stats: stats(),
          journal: journalTail(opts.vaultRoot, 8),
        });
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/models") {
        const providerParam = url.searchParams.get("provider") ?? "";
        const source = resolveModelSource(providerParam === "" ? undefined : providerParam);

        if (!source) {
          sendJson(res, 200, { provider: null, models: [], error: "no key configured" });
          return;
        }

        const cacheKey = `${source.provider}:${source.modelsUrl}`;
        const cached = modelsCache.get(cacheKey);
        if (cached && Date.now() - cached.at < MODELS_TTL) {
          sendJson(res, 200, { provider: source.provider, models: cached.models, cached: true });
          return;
        }

        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(), 8000);
        try {
          const models = await listModels(source, controller.signal);
          modelsCache.set(cacheKey, { at: Date.now(), models });
          sendJson(res, 200, { provider: source.provider, models });
        } catch (err) {
          console.error("[web] model list failed:", err);
          sendJson(res, 200, {
            provider: source.provider,
            models: [],
            error: "無法取得模型清單",
          });
        } finally {
          clearTimeout(timer);
        }
        return;
      }

      if (req.method === "GET" && url.pathname === "/api/config") {
        const map = envMap(readEnvFile());
        const values: Record<string, { value: string; isSet: boolean }> = {};

        for (const field of FIELDS) {
          const raw = map[field.key] ?? "";
          values[field.key] = {
            value: field.secret ? "" : raw !== "" ? raw : (field.defaultValue ?? ""),
            isSet: raw !== "",
          };
        }

        const known = new Set(FIELDS.map((f) => f.key));
        const extra = parseEnv(readEnvFile())
          .filter((e) => !known.has(e.key))
          .map((e) => ({
            key: e.key,
            value: looksSecret(e.key) ? "" : e.value,
            secret: looksSecret(e.key),
          }));

        const packs = listPacks(opts.personaDir);
        const fields = FIELDS.map((field) =>
          field.key === "FISHD_PACK" ? { ...field, options: ["", ...packs] } : field,
        );

        sendJson(res, 200, { groups: GROUPS, fields, values, extra, packs });
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/config") {
        const raw = await readBody(req);
        let parsed: unknown;
        try {
          parsed = JSON.parse(raw);
        } catch {
          sendJson(res, 400, { error: "看不懂這個請求。" });
          return;
        }

        const body = (parsed ?? {}) as { values?: unknown; clear?: unknown };
        const incoming =
          body.values && typeof body.values === "object" && !Array.isArray(body.values)
            ? (body.values as Record<string, unknown>)
            : {};
        const clearIn = body.clear === undefined ? [] : body.clear;
        if (!Array.isArray(clearIn)) {
          sendJson(res, 400, { error: "看不懂這個請求。" });
          return;
        }

        // Reject the whole request if any key is unknown or any value is not text.
        const values: Record<string, string> = {};
        for (const [key, value] of Object.entries(incoming)) {
          if (!keyAllowed(key) || typeof value !== "string") {
            sendJson(res, 400, { error: "不允許修改這個設定。" });
            return;
          }
          values[key] = value.replace(/[\r\n]+/g, " ").slice(0, 4000);
        }
        const clear: string[] = [];
        for (const key of clearIn) {
          if (typeof key !== "string" || !keyAllowed(key)) {
            sendJson(res, 400, { error: "不允許修改這個設定。" });
            return;
          }
          clear.push(key);
        }

        applyEnvUpdate(values, clear);

        const changed = Object.keys(values);
        sendJson(res, 200, {
          ok: true,
          changed,
          cleared: clear,
          restartRequired: restartNeeded([...changed, ...clear]),
        });
        return;
      }

      // ---- OpenAI-compatible surface, for dsh-pet and other chat UIs ----
      if (req.method === "GET" && url.pathname === "/v1/models") {
        sendJson(res, 200, modelsPayload());
        return;
      }

      if (req.method === "POST" && url.pathname === "/v1/chat/completions") {
        if (inFlight) {
          sendOpenAiError(res, 429, "她還在想上一句。");
          return;
        }
        inFlight = true;
        try {
          const raw = await readBody(req);
          let body: unknown;
          try {
            body = JSON.parse(raw);
          } catch {
            sendOpenAiError(res, 400, "看不懂這個請求。");
            return;
          }

          const request = (body ?? {}) as {
            messages?: unknown;
            stream?: unknown;
            model?: unknown;
            max_tokens?: unknown;
          };
          const text = extractUserText(request.messages);
          if (text === "") {
            sendOpenAiError(res, 400, "messages 裡沒有 user 訊息。");
            return;
          }

          const wantStream = request.stream === true;
          const id = `chatcmpl-${randomUUID()}`;
          const model =
            typeof request.model === "string" && request.model !== ""
              ? request.model
              : FISHD_MODEL_ID;

          // The pet's "test connection" sends ping with max_tokens=1. Do not
          // spend a real model turn just to answer it.
          if (text === "ping" && Number(request.max_tokens ?? 0) <= 1) {
            sendJson(res, 200, completionPayload({ id, model, content: "pong" }));
            return;
          }

          // The only OpenAI client here is the local desktop pet: treat it as
          // the owner, but keep it out of the Discord person graph.
          const r = await agent.turn(text, { owner: true, where: "桌寵" });
          let content = r.segments.filter((s) => s.trim() !== "").join("\n");
          if (r.kaomoji) content = `${content} ${r.kaomoji}`;
          if (r.share) {
            const origin = `http://${req.headers.host ?? `${host}:${port}`}`;
            content += `\n\n![${r.share.name}](${origin}/api/share/${encodeURIComponent(r.share.name)})`;
          }

          if (!wantStream) {
            sendJson(res, 200, completionPayload({ id, model, content, usage: r.usage }));
            return;
          }

          res.writeHead(200, {
            "content-type": "text/event-stream; charset=utf-8",
            "cache-control": "no-cache",
            connection: "keep-alive",
          });
          res.write(sse(chunkPayload({ id, model, delta: { role: "assistant" } })));
          for (const piece of contentChunks(content)) {
            res.write(sse(chunkPayload({ id, model, delta: { content: piece } })));
          }
          res.write(sse(chunkPayload({ id, model, delta: {}, finish: "stop" })));
          res.write(SSE_DONE);
          res.end();
        } catch (err) {
          const message = err instanceof Error ? err.message : "unknown error";
          if (!res.headersSent) sendOpenAiError(res, 500, message);
          else res.end();
        } finally {
          inFlight = false;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/turn") {
        if (inFlight) {
          sendJson(res, 409, { error: "她還在想上一句。" });
          return;
        }
        inFlight = true;
        try {
          const raw = await readBody(req);
          let text = "";
          try {
            const parsed = JSON.parse(raw) as { text?: unknown };
            text = typeof parsed.text === "string" ? parsed.text.trim() : "";
          } catch {
            sendJson(res, 400, { error: "看不懂這個請求。" });
            return;
          }
          if (text === "") {
            sendJson(res, 400, { error: "沒有話要說。" });
            return;
          }

          const r = await agent.turn(text);
          sendJson(res, 200, {
            segments: r.segments,
            kaomoji: r.kaomoji,
            react: r.react,
            whisper: r.whisper,
            share: shareJson(r.share),
            voice: r.voice,
            tone: r.tone,
            mood: r.mood,
            memory: r.memory,
            nudgeLog: r.nudgeLog ?? null,
            stats: stats(),
          });
        } finally {
          inFlight = false;
        }
        return;
      }

      if (req.method === "POST" && url.pathname === "/api/spontaneous") {
        if (inFlight) {
          sendJson(res, 409, { error: "她還在想上一句。" });
          return;
        }
        inFlight = true;
        try {
          const r = await agent.turn("", { spontaneous: true, gapHours: 4 });
          sendJson(res, 200, {
            segments: r.segments,
            kaomoji: r.kaomoji,
            react: r.react,
            whisper: r.whisper,
            share: shareJson(r.share),
            voice: r.voice,
            tone: r.tone,
            mood: r.mood,
            memory: r.memory,
            nudgeLog: r.nudgeLog ?? null,
            stats: stats(),
          });
        } finally {
          inFlight = false;
        }
        return;
      }

      sendJson(res, 404, { error: "not found" });
    } catch (err) {
      console.error("[web] request failed:", err);
      if (!res.headersSent) sendJson(res, 500, { error: "伺服器出了點問題。" });
      else res.end();
    }
  });

  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, () => {
      const addr = server.address();
      const actual = typeof addr === "object" && addr ? addr.port : port;
      listenPort = actual;
      resolve({
        port: actual,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
          }),
      });
    });
  });
}

