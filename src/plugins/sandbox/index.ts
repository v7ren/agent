/**
 * Sandbox plugin for fish.
 *
 * This adds a small Linux computer (Puppet Master's Potato Bot sandbox) as
 * tools, without touching the agent loop, memory, persona or the vault:
 *
 *   src/bin.ts:  const drives = sandboxDrives(CONFIG.stateDir);
 *
 * fish already lets a `DriveKit` contribute tools (`drives.tools()`), own them
 * (`drives.owns()`) and run them (`drives.run()`). This file subclasses it, so
 * the loop needs no change and the tools stay owner-only like the other
 * drive tools.
 *
 * fish's tool loop is synchronous, so each call starts bridge.mjs with a JSON
 * request on stdin and reads one JSON answer. All async work (HTTP, wsl.exe,
 * the priority gate) lives there.
 *
 * Off unless FISHD_SANDBOX=1. With it off, sandboxDrives() returns an ordinary
 * DriveKit and nothing about fish changes.
 */

import { execFileSync, spawn } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { DriveKit } from "../../persona/drives.ts";
import type { DriveKitOptions } from "../../persona/drives.ts";
import type { ToolSpec } from "../../types.ts";

const BRIDGE = join(dirname(fileURLToPath(import.meta.url)), "bridge.mjs");
const NAMES = new Set(["sandbox_status", "computer_observe", "computer_act"]);
const TIMEOUT_MS = Number(process.env.FISHD_SANDBOX_TIMEOUT_MS ?? 15_000) + 3_000;

const SANDBOX_TOOLS: ToolSpec[] = [
  {
    name: "sandbox_status",
    description:
      "Check whether you have the small Linux computer right now, before using it. Say the plain answer to the person: available, in use by Puppet Master, asleep, starting, or not set up. Read this before computer_observe or computer_act.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "computer_observe",
    description:
      "Look at the computer's screen: its size, where the pointer is, the front window, and whether the screen changed since your last look. This is a read and is allowed even while Puppet Master uses the computer. You cannot see pictures, so for a web page use browser tools instead.",
    parameters: { type: "object", properties: {}, additionalProperties: false },
  },
  {
    name: "computer_act",
    description:
      "Do up to 24 actions on the computer's screen: move, click, double_click, drag, scroll, type, key, wait, launch (chrome, terminal, files, editor). Coordinates are in screen pixels. The screen is shared with Puppet Master, who has priority: if the computer is in use, the call is refused and you should wait and try again. Look with computer_observe before acting when you are unsure.",
    parameters: {
      type: "object",
      properties: {
        actions: {
          type: "array",
          minItems: 1,
          maxItems: 24,
          items: {
            type: "object",
            properties: {
              kind: {
                type: "string",
                enum: [
                  "move",
                  "click",
                  "double_click",
                  "drag",
                  "scroll",
                  "type",
                  "key",
                  "wait",
                  "launch",
                ],
              },
              x: { type: "number", description: "screen x" },
              y: { type: "number", description: "screen y" },
              to_x: { type: "number", description: "drag: where to let go" },
              to_y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              direction: { type: "string", enum: ["up", "down", "left", "right"] },
              amount: { type: "number", description: "scroll: 1-20" },
              text: { type: "string", description: "type: what to type (2000 chars at most)" },
              key: { type: "string", description: "key: a combo such as Return or ctrl+s" },
              ms: { type: "number", description: "wait: milliseconds, 0-5000" },
              app: { type: "string", description: "launch: chrome, terminal, files or editor" },
              arg: { type: "string", description: "launch: optional address to open" },
            },
            required: ["kind"],
            additionalProperties: false,
          },
        },
      },
      required: ["actions"],
      additionalProperties: false,
    },
  },
];

interface BridgeReply {
  ok?: boolean;
  text?: string;
  error?: { code?: string; message?: string };
}

const OPS: Record<string, string> = {
  sandbox_status: "status",
  computer_observe: "observe",
  computer_act: "act",
};

function callBridge(tool: string, args: Record<string, unknown>, stateDir: string): string {
  const request = JSON.stringify({ op: OPS[tool] ?? tool, args });
  try {
    const out = execFileSync(process.execPath, [BRIDGE], {
      input: request,
      encoding: "utf8",
      timeout: TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        ...process.env,
        FISHD_SANDBOX: "1",
        FISHD_SANDBOX_STATE_DIR: join(stateDir, "plugins", "sandbox"),
      },
    });
    const reply = JSON.parse(out) as BridgeReply;
    if (reply.ok === true && typeof reply.text === "string") return reply.text;
    const code = reply.error?.code ?? "SANDBOX_FAILED";
    const message = reply.error?.message ?? "The computer did not answer.";
    return `Computer error (${code}): ${message}`;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return `Computer error: could not reach the sandbox (${message.slice(0, 160)}).`;
  }
}

class SandboxDriveKit extends DriveKit {
  private readonly stateDir: string;

  constructor(opts: DriveKitOptions) {
    super(opts);
    this.stateDir = opts.dir;
  }

  override tools(): ToolSpec[] {
    return [...super.tools(), ...SANDBOX_TOOLS];
  }

  override owns(name: string): boolean {
    return NAMES.has(name) || super.owns(name);
  }

  override run(name: string, args: Record<string, unknown>, now: Date): string {
    if (NAMES.has(name)) return callBridge(name, args, this.stateDir);
    return super.run(name, args, now);
  }
}

/**
 * The one line fish's composition root needs. Off: an ordinary DriveKit.
 * On: the same DriveKit plus the sandbox tools.
 */
export function sandboxDrives(dir: string): DriveKit {
  if ((process.env.FISHD_SANDBOX ?? "").trim() !== "1") return new DriveKit({ dir });
  return new SandboxDriveKit({ dir });
}

/**
 * Starts the one background watcher that keeps the sandbox awake while a
 * long-running fish (npm run bot / npm run web) is up. The watcher stops
 * itself when this process is gone, and never terminates the sandbox.
 *
 * FISHD_SANDBOX_KEEPALIVE=0 turns it off.
 */
export function startSandboxWatch(dir: string): void {
  if ((process.env.FISHD_SANDBOX ?? "").trim() !== "1") return;
  if ((process.env.FISHD_SANDBOX_KEEPALIVE ?? "1").trim() === "0") return;
  try {
    const child = spawn(process.execPath, [BRIDGE, "--watch"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
      env: {
        ...process.env,
        FISHD_WATCH_PARENT_PID: String(process.pid),
        FISHD_SANDBOX_STATE_DIR: join(dir, "plugins", "sandbox"),
      },
    });
    child.unref();
  } catch {
    /* the tools still work; only the keep-awake is missing */
  }
}
