import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { hostOk, keyAllowed, sameOrigin, startWeb } from "../src/web/server.ts";
import { LIVE_KEYS, restartNeeded } from "../src/settings-write.ts";
import type { Agent } from "../src/core/loop.ts";

test("hostOk accepts only 127.0.0.1 / localhost on the bound port", () => {
  assert.equal(hostOk("127.0.0.1:7777", 7777), true);
  assert.equal(hostOk("localhost:7777", 7777), true);
  assert.equal(hostOk("LOCALHOST:7777", 7777), true);
  assert.equal(hostOk("evil.example:7777", 7777), false);
  assert.equal(hostOk("127.0.0.1:8888", 7777), false);
  assert.equal(hostOk("127.0.0.1", 7777), false);
  assert.equal(hostOk(undefined, 7777), false);
});

test("sameOrigin requires the origin to match the validated host", () => {
  assert.equal(sameOrigin("http://127.0.0.1:7777", "127.0.0.1:7777", 7777), true);
  assert.equal(sameOrigin("http://localhost:7777", "localhost:7777", 7777), true);
  assert.equal(sameOrigin(undefined, "127.0.0.1:7777", 7777), false);
  assert.equal(sameOrigin("null", "127.0.0.1:7777", 7777), false);
  assert.equal(sameOrigin("https://evil.example", "127.0.0.1:7777", 7777), false);
  assert.equal(sameOrigin("http://127.0.0.1:9999", "127.0.0.1:7777", 7777), false);
  assert.equal(sameOrigin("http://evil.example", "evil.example:7777", 7777), false);
});

test("keyAllowed accepts only config-schema fields", () => {
  assert.equal(keyAllowed("FISHD_MODEL"), true);
  assert.equal(keyAllowed("NODE_OPTIONS"), false);
  assert.equal(keyAllowed("PATH"), false);
  assert.equal(keyAllowed("__proto__"), false);
});

test("restartNeeded is false only when every key is live", () => {
  assert.equal(restartNeeded([]), false);
  assert.equal(restartNeeded(["DISCORD_TALK", "JEV_THRESHOLD"]), false);
  assert.equal(restartNeeded(["DISCORD_TALK", "FISHD_MODEL"]), true);
  assert.equal(restartNeeded(["DISCORD_TALK"], ), false);
});

test("every live key is actually read by readLiveSettings", () => {
  const src = readFileSync(join(process.cwd(), "src", "live.ts"), "utf8");
  for (const key of LIVE_KEYS) {
    assert.ok(new RegExp(`\\b${key}\\b`).test(src), `${key} is not read in src/live.ts`);
  }
});

function call(
  port: number,
  method: string,
  path: string,
  headers: Record<string, string>,
  body = "",
): Promise<{ status: number; text: string }> {
  return new Promise((resolve, reject) => {
    const req = request({ host: "127.0.0.1", port, method, path, headers }, (res) => {
      let text = "";
      res.on("data", (c) => (text += c));
      res.on("end", () => resolve({ status: res.statusCode ?? 0, text }));
    });
    req.on("error", reject);
    req.end(body);
  });
}

test("live server rejects cross-origin and rebinding requests", async () => {
  const dir = join(tmpdir(), `fishd-server-test-${process.pid}`);
  let turns = 0;
  const agent = {
    turn: async () => {
      turns++;
      throw new Error("should not run");
    },
  } as unknown as Agent;
  const web = await startWeb(agent, { vaultRoot: dir, personaDir: dir, port: 0 });
  try {
    const own = { host: `127.0.0.1:${web.port}`, "content-type": "application/json" };
    const json = JSON.stringify({ text: "hi" });

    const foreign = await call(web.port, "POST", "/api/turn", { ...own, origin: "http://evil.example" }, json);
    assert.equal(foreign.status, 403);

    const noOrigin = await call(web.port, "POST", "/api/spontaneous", own, "");
    assert.equal(noOrigin.status, 403);

    const rebind = await call(
      web.port,
      "POST",
      "/api/turn",
      { host: "evil.example", "content-type": "application/json", origin: "http://evil.example" },
      json,
    );
    assert.equal(rebind.status, 403);

    const getRebind = await call(web.port, "GET", "/api/state", { host: "evil.example" });
    assert.equal(getRebind.status, 403);

    const badKey = await call(
      web.port,
      "POST",
      "/api/config",
      { ...own, origin: `http://127.0.0.1:${web.port}` },
      JSON.stringify({ values: { NODE_OPTIONS: "--require x" } }),
    );
    assert.equal(badKey.status, 400);
    assert.equal(turns, 0);
  } finally {
    await web.close();
  }
});
