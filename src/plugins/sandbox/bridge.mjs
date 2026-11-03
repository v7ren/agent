#!/usr/bin/env node
/**
 * The async half of the fish sandbox plugin.
 *
 * fish's tool loop is synchronous, so index.ts starts this program once per
 * tool call with a JSON request on stdin and reads one JSON answer on stdout.
 * Nothing here writes to stdout except that answer.
 *
 * It speaks the same wire as Puppet Master's own client:
 *   POST http://127.0.0.1:<port>/v1/screenshot   {"display": ":99"}
 *   POST http://127.0.0.1:<port>/v1/desktop      {"display", "steps", "settleMs", "observe"}
 *   Authorization: Bearer <token from /run/pm-sbx/control.token>
 *
 * The sandbox is shared with Potato Bot, so Puppet Master has priority:
 *   - reads are allowed at any time;
 *   - actions are refused while PM has used the sandbox recently.
 */

import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

const DISTRO = env("FISHD_SANDBOX_DISTRO", "pm-sbx-main").trim() || "pm-sbx-main";
const PORT = number(env("FISHD_SANDBOX_CONTROL_PORT", "47801"), 47801);
const DISPLAY = env("FISHD_SANDBOX_DISPLAY", ":99").trim() || ":99";
const STATE_DIR = env("FISHD_SANDBOX_STATE_DIR", join(process.cwd(), "vault", "state", "plugins", "sandbox"));
const PM_BUSY_MS = number(env("FISHD_SANDBOX_PM_BUSY_MS", "90000"), 90_000);
const ACTIONS_PER_DAY = number(env("FISHD_SANDBOX_ACTIONS_PER_DAY", "500"), 500);
const CALL_TIMEOUT_MS = number(env("FISHD_SANDBOX_TIMEOUT_MS", "15000"), 15_000);
const WATCH_MS = number(env("FISHD_SANDBOX_WATCH_MS", "20000"), 20_000);
const WATCH_PARENT_PID = number(env("FISHD_WATCH_PARENT_PID", "0"), 0);

const PM_TOKEN = "/run/pm-sbx/control.token";
const SELF_TOKEN = "/home/pm/.pm-sbx/control.token";
const MAX_ACTIONS = 24;
const MAX_STEPS = 64;
const MAX_TEXT = 2000;
const MAX_COORD = 16_384;
const MAX_WAIT_MS = 5000;
const PM_ENV = [
  "/usr/bin/env",
  "-u",
  "WAYLAND_DISPLAY",
  "-u",
  "PULSE_SERVER",
  "-u",
  "XDG_SESSION_TYPE",
  `DISPLAY=${DISPLAY}`,
  "XDG_RUNTIME_DIR=/tmp/pm-runtime",
];

class SandboxError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

function env(name, fallback) {
  const value = process.env[name];
  return value === undefined || value === "" ? fallback : value;
}

function number(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function localDay(now = new Date()) {
  const pad = (n) => String(n).padStart(2, "0");
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

function statePath() {
  return join(STATE_DIR, "state.json");
}

function loadState() {
  const blank = { v: 1, day: localDay(), actions: 0, frame: null };
  try {
    const parsed = JSON.parse(readFileSync(statePath(), "utf8"));
    if (!parsed || typeof parsed !== "object") return blank;
    return {
      v: 1,
      day: typeof parsed.day === "string" ? parsed.day : blank.day,
      actions: Number.isFinite(parsed.actions) ? parsed.actions : 0,
      frame: typeof parsed.frame === "string" ? parsed.frame : null,
    };
  } catch {
    return blank;
  }
}

function saveState(state) {
  mkdirSync(STATE_DIR, { recursive: true });
  writeFileSync(statePath(), JSON.stringify(state), { encoding: "utf8", mode: 0o600 });
}

function wslOutput(argv, options = {}) {
  const buffer = execFileSync("wsl.exe", argv, {
    windowsHide: true,
    timeout: options.timeout ?? CALL_TIMEOUT_MS,
    maxBuffer: 8 * 1024 * 1024,
  });
  return buffer.includes(0) ? buffer.toString("utf16le") : buffer.toString("utf8");
}

function wslExec(argv, options = {}) {
  const user = options.user ?? "pm";
  return execFileSync(
    "wsl.exe",
    ["-d", DISTRO, "-u", user, "--exec", ...argv],
    {
      encoding: "utf8",
      windowsHide: true,
      timeout: options.timeout ?? CALL_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      stdio: ["ignore", "pipe", "ignore"],
    },
  );
}

function pmExec(argv, options = {}) {
  return wslExec([...PM_ENV, ...argv], { ...options, user: "pm" });
}

/** `running`, `stopped`, `installing`, or null when the distro is not there. */
function distroState() {
  let text;
  try {
    text = wslOutput(["-l", "-v"], { timeout: 8000 });
  } catch {
    return null;
  }
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^\s*\*?\s*(\S+)\s+(Running|Stopped|Installing|Uninstalling)\s+\d+/i);
    if (match && match[1] === DISTRO) return match[2].toLowerCase();
  }
  return null;
}

function readToken() {
  for (const path of [PM_TOKEN, SELF_TOKEN]) {
    try {
      const token = pmExec(["/bin/cat", path], { timeout: 6000 }).trim();
      if (token.length >= 16) return { token, source: path === PM_TOKEN ? "pm" : "self" };
    } catch {
      /* not there, or not readable yet */
    }
  }
  return null;
}

function requireRunning() {
  const sandbox = distroState();
  if (sandbox === null) {
    throw new SandboxError(
      "SANDBOX_NOT_SET_UP",
      `There is no ${DISTRO} sandbox on this PC. Ask the owner to set it up in Puppet Master.`,
    );
  }
  if (sandbox !== "running") {
    throw new SandboxError(
      "SANDBOX_ASLEEP",
      "The sandbox is asleep. Ask the owner to start it in Puppet Master > Settings > Potato Bot > Sandbox.",
    );
  }
}

function requireToken() {
  const found = readToken();
  if (!found) {
    throw new SandboxError(
      "SANDBOX_NOT_READY",
      "The sandbox is not ready. Start it in Puppet Master > Settings > Potato Bot > Sandbox.",
    );
  }
  return found;
}

function pmUsageDir() {
  const appData = process.env.APPDATA;
  return appData ? join(appData, "com.puppetmaster.app", "potato", "usage") : null;
}

/** True while Puppet Master's bot is likely using the sandbox. */
function pmBusy(now = Date.now()) {
  const dir = pmUsageDir();
  if (!dir) return false;
  let newest = 0;
  try {
    for (const name of readdirSync(dir)) {
      if (!name.endsWith(".json")) continue;
      const at = statSync(join(dir, name)).mtimeMs;
      if (at > newest) newest = at;
    }
  } catch {
    return false;
  }
  return newest > 0 && now - newest < PM_BUSY_MS;
}

async function postControl(path, body, token) {
  let response;
  try {
    response = await fetch(`http://127.0.0.1:${PORT}${path}`, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(CALL_TIMEOUT_MS),
    });
  } catch (error) {
    const why = error instanceof Error ? error.name : "error";
    throw new SandboxError("SANDBOX_UNREACHABLE", `The sandbox screen did not answer (${why}).`);
  }
  const text = await response.text();
  if (response.status === 401) {
    const error = new SandboxError("SANDBOX_UNAUTHORIZED", "The sandbox did not accept its key.");
    error.status = 401;
    throw error;
  }
  if (!response.ok) {
    let why = "";
    try {
      const parsed = JSON.parse(text);
      if (parsed && typeof parsed.error === "string") why = parsed.error;
    } catch {
      /* not json */
    }
    throw new SandboxError(
      "SANDBOX_REJECTED",
      `The sandbox refused that (${response.status}${why ? `: ${why}` : ""}).`,
    );
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new SandboxError("SANDBOX_BAD_REPLY", "The sandbox sent an answer that could not be read.");
  }
}

async function controlCall(path, body) {
  let found = requireToken();
  try {
    return { data: await postControl(path, body, found.token), source: found.source };
  } catch (error) {
    if (error instanceof SandboxError && error.status === 401) {
      found = readToken();
      if (!found) throw error;
      return { data: await postControl(path, body, found.token), source: found.source };
    }
    throw error;
  }
}

function observationText(observation, frame, changed) {
  if (!observation || typeof observation !== "object") return "The screen answered with nothing.";
  const width = Number(observation.width) || 0;
  const height = Number(observation.height) || 0;
  const bits = [`Screen ${width}x${height}`];
  const cursor = observation.cursor;
  if (cursor && Number.isFinite(cursor.x) && Number.isFinite(cursor.y)) {
    bits.push(`pointer at ${cursor.x},${cursor.y}`);
  }
  const window = observation.activeWindow;
  if (window && typeof window.title === "string" && window.title !== "") {
    bits.push(`front window "${window.title.slice(0, 120)}"`);
  } else if (window && window.id) {
    bits.push(`front window #${window.id}`);
  }
  bits.push(
    frame
      ? `frame ${frame}, ${changed === null ? "first look" : changed ? "the screen changed since your last look" : "the screen is unchanged since your last look"}`
      : "no frame id",
  );
  return `${bits.join("; ")}.\nYou cannot see pictures. Use browser_snapshot for a page's words.`;
}

function rememberFrame(observation) {
  const image = typeof observation?.image === "string" ? observation.image : "";
  const frame = image === "" ? null : `f-${createHash("sha256").update(Buffer.from(image, "base64")).digest("hex").slice(0, 8)}`;
  const state = loadState();
  const changed = frame === null ? null : state.frame ? state.frame !== frame : null;
  if (frame !== null) {
    state.frame = frame;
    saveState(state);
  }
  return { frame, changed };
}

async function status() {
  const sandbox = distroState();
  if (sandbox === null) {
    return {
      have_pc: false,
      allowed: false,
      state: "not_set_up",
      text: `Computer: not set up. There is no ${DISTRO} sandbox on this PC. Ask the owner to set it up in Puppet Master.`,
    };
  }
  if (sandbox !== "running") {
    return {
      have_pc: false,
      allowed: false,
      state: "asleep",
      text: `Computer: asleep. The ${DISTRO} sandbox is ${sandbox}. Ask the owner to start it in Puppet Master > Settings > Potato Bot > Sandbox.`,
    };
  }
  const found = readToken();
  if (!found) {
    return {
      have_pc: false,
      allowed: false,
      state: "starting",
      text: "Computer: starting. The sandbox is running but its screen service is not ready yet.",
    };
  }
  const busy = pmBusy();
  const state = loadState();
  const used = state.day === localDay() ? state.actions : 0;
  const remaining = Math.max(0, ACTIONS_PER_DAY - used);
  const owner = found.source === "pm" ? "started by Puppet Master" : "started without Puppet Master";
  const lines = [
    busy ? "Computer: in use by Puppet Master right now. Do not act; wait." : "Computer: available.",
    `- sandbox: ${DISTRO} running (${owner})`,
    `- actions left today: ${remaining}/${ACTIONS_PER_DAY}`,
    busy ? "- you may look, but not act, until Puppet Master is quiet." : "- you may look and act.",
  ];
  return {
    have_pc: true,
    allowed: !busy,
    state: busy ? "pm_active" : "available",
    pm_owned: found.source === "pm",
    remaining,
    text: lines.join("\n"),
  };
}

async function observe() {
  requireRunning();
  const { data } = await controlCall("/v1/screenshot", { display: DISPLAY });
  const observation = data.observation;
  const { frame, changed } = rememberFrame(observation);
  return { text: observationText(observation, frame, changed) };
}

function coord(value, name) {
  if (!Number.isInteger(value) || value < 0 || value > MAX_COORD) {
    throw new SandboxError("BAD_ARGS", `${name} must be a whole number between 0 and ${MAX_COORD}.`);
  }
  return String(value);
}

function xdotool(parts) {
  return { argv: ["env", `DISPLAY=${DISPLAY}`, "xdotool", ...parts] };
}

function plainText(value) {
  return typeof value === "string" && value.length > 0 && value.length <= MAX_TEXT && !value.includes("\0");
}

function keyCombo(value) {
  return typeof value === "string" && /^[A-Za-z0-9_+]{1,40}$/.test(value);
}

function launcherName(value) {
  return typeof value === "string" && /^[a-z][a-z0-9-]{0,31}$/.test(value);
}

function buttonName(value) {
  return value === "right" || value === "3" ? "3" : "1";
}

function stepsFor(action, index) {
  if (!action || typeof action !== "object") {
    throw new SandboxError("BAD_ARGS", `Action ${index} is not an object.`);
  }
  const kind = String(action.kind ?? "");
  switch (kind) {
    case "move":
      return [xdotool(["mousemove", "--", coord(action.x, "x"), coord(action.y, "y")])];
    case "click":
    case "left_click":
    case "right_click": {
      const button = kind === "right_click" ? "3" : buttonName(action.button);
      return [xdotool(["mousemove", "--", coord(action.x, "x"), coord(action.y, "y"), "click", button])];
    }
    case "double_click":
    case "doubleclick":
      return [
        xdotool(["mousemove", "--", coord(action.x, "x"), coord(action.y, "y"), "click", buttonName(action.button)]),
        { waitMs: 60 },
        xdotool(["mousemove", "--", coord(action.x, "x"), coord(action.y, "y"), "click", buttonName(action.button)]),
      ];
    case "drag":
      return [
        xdotool(["mousemove", "--", coord(action.x, "x"), coord(action.y, "y"), "mousedown", "1"]),
        xdotool(["mousemove", "--", coord(action.to_x, "to_x"), coord(action.to_y, "to_y")]),
        xdotool(["mouseup", "1"]),
      ];
    case "scroll": {
      const direction = String(action.direction ?? "down");
      const wheel = { up: "4", down: "5", left: "6", right: "7" }[direction];
      if (!wheel) throw new SandboxError("BAD_ARGS", `Action ${index}: direction must be up, down, left or right.`);
      const amount = Number.isInteger(action.amount) ? Math.min(20, Math.max(1, action.amount)) : 3;
      return [
        xdotool([
          "mousemove",
          "--",
          coord(action.x, "x"),
          coord(action.y, "y"),
          "click",
          "--repeat",
          String(amount),
          wheel,
        ]),
      ];
    }
    case "type": {
      if (!plainText(action.text)) {
        throw new SandboxError("BAD_ARGS", `Action ${index}: text is empty, too long or has a NUL.`);
      }
      return [xdotool(["type", "--clearmodifiers", "--", action.text])];
    }
    case "key": {
      if (!keyCombo(action.key)) {
        throw new SandboxError("BAD_ARGS", `Action ${index}: key is letters, digits, _ and + only.`);
      }
      return [xdotool(["key", "--clearmodifiers", action.key])];
    }
    case "wait": {
      const ms = Number.isInteger(action.ms) ? Math.min(MAX_WAIT_MS, Math.max(0, action.ms)) : 0;
      return [{ waitMs: ms }];
    }
    case "launch":
    case "focus": {
      if (!launcherName(action.app)) {
        throw new SandboxError("BAD_ARGS", `Action ${index}: app is a lowercase name (chrome, terminal, files, editor).`);
      }
      const argv = ["env", `DISPLAY=${DISPLAY}`, "pm-sbx-focus-or-launch", action.app];
      if (action.arg !== undefined && action.arg !== null) {
        const arg = String(action.arg);
        if (arg === "" || arg.startsWith("-") || arg.includes("\0") || arg.length > MAX_TEXT) {
          throw new SandboxError("BAD_ARGS", `Action ${index}: arg is empty, starts with '-' or is too long.`);
        }
        argv.push(arg);
      }
      return [{ argv }];
    }
    default:
      throw new SandboxError("BAD_ARGS", `Action ${index}: unknown kind "${kind}".`);
  }
}

function plan(actions) {
  const steps = [];
  for (let i = 0; i < actions.length; i += 1) steps.push(...stepsFor(actions[i], i));
  if (steps.length > MAX_STEPS) {
    throw new SandboxError("BAD_ARGS", `That is ${steps.length} steps; one call may do at most ${MAX_STEPS}.`);
  }
  return steps;
}

function spend(actions) {
  const state = loadState();
  const today = localDay();
  if (state.day !== today) {
    state.day = today;
    state.actions = 0;
  }
  if (state.actions + actions > ACTIONS_PER_DAY) {
    throw new SandboxError(
      "SANDBOX_DAILY_CAP",
      `No computer actions left today (${state.actions}/${ACTIONS_PER_DAY}). Try again tomorrow or ask the owner to raise the limit.`,
    );
  }
  state.actions += actions;
  saveState(state);
}

async function act(args) {
  requireRunning();
  if (pmBusy()) {
    throw new SandboxError(
      "PM_HAS_PRIORITY",
      "Puppet Master is using the computer right now. Wait a little, then try again.",
    );
  }
  const actions = Array.isArray(args.actions) ? args.actions : null;
  if (!actions || actions.length === 0) {
    throw new SandboxError("BAD_ARGS", "actions must be a non-empty array.");
  }
  if (actions.length > MAX_ACTIONS) {
    throw new SandboxError("BAD_ARGS", `At most ${MAX_ACTIONS} actions in one call.`);
  }
  const steps = plan(actions);
  spend(actions.length);
  const { data } = await controlCall("/v1/desktop", {
    display: DISPLAY,
    steps,
    settleMs: 300,
    observe: true,
  });
  const observation = data.observation;
  const { frame, changed } = rememberFrame(observation);
  const done = Number.isFinite(data.completed) ? data.completed : steps.length;
  return {
    text: `Did ${done} step${done === 1 ? "" : "s"} for ${actions.length} action${actions.length === 1 ? "" : "s"}. ${observationText(observation, frame, changed)}`,
  };
}

async function run(op, args) {
  switch (op) {
    case "status":
      return status();
    case "observe":
      return observe();
    case "act":
      return act(args);
    default:
      throw new SandboxError("UNKNOWN_OP", `Unknown sandbox operation "${op}".`);
  }
}

function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function alive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

function brief(error) {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").slice(0, 180);
}

function watchLog(line) {
  try {
    mkdirSync(STATE_DIR, { recursive: true });
    appendFileSync(join(STATE_DIR, "watch.log"), `${new Date().toISOString()} ${line}\n`, "utf8");
  } catch {
    /* logging never stops the watch */
  }
}

function waitForBoot(timeoutMs) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    try {
      wslExec(["/bin/test", "-f", "/run/pm-sbx/boot.done"], { user: "root", timeout: 5000 });
      return true;
    } catch {
      sleepSync(2000);
    }
  }
  return false;
}

function revive() {
  watchLog(`sandbox is stopped; waking ${DISTRO}`);
  try {
    wslExec(["/bin/true"], { user: "root", timeout: 60_000 });
  } catch (error) {
    watchLog(`boot failed: ${brief(error)}`);
    return;
  }
  if (!waitForBoot(90_000)) {
    watchLog("boot did not finish; will try again");
    return;
  }
  try {
    const out = wslExec(
      [
        ...PM_ENV,
        `PM_SBX_CONTROL_PORT=${PORT}`,
        `PM_SBX_DISPLAY=${DISPLAY}`,
        "/usr/local/bin/pm-sbx-start-desktop",
        "start",
      ],
      { user: "pm", timeout: 120_000 },
    );
    const lines = out.trim().split(/\r?\n/).filter(Boolean);
    watchLog((lines[lines.length - 1] ?? "desktop started").slice(0, 200));
  } catch (error) {
    watchLog(`desktop start failed: ${brief(error)}`);
  }
}

/**
 * Keep the sandbox awake while fish runs. It never terminates anything: when
 * the distro is stopped (Puppet Master idle stop or app exit) it boots it and
 * starts the desktop, the same way the app does.
 *
 * One watch per state folder, and it stops when the fish process it belongs to
 * is gone.
 */
function watch() {
  mkdirSync(STATE_DIR, { recursive: true });
  const lock = join(STATE_DIR, "watch.json");
  try {
    const previous = JSON.parse(readFileSync(lock, "utf8"));
    if (alive(previous.pid) && alive(previous.parent)) return;
  } catch {
    /* no lock, or a stale one */
  }
  writeFileSync(lock, JSON.stringify({ pid: process.pid, parent: WATCH_PARENT_PID }), {
    encoding: "utf8",
    mode: 0o600,
  });
  const cleanup = () => {
    try {
      const current = JSON.parse(readFileSync(lock, "utf8"));
      if (current.pid === process.pid) unlinkSync(lock);
    } catch {
      /* nothing to clean */
    }
  };
  process.on("exit", cleanup);
  watchLog(`watch start (parent ${WATCH_PARENT_PID || "none"})`);
  for (;;) {
    if (WATCH_PARENT_PID > 0 && !alive(WATCH_PARENT_PID)) {
      watchLog("fish is gone; watch stops");
      cleanup();
      return;
    }
    let state = null;
    try {
      state = distroState();
    } catch {
      state = null;
    }
    if (state === "stopped") revive();
    sleepSync(WATCH_MS);
  }
}

async function readStdin() {
  process.stdin.setEncoding("utf8");
  let text = "";
  for await (const chunk of process.stdin) text += chunk;
  return text;
}

async function main() {
  const raw = await readStdin();
  let request;
  try {
    request = raw.trim() === "" ? {} : JSON.parse(raw);
  } catch {
    throw new SandboxError("BAD_REQUEST", "The request was not JSON.");
  }
  const op = typeof request.op === "string" ? request.op : "";
  const args = request.args && typeof request.args === "object" ? request.args : {};
  const result = await run(op, args);
  process.stdout.write(JSON.stringify({ ok: true, ...result }));
}

if (process.argv.includes("--watch")) {
  watch();
} else {
  main().catch((error) => {
    const code = error instanceof SandboxError ? error.code : "SANDBOX_FAILED";
    const message =
      error instanceof Error && !String(error.message).includes("wsl.exe")
        ? error.message
        : "The sandbox could not be reached. Is Windows' Linux feature (WSL) installed?";
    process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }));
  });
}
