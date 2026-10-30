import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { renderTuneState } from "../src/persona/selftune.ts";
import type { Change } from "../src/persona/selftune.ts";
import { appendMoodLog, appendSelfLog } from "../src/persona/persona.ts";
import { appendNote } from "../src/persona/notes.ts";

// 01:05 on the machine's own clock. In UTC+8 that is still the previous UTC day,
// which is exactly when raw ISO dates go wrong.
const LOCAL = new Date(2026, 9, 31, 1, 5);

test("self log and mood log are dated on the system clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  appendSelfLog(dir, "測試", LOCAL);
  appendMoodLog(dir, "測試", LOCAL);
  assert.match(readFileSync(join(dir, "self-log.md"), "utf8"), /- 2026-10-31 測試/);
  assert.match(readFileSync(join(dir, "mood-log.md"), "utf8"), /- 2026-10-31 測試/);
});

test("persona notes are dated on the system clock", () => {
  const dir = mkdtempSync(join(tmpdir(), "lt-"));
  appendNote(dir, "他喜歡白飯", LOCAL);
  assert.match(readFileSync(join(dir, "notes.md"), "utf8"), /- 2026-10-31 他喜歡白飯/);
});

test("tune history shows local time, not raw UTC", () => {
  const change: Change = {
    id: "abc12345",
    key: "DISCORD_SPON_DM_MIN",
    from: "1",
    to: "30",
    at: LOCAL.toISOString(),
    by: "self",
    status: "applied",
  };
  assert.match(renderTuneState([change], LOCAL), /2026-10-31 01:05 DISCORD_SPON_DM_MIN/);
});
