import { test } from "node:test";
import assert from "node:assert/strict";
import { SETTINGS, describeSettings, findSetting } from "../src/channels/settings.ts";
import { readLiveSettings } from "../src/live.ts";

test("every setting has a unique slash name and an env key", () => {
  const keys = SETTINGS.map((setting) => setting.key);
  assert.equal(new Set(keys).size, keys.length);
  for (const setting of SETTINGS) {
    assert.ok(/^(DISCORD|JEV|FISHD)_/.test(setting.env), setting.key);
    assert.ok(setting.label.length > 0);
  }
});

test("numbers are range-checked", () => {
  const talk = findSetting("talk");
  assert.equal(talk?.parse("2")["ok"], true);
  assert.equal(talk?.parse("99")["ok"], false);
  assert.equal(talk?.parse("abc")["ok"], false);

  const threshold = findSetting("threshold");
  assert.equal(threshold?.parse("0")["ok"], true);
  assert.equal(threshold?.parse("1.5")["ok"], false);
});

test("budget requires N/M", () => {
  const budget = findSetting("budget");
  assert.equal(budget?.parse("6/60")["ok"], true);
  assert.equal(budget?.parse("6")["ok"], false);
  assert.equal(budget?.parse("0/30")["ok"], false);

  const ok = budget?.parse(" 6 / 60 ");
  assert.equal(ok?.["ok"], true);
  if (ok && ok.ok) assert.equal(ok.value, "6/60");
});

test("spontaneous accepts on/off words", () => {
  const spont = findSetting("spontaneous");
  for (const on of ["on", "1", "true", "開"]) {
    const r = spont?.parse(on);
    assert.equal(r?.["ok"], true, on);
    if (r && r.ok) assert.equal(r.value, "1");
  }
  for (const off of ["off", "0", "false", "關"]) {
    const r = spont?.parse(off);
    assert.equal(r?.["ok"], true, off);
    if (r && r.ok) assert.equal(r.value, "0");
  }
  assert.equal(spont?.parse("maybe")["ok"], false);
});

test("show panel reflects live values", () => {
  const text = describeSettings(readLiveSettings());
  for (const key of ["talk", "threshold", "arm_ms", "cooldown", "settle", "burst", "budget"]) {
    assert.ok(text.includes(key), key);
  }
});
