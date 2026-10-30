import { test } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, HELP, formatMood, formatStats } from "../src/channels/commands.ts";
import { initialMood } from "../src/persona/mood.ts";

test("mood panel shows labels and bars, never raw json", () => {
  const mood = { ...initialMood(new Date(2026, 9, 29, 15, 0)), mood: "hungry" as const, intensity: 2 as const, energy: 70, hunger: 40 };
  const text = formatMood(mood);

  assert.ok(text.includes("餓"));
  assert.ok(text.includes("▮▮"));
  assert.ok(text.includes("精神"));
  assert.ok(text.includes("肚子"));
  assert.ok(!text.includes("{"));
});

test("stats panel reports hit rate and savings", () => {
  const text = formatStats(
    {
      requests: 12,
      hitTokens: 9000,
      missTokens: 1000,
      promptTokens: 10000,
      completionTokens: 300,
      costUsd: 0.0004,
      naiveCostUsd: 0.003,
    },
    12,
  );

  assert.ok(text.includes("90%"), text);
  assert.ok(text.includes("$0.0004"));
  assert.ok(text.includes("$0.0026"));
});

test("stats panel survives a cold start", () => {
  const text = formatStats(
    {
      requests: 0,
      hitTokens: 0,
      missTokens: 0,
      promptTokens: 0,
      completionTokens: 0,
      costUsd: 0,
      naiveCostUsd: 0,
    },
    0,
  );
  assert.ok(text.includes("0%"));
});

test("command names are unique and described", () => {
  const names = COMMANDS.map((command) => command.name);
  assert.equal(new Set(names).size, names.length);
  assert.deepEqual(names.sort(), ["config", "diary", "help", "ignore", "mood", "ping", "recall", "stats", "tune"]);

  for (const command of COMMANDS) {
    assert.ok((command.description ?? "").length > 0, command.name);
  }
});

test("help lists every command", () => {
  for (const name of ["mood", "stats", "recall", "diary", "config", "tune", "ignore", "ping", "help"]) {
    assert.ok(HELP.includes(name), name);
  }
});
