import test from "node:test";
import assert from "node:assert/strict";
import { buildJevState } from "../src/channels/gate.ts";

const base = { channel: "c", names: ["大肥魚"], lastSpokeAt: 0, now: 60_000, base: 0.1, messageId: "m" };

test("Jev is shown her own lines, who each line was for, and that someone answered her", () => {
  const state = buildJevState({
    ...base,
    messages: [
      { author: "ren", text: "你吃了嗎", at: 1, to: ["她"] },
      { author: "她", text: "還沒，想吃白飯", at: 2, self: true },
      { author: "ren", text: "那我請你", at: 3 },
    ],
  });
  assert.match(state, /\[ren → 她\]：你吃了嗎/);
  assert.match(state, /她（大肥魚）：還沒/);
  assert.match(state, /緊接在她剛說完的話之後/);
});

test("a line for someone else is marked, and no follow-up cue is invented", () => {
  const state = buildJevState({
    ...base,
    messages: [
      { author: "她", text: "嗯", at: 1, self: true },
      { author: "Wennn", text: "在嗎", at: 2, to: ["輕輕鬆鬆啊"] },
    ],
  });
  assert.match(state, /\[Wennn → 輕輕鬆鬆啊\]：在嗎/);
  assert.ok(!state.includes("緊接在她"), "aimed at someone else: not a follow-up to her");
  const none = buildJevState({ ...base, messages: [{ author: "a", text: "x", at: 1 }, { author: "b", text: "y", at: 2 }] });
  assert.ok(!none.includes("緊接在她"));
});
