// The sandbox plugin adds tools through the DriveKit seam and changes nothing
// when FISHD_SANDBOX is off. Running a tool would reach WSL, so this test only
// checks the tool surface and ownership.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { sandboxDrives } from "../src/plugins/sandbox/index.ts";

const SANDBOX = ["sandbox_status", "computer_observe", "computer_act"];

test("the sandbox tools appear only when FISHD_SANDBOX=1", () => {
  const dir = mkdtempSync(join(tmpdir(), "fishd-sandbox-plugin-"));
  const saved = process.env.FISHD_SANDBOX;
  try {
    delete process.env.FISHD_SANDBOX;
    const off = sandboxDrives(dir);
    assert.deepEqual(
      off.tools().map((tool) => tool.name),
      ["drive", "keep", "tune"],
    );
    for (const name of SANDBOX) assert.equal(off.owns(name), false);

    process.env.FISHD_SANDBOX = "1";
    const on = sandboxDrives(dir);
    const names = on.tools().map((tool) => tool.name);
    for (const name of SANDBOX) {
      assert.ok(names.includes(name), `${name} is offered`);
      assert.equal(on.owns(name), true, `${name} is owned`);
    }
    assert.equal(on.owns("drive"), true, "the drive tools still work");
  } finally {
    if (saved === undefined) delete process.env.FISHD_SANDBOX;
    else process.env.FISHD_SANDBOX = saved;
    rmSync(dir, { recursive: true, force: true });
  }
});
