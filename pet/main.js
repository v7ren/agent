const { app, BrowserWindow, Menu, Tray, nativeImage, screen, ipcMain } = require("electron");
const path = require("node:path");
const fs = require("node:fs");

const WIDTH = 300;
const HEIGHT = 420;
const API = process.env.FISHD_API || "http://127.0.0.1:7777";

let win = null;
let tray = null;
let mode = "idle";
let scale = 1;
let ignoring = false;
let hovering = false;
let mouseIgnored = null;
let sound = true;
let drag = null;
let followTimer = null;
let walkTimer = null;

const configPath = path.join(__dirname, "pet.config.json");

function readConfig() {
  try {
    return JSON.parse(fs.readFileSync(configPath, "utf8"));
  } catch {
    return {};
  }
}

function saveConfig(patch) {
  const next = { ...readConfig(), ...patch };
  try {
    fs.writeFileSync(configPath, JSON.stringify(next, null, 2), "utf8");
  } catch {
    /* read-only install */
  }
  return next;
}

function applySize() {
  if (!win) return;
  win.setSize(Math.round(WIDTH * scale), Math.round(HEIGHT * scale));
}

function stopMotion() {
  if (followTimer) clearInterval(followTimer);
  if (walkTimer) clearInterval(walkTimer);
  followTimer = null;
  walkTimer = null;
}

function startFollow() {
  stopMotion();
  followTimer = setInterval(() => {
    if (!win || drag) return;
    const cursor = screen.getCursorScreenPoint();
    const [x, y] = win.getPosition();
    const targetX = cursor.x - Math.round((WIDTH * scale) / 2);
    const targetY = cursor.y - Math.round(HEIGHT * scale * 0.55);
    win.setPosition(
      Math.round(x + (targetX - x) * 0.12),
      Math.round(y + (targetY - y) * 0.12),
    );
  }, 80);
}

function startWalk() {
  stopMotion();
  let direction = 1;
  walkTimer = setInterval(() => {
    if (!win || drag || mode !== "free") return;
    const [x, y] = win.getPosition();
    const bounds = screen.getPrimaryDisplay().workArea;
    const w = Math.round(WIDTH * scale);
    let nextX = x + direction * 2;

    if (nextX < bounds.x) {
      nextX = bounds.x;
      direction = 1;
    }
    if (nextX + w > bounds.x + bounds.width) {
      nextX = bounds.x + bounds.width - w;
      direction = -1;
    }

    win.setPosition(Math.round(nextX), y);
    win.webContents.send("pet:facing", direction);
  }, 40);
}

function applyMousePolicy() {
  if (!win) return;
  const next = ignoring ? true : !hovering;
  if (next === mouseIgnored) return;
  mouseIgnored = next;
  // Empty space lets the desktop through; the fish herself stays clickable.
  win.setIgnoreMouseEvents(next, { forward: true });
}

function setMode(next) {
  mode = next;
  saveConfig({ mode });
  stopMotion();
  if (next === "follow") startFollow();
  if (next === "free") startWalk();
  updateMenu();
}

function setIgnoring(next) {
  ignoring = next;
  applyMousePolicy();
  saveConfig({ ignoring: next });
  updateMenu();
}

function setSound(next) {
  sound = next;
  saveConfig({ sound });
  updateMenu();
}

function setScale(next) {
  scale = next;
  saveConfig({ scale });
  applySize();
  updateMenu();
}

function placeDefault() {
  const area = screen.getPrimaryDisplay().workArea;
  win.setPosition(
    area.x + area.width - Math.round(WIDTH * scale) - 40,
    area.y + area.height - Math.round(HEIGHT * scale) - 40,
  );
}

function menuTemplate() {
  const bite = (name) => () => {
    win?.webContents.send("pet:feed", name);
  };

  return [
    {
      label: "模式",
      submenu: [
        { label: "自由散步", type: "radio", checked: mode === "free", click: () => setMode("free") },
        { label: "跟隨滑鼠", type: "radio", checked: mode === "follow", click: () => setMode("follow") },
        { label: "原地待著", type: "radio", checked: mode === "idle", click: () => setMode("idle") },
      ],
    },
    {
      label: "大小",
      submenu: [1, 1.5, 2].map((value) => ({
        label: `${value * 100}%`,
        type: "radio",
        checked: Math.abs(scale - value) < 0.01,
        click: () => setScale(value),
      })),
    },
    {
      label: "餵食",
      submenu: [
        { label: "白飯", click: bite("rice") },
        { label: "小魚乾", click: bite("fish") },
        { label: "蛋糕", click: bite("cake") },
        { label: "西瓜", click: bite("melon") },
      ],
    },
    { type: "separator" },
    { label: "說句話", click: () => win?.webContents.send("pet:speak") },
    { label: "打開聊天", click: () => win?.webContents.send("pet:chat") },
    { type: "separator" },
    {
      label: "聲音",
      type: "checkbox",
      checked: sound,
      click: (item) => setSound(item.checked),
    },
    {
      label: "滑鼠穿透",
      type: "checkbox",
      checked: ignoring,
      click: (item) => setIgnoring(item.checked),
    },
    { label: "回到預設位置", click: placeDefault },
    { type: "separator" },
    { label: "離開", click: () => app.quit() },
  ];
}

function updateMenu() {
  const menu = Menu.buildFromTemplate(menuTemplate());
  if (tray) tray.setContextMenu(menu);
  if (win) win.webContents.send("pet:mode", { mode, scale, ignoring, sound });
}

async function pingFish(text) {
  const res = await fetch(`${API}/api/turn`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ text }),
  });
  if (!res.ok) throw new Error(`fishd ${res.status}`);
  return res.json();
}

async function spawnPet() {
  const cfg = readConfig();
  scale = typeof cfg.scale === "number" ? cfg.scale : 1;
  mode = typeof cfg.mode === "string" ? cfg.mode : "idle";
  ignoring = cfg.ignoring === true;
  sound = cfg.sound !== false;

  win = new BrowserWindow({
    width: Math.round(WIDTH * scale),
    height: Math.round(HEIGHT * scale),
    transparent: true,
    frame: false,
    resizable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    backgroundColor: "#00000000",
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  win.setAlwaysOnTop(true, "screen-saver");
  win.loadFile(path.join(__dirname, "index.html"));
  win.once("ready-to-show", () => {
    placeDefault();
    win.show();
    applyMousePolicy();
    if (mode === "follow") startFollow();
    if (mode === "free") startWalk();
    updateMenu();
  });

  const iconPath = path.join(__dirname, "assets", "icon.png");
  const icon = fs.existsSync(iconPath) ? nativeImage.createFromPath(iconPath) : nativeImage.createEmpty();
  tray = new Tray(icon);

  Menu.setApplicationMenu(null);
  updateMenu();
}

ipcMain.on("pet:hover", (_event, inside) => {
  hovering = inside === true;
  applyMousePolicy();
});

ipcMain.on("pet:drag-start", (_event, point) => {
  if (!win) return;
  const [x, y] = win.getPosition();
  drag = { offsetX: point.x - x, offsetY: point.y - y };
});

ipcMain.on("pet:menu", () => {
  Menu.buildFromTemplate(menuTemplate()).popup({ window: win });
});

ipcMain.on("pet:drag-end", () => {
  drag = null;
});

ipcMain.handle("pet:spontaneous", async () => {
  try {
    const res = await fetch(`${API}/api/spontaneous`, { method: "POST" });
    if (!res.ok) throw new Error(`fishd ${res.status}`);
    return { ok: true, data: await res.json() };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

ipcMain.handle("pet:say", async (_event, text) => {
  try {
    const data = await pingFish(text);
    return { ok: true, data };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
});

setInterval(() => {
  if (!win || !drag) return;
  const cursor = screen.getCursorScreenPoint();
  win.setPosition(Math.round(cursor.x - drag.offsetX), Math.round(cursor.y - drag.offsetY));
}, 16);

app.whenReady().then(spawnPet);

app.on("window-all-closed", () => app.quit());
