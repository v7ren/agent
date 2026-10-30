#!/usr/bin/env node
/**
 * 把一包 sprite（例如 dafeiyu-pet 的 sprites/）整理成 pet/assets 並產生 manifest。
 *
 *   node pet/import-assets.js <資料夾> [--fps 8]
 *
 * 辨識規則（中文 / 英文都可以）：
 *   正面 front face down        -> idle / talk / eat
 *   側面 side walk              -> walk（左右由程式鏡像）
 *   背面 back up                 -> back
 *   既有狀態名 idle/walk/...     -> 直接歸類
 */
const { copyFileSync, mkdirSync, readdirSync, statSync, writeFileSync, existsSync } = require("node:fs");
const path = require("node:path");

const root = path.join(__dirname, "assets");
const args = process.argv.slice(2);
const source = args.find((arg) => !arg.startsWith("--"));
const fpsIndex = args.indexOf("--fps");
const fps = fpsIndex >= 0 ? Number(args[fpsIndex + 1]) || 8 : 8;

if (!source) {
  console.error("用法：node pet/import-assets.js <資料夾> [--fps 8]");
  process.exit(1);
}

const srcDir = path.resolve(source);
if (!existsSync(srcDir)) {
  console.error(`找不到資料夾：${srcDir}`);
  process.exit(1);
}

const IMAGE = /\.(png|gif|webp|apng)$/i;
const SIZE_VARIANT = /_\d{3}$/;

const RULES = [
  { state: "idle", match: /(^|[^a-z])(idle|stand|front|face|down|正面|站)/i },
  { state: "walk", match: /(^|[^a-z])(walk|side|left|right|側面|侧面|走)/i },
  { state: "back", match: /(^|[^a-z])(back|up|背面)/i },
  { state: "talk", match: /(^|[^a-z])(talk|speak|chat|說|说|聊)/i },
  { state: "eat", match: /(^|[^a-z])(eat|food|feed|吃|飯|饭)/i },
  { state: "drag", match: /(^|[^a-z])(drag|hold|抓|拖)/i },
];

function collect(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const abs = path.join(dir, name);
    const stat = statSync(abs);
    if (stat.isDirectory()) collect(abs, out);
    else if (IMAGE.test(name)) out.push(abs);
  }
  return out;
}

const files = collect(srcDir)
  .map((abs) => ({ abs, rel: path.relative(srcDir, abs).replace(/\\/g, "/") }))
  .filter(({ rel }) => {
    const base = path.basename(rel, path.extname(rel));
    return !SIZE_VARIANT.test(base);
  });

const buckets = { idle: [], walk: [], back: [], talk: [], eat: [], drag: [] };
const skipped = [];

for (const file of files) {
  const base = path.basename(file.rel, path.extname(file.rel));
  const rule = RULES.find((candidate) => candidate.match.test(base) || candidate.match.test(file.rel));
  if (!rule) {
    skipped.push(file.rel);
    continue;
  }
  buckets[rule.state].push(file.rel);
}

// 沒有正面圖時，任何圖都可以當待機
if (buckets.idle.length === 0) {
  const fallback = buckets.walk[0] || buckets.talk[0] || files[0]?.rel;
  if (fallback) buckets.idle.push(fallback);
}

mkdirSync(root, { recursive: true });

const manifest = { fps, size: { width: 200, height: 220 }, states: {} };
const copied = [];

for (const [state, list] of Object.entries(buckets)) {
  if (list.length === 0) {
    manifest.states[state] = [];
    continue;
  }

  const names = [];
  list.forEach((rel, index) => {
    const ext = path.extname(rel).toLowerCase();
    const target = `${state}-${String(index + 1).padStart(2, "0")}${ext}`;
    copyFileSync(path.join(srcDir, rel), path.join(root, target));
    names.push(target);
    copied.push(target);
  });
  manifest.states[state] = names;
}

// 側面圖可以同時當作對話/吃東西，避免那兩個狀態空著
if (manifest.states.talk.length === 0) manifest.states.talk = [...manifest.states.idle];
if (manifest.states.eat.length === 0) manifest.states.eat = [...manifest.states.idle];
if (manifest.states.drag.length === 0) manifest.states.drag = [...manifest.states.walk];

writeFileSync(path.join(root, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

console.log(`來源：${srcDir}`);
console.log(`複製 ${copied.length} 張 → ${root}`);
for (const [state, list] of Object.entries(manifest.states)) {
  console.log(`  ${state.padEnd(5)} ${list.length === 0 ? "（空，使用內建圖）" : list.join(", ")}`);
}
if (skipped.length > 0) console.log(`略過 ${skipped.length} 張無法辨識的檔名：${skipped.slice(0, 5).join(", ")}`);
console.log("重開桌寵就會套用。");
