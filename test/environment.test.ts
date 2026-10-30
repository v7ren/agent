import { test } from "node:test";
import assert from "node:assert/strict";
import { renderEnvironment } from "../src/persona/environment.ts";

const start = new Date("2026-10-30T12:00:00Z");
const at = (ms: number) => new Date(start.getTime() + ms);
const HOUR = 3_600_000;
const MIN = 60_000;

test("platform maps to a place and never leaks machine details", () => {
  const base = { provider: "", model: "", startedAt: start, now: start };
  assert.match(renderEnvironment({ ...base, platform: "win32" }), /跑在主人自己的Windows 電腦上/);
  assert.match(renderEnvironment({ ...base, platform: "darwin" }), /跑在主人自己的Mac上/);
  assert.match(renderEnvironment({ ...base, platform: "linux" }), /跑在主人自己的Linux 主機上/);
  assert.match(renderEnvironment({ ...base, platform: "freebsd" }), /跑在主人自己的電腦上/);
});

test("uptime is shown in minutes, hours, then days", () => {
  const base = { platform: "win32", provider: "", model: "", startedAt: start };
  assert.match(renderEnvironment({ ...base, now: at(0) }), /已經醒了 不到 1 分鐘/);
  assert.match(renderEnvironment({ ...base, now: at(42 * MIN) }), /已經醒了 42 分鐘/);
  assert.match(renderEnvironment({ ...base, now: at(3 * HOUR) }), /已經醒了 3 小時/);
  assert.match(renderEnvironment({ ...base, now: at(50 * HOUR) }), /已經醒了 2 天/);
  assert.match(renderEnvironment({ ...base, now: at(-HOUR) }), /已經醒了 不到 1 分鐘/);
});

test("model and provider appear when present and are omitted when empty", () => {
  const base = { platform: "win32", startedAt: start, now: start };
  const full = renderEnvironment({ ...base, provider: "deepseek", model: "deepseek-v4-flash" });
  assert.match(full, /用的腦是 deepseek-v4-flash（deepseek）/);

  const modelOnly = renderEnvironment({ ...base, provider: "", model: "deepseek-v4-flash" });
  assert.match(modelOnly, /用的腦是 deepseek-v4-flash；/);

  const providerOnly = renderEnvironment({ ...base, provider: "deepseek", model: "" });
  assert.match(providerOnly, /用的腦來自 deepseek/);

  const none = renderEnvironment({ ...base, provider: "", model: "" });
  assert.doesNotMatch(none, /用的腦/);
});

test("model and provider are sanitised to the allowed characters", () => {
  const base = { platform: "win32", startedAt: start, now: start };
  const out = renderEnvironment({ ...base, provider: "", model: "deepseek v4<script>x" });
  assert.match(out, /用的腦是 deepseekv4scriptx；/);
  assert.doesNotMatch(out, /[<>]/);
});

test("model strings are capped at 40 characters", () => {
  const base = { platform: "win32", provider: "", startedAt: start, now: start };
  const out = renderEnvironment({ ...base, model: "a".repeat(60) });
  assert.ok(out.includes(`用的腦是 ${"a".repeat(40)}；`), out);
  assert.ok(!out.includes("a".repeat(41)), out);
});

test("path-like, URL-like and IP-like values are dropped entirely", () => {
  const base = { platform: "win32", startedAt: start, now: start };
  const drive = renderEnvironment({ ...base, provider: "", model: "C:\\Users\\Ren-pc\\secret" });
  assert.doesNotMatch(drive, /用的腦/);
  assert.doesNotMatch(drive, /Users|Ren-pc|secret/);

  const url = renderEnvironment({ ...base, provider: "https://evil.example/x", model: "" });
  assert.doesNotMatch(url, /用的腦|evil|https/);

  const ip = renderEnvironment({ ...base, provider: "", model: "10.0.0.5" });
  assert.doesNotMatch(ip, /用的腦|10\.0\.0\.5/);

  const unixPath = renderEnvironment({ ...base, provider: "", model: "/home/ren/models" });
  assert.doesNotMatch(unixPath, /用的腦|home/);
});

test("the vault clause and the sentence structure are always present", () => {
  const out = renderEnvironment({
    platform: "linux",
    provider: "",
    model: "",
    startedAt: start,
    now: at(3 * HOUR),
  });
  assert.match(out, /^（你的所在：.+；你的記憶是這台電腦裡 vault 資料夾的檔案.+；這次已經醒了 3 小時。）$/);
  assert.ok(!out.includes("\n"));
  assert.ok(!out.includes(start.toISOString()));
});
