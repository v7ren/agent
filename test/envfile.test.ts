import { test } from "node:test";
import assert from "node:assert/strict";
import { envMap, parseEnv, upsertEnv } from "../src/web/envfile.ts";

const SOURCE = [
  "# model",
  "FISHD_MODEL=mimo-v2.6-flash",
  "",
  "# discord",
  "DISCORD_TOKEN=abc123",
  "DISCORD_AMBIENT=0",
  "",
].join("\n");

test("parse reads keys and ignores comments and blanks", () => {
  const entries = parseEnv(SOURCE);
  assert.deepEqual(
    entries.map((e) => e.key),
    ["FISHD_MODEL", "DISCORD_TOKEN", "DISCORD_AMBIENT"],
  );
  assert.equal(entries[0]?.value, "mimo-v2.6-flash");
});

test("upsert replaces values in place and keeps comments", () => {
  const next = upsertEnv(SOURCE, { FISHD_MODEL: "glm-5.3-flash" });
  assert.ok(next.includes("# model"));
  assert.ok(next.includes("FISHD_MODEL=glm-5.3-flash"));
  assert.equal(next.indexOf("FISHD_MODEL"), SOURCE.indexOf("FISHD_MODEL"));
  assert.equal(parseEnv(next).length, 3);
});

test("upsert appends unknown keys and keeps existing ones", () => {
  const next = upsertEnv(SOURCE, { NEW_KEY: "value" });
  const map = envMap(next);
  assert.equal(map["NEW_KEY"], "value");
  assert.equal(map["FISHD_MODEL"], "mimo-v2.6-flash");
  assert.equal(map["DISCORD_TOKEN"], "abc123");
});

test("clear empties a key without deleting its line", () => {
  const next = upsertEnv(SOURCE, {}, ["DISCORD_TOKEN"]);
  assert.ok(next.includes("DISCORD_TOKEN=\n") || next.endsWith("DISCORD_TOKEN="));
  assert.equal(envMap(next)["DISCORD_TOKEN"], "");
});

test("values cannot smuggle newlines into the file", () => {
  const next = upsertEnv(SOURCE, { FISHD_MODEL: "a\nDISCORD_REPLY_ALL=1" });
  const map = envMap(next);
  assert.equal(map["FISHD_MODEL"], "a DISCORD_REPLY_ALL=1");
  assert.equal(map["DISCORD_REPLY_ALL"], undefined);
});

test("an empty change is a no-op", () => {
  assert.equal(upsertEnv(SOURCE, {}, []), SOURCE.replace(/\n?$/, "\n"));
});

test("crlf files stay crlf", () => {
  const crlf = "A=1\r\nB=2\r\n";
  const next = upsertEnv(crlf, { A: "9" });
  assert.ok(next.includes("\r\n"));
  assert.equal(envMap(next)["A"], "9");
});
