import { test } from "node:test";
import assert from "node:assert/strict";
import {
  DM_LIMIT,
  QUEUE_LIMIT,
  TURN_LIMIT,
  dmAllowed,
  emptyRules,
  queueFull,
  scopeAllows,
  scopeReason,
  takeToken,
} from "../src/channels/scope.ts";
import type { ScopeRules, TokenBucket } from "../src/channels/scope.ts";

const dm = (authorId: string) => ({ inGuild: false, channelId: "@me", authorId });
const guild = (channelId: string, authorId = "u1") => ({ inGuild: true, channelId, authorId });

const rules = (patch: Partial<ScopeRules> = {}): ScopeRules => ({ ...emptyRules(), ...patch });

test("defaults: guilds open, DMs closed when no owners are set", () => {
  assert.equal(scopeAllows(guild("c1"), rules()), true);
  assert.equal(scopeAllows(dm("u1"), rules()), false, "empty DM audience means nobody");
  assert.equal(scopeReason(dm("u1"), rules()), "dm-not-allowed");
});

test("with no dmUsers, DMs are owners only", () => {
  const r = rules({ owners: ["me"] });
  assert.equal(scopeAllows(dm("me"), r), true);
  assert.equal(scopeAllows(dm("stranger"), r), false);
  assert.equal(scopeAllows(guild("c1", "stranger"), r), true, "channels must be unaffected");
});

test("dmUsers overrides the owner default", () => {
  const r = rules({ owners: ["owner"], dmUsers: ["friend"] });
  assert.equal(dmAllowed("friend", r), true);
  assert.equal(dmAllowed("owner", r), false);
  assert.equal(dmAllowed("stranger", r), false);
});

test("DISCORD_DM_OPEN restores open DMs", () => {
  const r = rules({ dmOpen: true });
  assert.equal(scopeAllows(dm("anyone"), r), true);
  assert.equal(scopeAllows(guild("c1", "anyone"), r), true);
});

test("DM_OPEN still honours dmUsers when both are set", () => {
  const r = rules({ dmOpen: true, dmUsers: ["friend"] });
  assert.equal(scopeAllows(dm("friend"), r), true);
  assert.equal(scopeAllows(dm("stranger"), r), false);
});

test("dms off blocks every DM but no channel", () => {
  const r = rules({ dms: false, owners: ["me"], dmOpen: true });
  assert.equal(scopeReason(dm("me"), r), "dms-off");
  assert.equal(scopeAllows(guild("c1"), r), true);
});

test("channel allowlist restricts guilds only", () => {
  const r = rules({ onlyChannels: ["c1"], dmOpen: true });
  assert.equal(scopeAllows(guild("c1"), r), true);
  assert.equal(scopeReason(guild("c2"), r), "channel-not-allowed");
  assert.equal(scopeAllows(dm("u1"), r), true, "DMs must be unaffected");
});

test("blocklist beats every allowlist", () => {
  const r = rules({ owners: ["me"], onlyChannels: ["c1"], ignoreUsers: ["me"] });
  assert.equal(scopeReason(dm("me"), r), "ignored");
  assert.equal(scopeReason(guild("c1", "me"), r), "ignored");
  assert.equal(scopeAllows(guild("c1", "other"), r), true);
});

test("empty channel and blocklists mean no restriction", () => {
  const r = rules({ onlyChannels: [], ignoreUsers: [] });
  assert.equal(scopeAllows(guild("anywhere"), r), true);
});

test("token bucket: six turns, then refused until refilled", () => {
  const start = 1_000_000;
  let bucket: TokenBucket | undefined;
  for (let i = 0; i < 6; i++) {
    const taken = takeToken(bucket, start, TURN_LIMIT);
    assert.equal(taken.ok, true, `turn ${i + 1} should pass`);
    bucket = taken.bucket;
  }
  assert.equal(takeToken(bucket, start, TURN_LIMIT).ok, false, "seventh turn refused");
  // One token comes back every 50 seconds at 6 per 5 minutes.
  assert.equal(takeToken(bucket, start + 49_000, TURN_LIMIT).ok, false);
  assert.equal(takeToken(bucket, start + 50_000, TURN_LIMIT).ok, true);
});

test("token bucket never refills past capacity", () => {
  const bucket: TokenBucket = { tokens: 0, at: 0 };
  const later = takeToken(bucket, 10 * 60_000, TURN_LIMIT);
  assert.equal(later.ok, true);
  assert.ok(later.bucket.tokens <= TURN_LIMIT.capacity - 1);
});

test("DM bucket starts full and refuses a burst beyond its capacity", () => {
  let bucket: TokenBucket | undefined;
  let passed = 0;
  for (let i = 0; i < DM_LIMIT.capacity + 3; i++) {
    const taken = takeToken(bucket, 0, DM_LIMIT);
    bucket = taken.bucket;
    if (taken.ok) passed++;
  }
  assert.equal(passed, DM_LIMIT.capacity);
});

test("queue bound: accepts up to the limit, refuses beyond", () => {
  assert.equal(queueFull(0), false);
  assert.equal(queueFull(QUEUE_LIMIT - 1), false);
  assert.equal(queueFull(QUEUE_LIMIT), true);
  assert.equal(queueFull(QUEUE_LIMIT + 1), true);
});
