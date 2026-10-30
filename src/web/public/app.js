const $ = (id) => document.getElementById(id);

const thread = $("thread");
const scroller = $("scroll");
const input = $("input");
const sendBtn = $("send");
const side = $("side");
const statToggle = $("statToggle");

const MOOD_LABEL = { genki: "元氣", sleepy: "想睡", hungry: "餓", tsundere: "傲嬌" };

let busy = false;

const voiceBtn = $("voice");
let soundOn = localStorage.getItem("fishd-voice") === "1";

const TONE_PROFILE = {
  softcute: { rate: 0.94, pitch: 1.12 },
  playful: { rate: 1.02, pitch: 1.18 },
  healing: { rate: 0.9, pitch: 1.04 },
  energetic: { rate: 1.14, pitch: 1.22 },
  whisper: { rate: 0.82, pitch: 0.98 },
};

function syncVoice() {
  if (!voiceBtn) return;
  voiceBtn.classList.toggle("on", soundOn);
  voiceBtn.setAttribute("aria-pressed", String(soundOn));
  voiceBtn.textContent = soundOn ? "聲" : "靜";
}

function speakAloud(text, tone, { whisper = false } = {}) {
  const line = String(text ?? "").trim();
  if (!soundOn || line === "" || !("speechSynthesis" in window)) return;

  const profile = TONE_PROFILE[whisper ? "whisper" : tone] ?? TONE_PROFILE.softcute;
  const utterance = new SpeechSynthesisUtterance(line);
  utterance.lang = "zh-TW";
  utterance.rate = profile.rate;
  utterance.pitch = profile.pitch;
  utterance.volume = whisper ? 0.5 : 1;
  window.speechSynthesis.speak(utterance);
}

if (voiceBtn) {
  voiceBtn.addEventListener("click", () => {
    soundOn = !soundOn;
    localStorage.setItem("fishd-voice", soundOn ? "1" : "0");
    if (!soundOn) window.speechSynthesis?.cancel();
    syncVoice();
  });
}
syncVoice();

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function el(tag, cls, text) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (text !== undefined && text !== null) node.textContent = text;
  return node;
}

function clearEmpty() {
  const empty = $("empty");
  if (empty && empty.isConnected) empty.remove();
}

function addMessage(role, text) {
  clearEmpty();
  const wrap = el("div", `msg ${role}`);
  wrap.append(el("div", "bubble", text));
  thread.append(wrap);
  return wrap;
}

let typingEl = null;

function showTyping() {
  if (typingEl) return;
  const wrap = el("div", "msg her typing");
  const bubble = el("div", "bubble");
  bubble.append(el("i"), el("i"), el("i"));
  wrap.append(bubble);
  thread.append(wrap);
  typingEl = wrap;
  scrollDown(true);
}

function hideTyping() {
  if (!typingEl) return;
  typingEl.remove();
  typingEl = null;
}

function scrollDown(force) {
  const near = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 90;
  if (force || near) scroller.scrollTop = scroller.scrollHeight;
}

function setBusy(next) {
  busy = next;
  sendBtn.disabled = next;
  sendBtn.textContent = next ? "…" : "說";
}

function renderMood(m) {
  const chip = $("mood");
  chip.dataset.mood = m.mood;
  $("moodLabel").textContent = MOOD_LABEL[m.mood] ?? m.mood;

  const pips = $("moodPips").children;
  for (let i = 0; i < pips.length; i++) {
    pips[i].classList.toggle("on", i < m.intensity);
  }

  $("s-mood").textContent = MOOD_LABEL[m.mood] ?? m.mood;
  $("s-energy").style.width = `${Math.round(m.energy)}%`;
  $("s-hunger").style.width = `${Math.round(m.hunger)}%`;
}

function renderStats(s) {
  if (!s) return;
  const pct = Math.round((s.hitRate ?? 0) * 100);
  $("s-turns").textContent = String(s.turns ?? 0);
  $("s-cache").textContent = pct > 0 ? `${pct}%` : "—";
  $("s-saved").textContent = `$${(s.saved ?? 0).toFixed(4)}`;
  $("s-hitbar").style.width = `${pct}%`;
}

const REF = /^- \[\[([^\]]+)\]\]\s*(?:→\s*「(.*)」)?\s*$/;

function parseMemory(block) {
  const items = [];
  if (!block) return items;
  for (const line of block.split("\n")) {
    const m = REF.exec(line.trim());
    if (m) items.push({ ref: m[1], snip: m[2] ?? "" });
  }
  return items;
}

function renderMemory(block) {
  const box = $("s-mem");
  box.replaceChildren();
  const items = parseMemory(block);
  if (items.length === 0) {
    box.append(el("p", "none", "這次沒有想起什麼。"));
    return;
  }
  for (const item of items) {
    const link = el("a");
    link.href = "#";
    link.append(el("span", "ref", item.ref));
    if (item.snip) {
      const clean = item.snip.replace(/^-\s*\d{2}:\d{2}\s*/, "");
      link.append(el("span", "snip", clean));
    }
    link.addEventListener("click", (e) => e.preventDefault());
    box.append(link);
  }
}

function renderJournal(lines) {
  const box = $("s-journal");
  box.replaceChildren();
  if (!lines || lines.length === 0) {
    box.append(el("p", "none", "還沒有寫。"));
    return;
  }
  for (const line of lines.slice(-8)) {
    box.append(el("p", null, line.replace(/^-\s*/, "")));
  }
}

async function send(text) {
  const q = text.trim();
  if (!q || busy) return;

  setBusy(true);
  addMessage("me", q);
  showTyping();
  scrollDown(true);

  try {
    const res = await fetch("/api/turn", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: q }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    hideTyping();
    const segments = data.segments ?? [];

    for (let i = 0; i < segments.length; i++) {
      if (i > 0) {
        showTyping();
        await wait(340 + Math.random() * 380);
        hideTyping();
      }
      const last = i === segments.length - 1;
      const body = last && data.kaomoji ? `${segments[i]} ${data.kaomoji}` : segments[i];
      addMessage("her", body);
      if (data.voice) speakAloud(segments[i], data.tone);
      scrollDown(true);
      await wait(120);
    }

    if (data.whisper) {
      thread.append(el("div", "whisper", `（${data.whisper}）`));
      if (data.voice) speakAloud(data.whisper, "whisper", { whisper: true });
    }

    if (data.react) {
      thread.append(el("div", "react", data.react));
      scrollDown(true);
    }

    renderMood(data.mood);
    renderStats(data.stats);
    renderMemory(data.memory);
  } catch (err) {
    hideTyping();
    addMessage("sys", err instanceof Error ? err.message : String(err));
    scrollDown(true);
  } finally {
    setBusy(false);
    input.focus();
  }
}

function autosize() {
  input.style.height = "auto";
  input.style.height = `${Math.min(input.scrollHeight, 148)}px`;
}

input.addEventListener("input", autosize);

input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    const text = input.value;
    input.value = "";
    autosize();
    send(text);
  }
});

$("composer").addEventListener("submit", (e) => {
  e.preventDefault();
  const text = input.value;
  input.value = "";
  autosize();
  send(text);
});

thread.addEventListener("click", (e) => {
  const target = e.target;
  if (target instanceof HTMLElement && target.closest(".suggests button")) {
    const text = target.closest("button")?.textContent ?? "";
    if (text) send(text);
  }
});

statToggle.addEventListener("click", () => {
  const open = side.classList.toggle("open");
  statToggle.setAttribute("aria-expanded", String(open));
});

document.addEventListener("keydown", (e) => {
  if (e.key !== "Escape") return;
  if (sheet && !sheet.hidden) {
    if (sheetPicker && !sheetPicker.hidden) closePicker();
    else closeSettings();
    return;
  }
  if (side.classList.contains("open")) {
    side.classList.remove("open");
    statToggle.setAttribute("aria-expanded", "false");
  }
});

async function boot() {
  try {
    const res = await fetch("/api/state");
    const s = await res.json();
    for (const m of s.transcript ?? []) {
      addMessage(m.role === "user" ? "me" : "her", m.content);
    }
    renderMood(s.mood);
    renderStats(s.stats);
    renderJournal(s.journal);
  } catch {
    /* offline: the composer will surface a real error */
  }
  scrollDown(true);
  input.focus();
}

/* ---------- settings ---------- */

const sheet = $("sheet");
const scrim = $("scrim");
const sheetForm = $("sheetForm");
const sheetPicker = $("sheetPicker");

const cfg = { fields: [], values: {}, models: [], provider: "", providerName: "" };

let toastTimer = null;

function toast(text) {
  let node = document.querySelector(".toast");
  if (!node) {
    node = el("div", "toast");
    document.body.append(node);
  }
  node.textContent = text;
  node.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    node.hidden = true;
  }, 2800);
}

function closeSettings() {
  sheet.hidden = true;
  scrim.hidden = true;
  closePicker();
}

async function openSettings() {
  sheet.hidden = false;
  scrim.hidden = false;
  closePicker();

  sheetForm.hidden = false;
  sheetForm.replaceChildren(el("p", "none", "讀取中…"));

  try {
    const res = await fetch("/api/config");
    renderConfig(await res.json());
  } catch (err) {
    sheetForm.replaceChildren(el("p", "none", `讀不到設定：${err instanceof Error ? err.message : err}`));
  }
}

function renderConfig(data) {
  cfg.fields = data.fields ?? [];
  cfg.values = data.values ?? {};
  cfg.models = [];

  sheetForm.replaceChildren();

  for (const group of data.groups ?? []) {
    const fields = cfg.fields.filter((f) => f.group === group);
    if (fields.length === 0) continue;
    const section = el("section", "cfg-group");
    section.append(el("h3", null, group));
    for (const field of fields) section.append(fieldRow(field, cfg.values[field.key]));
    sheetForm.append(section);
  }

  const extra = data.extra ?? [];
  if (extra.length > 0) {
    const section = el("section", "cfg-group");
    section.append(el("h3", null, "其他"));
    for (const item of extra) {
      section.append(
        fieldRow(
          { key: item.key, label: item.key, type: "text", secret: item.secret, help: "不在表單裡的鍵" },
          { value: item.value, isSet: item.secret || item.value !== "" },
        ),
      );
    }
    sheetForm.append(section);
  }

  void loadModels(currentProvider());
}

function currentProvider() {
  const select = document.querySelector('[data-key="FISHD_PROVIDER"]');
  return select instanceof HTMLSelectElement ? select.value : "";
}

function modelInput() {
  const input = document.querySelector('[data-key="FISHD_MODEL"]');
  return input instanceof HTMLInputElement ? input : null;
}

async function loadModels(provider, clearMismatch = false) {
  cfg.provider = provider ?? "";

  try {
    const query = provider ? `?provider=${encodeURIComponent(provider)}` : "";
    const res = await fetch(`/api/models${query}`);
    const data = await res.json();
    cfg.models = Array.isArray(data.models) ? data.models : [];
    cfg.providerName = data.provider ?? "";
  } catch {
    cfg.models = [];
    cfg.providerName = "";
  }

  updateModelButton(clearMismatch);

  if (cfg.models.length > 0) {
    $("sheetHint").textContent = `${cfg.providerName} · ${cfg.models.length} 個模型可選`;
  } else if (clearMismatch) {
    $("sheetHint").textContent = "抓不到模型清單，用自訂輸入 id。";
  }
}

function updateModelButton(clearMismatch = false) {
  const input = modelInput();
  const button = document.querySelector('[data-pick="FISHD_MODEL"]');
  if (!input || !button) return;

  if (
    clearMismatch &&
    input.value !== "" &&
    cfg.models.length > 0 &&
    !cfg.models.includes(input.value)
  ) {
    $("sheetHint").textContent = `「${input.value}」不屬於 ${cfg.providerName}，已清空。`;
    input.value = "";
  }

  const label = button.querySelector(".model-value");
  const count = button.querySelector(".model-count");
  if (label) label.textContent = input.value || "（預設）";
  if (count) count.textContent = cfg.models.length > 0 ? `${cfg.models.length} 個` : "自訂";
}

function openPicker() {
  sheetForm.hidden = true;
  sheetPicker.hidden = false;

  $("pickerSearch").value = "";
  $("pickerManual").value = "";
  $("pickerTitle").textContent = cfg.providerName ? `選擇模型 · ${cfg.providerName}` : "選擇模型";

  renderPicker("");
  $("pickerSearch").focus();
}

function closePicker() {
  if (!sheetPicker) return;
  sheetPicker.hidden = true;
  if (sheetForm) sheetForm.hidden = false;
}

function renderPicker(query) {
  const list = $("pickerList");
  list.replaceChildren();

  const q = query.trim().toLowerCase();
  const current = modelInput()?.value ?? "";
  const models = cfg.models.filter((id) => q === "" || id.toLowerCase().includes(q));

  if (models.length === 0) {
    const message = cfg.models.length === 0 ? "沒有模型清單，用下面自訂。" : "沒有符合的模型。";
    list.append(el("p", "none", message));
    return;
  }

  for (const id of models) {
    const row = document.createElement("button");
    row.type = "button";
    row.className = id === current ? "picker-row current" : "picker-row";
    row.textContent = id;
    row.addEventListener("click", () => {
      const input = modelInput();
      if (input) input.value = id;
      updateModelButton();
      closePicker();
    });
    list.append(row);
  }
}

function fieldRow(field, state) {
  const wrap = el("div", "cfg-field");
  const id = `cfg-${field.key}`;
  const value = state?.value ?? "";
  const isSet = Boolean(state?.isSet);

  if (field.type === "bool") {
    const label = el("label", "switch");
    const input = document.createElement("input");
    input.type = "checkbox";
    input.id = id;
    input.dataset.key = field.key;
    input.checked = value === "1" || value === "true";
    label.append(input, el("span", "track"), el("span", null, field.label));
    wrap.append(label);
    if (field.help) wrap.append(el("p", "help", field.help));
    return wrap;
  }

  const label = el("label", null, field.label);
  label.htmlFor = id;
  wrap.append(label);

  if (field.type === "select") {
    const select = document.createElement("select");
    select.id = id;
    select.dataset.key = field.key;
    for (const option of field.options ?? []) {
      const node = document.createElement("option");
      node.value = option;
      node.textContent = option === "" ? "自動" : option;
      select.append(node);
    }
    select.value = value;
    wrap.append(select);
  } else {
    const input = document.createElement("input");
    input.id = id;
    input.dataset.key = field.key;
    input.type = field.secret ? "password" : field.type === "number" ? "number" : "text";

    if (field.type === "number") input.step = "any";

    if (field.secret) {
      input.dataset.secret = "1";
      input.placeholder = isSet ? "已設定，留空不變" : "未設定";
      input.autocomplete = "new-password";
    } else {
      input.value = value;
    }

    if (field.type === "model") {
      input.type = "hidden";
      input.value = value;

      const button = document.createElement("button");
      button.type = "button";
      button.className = "model-pick";
      button.dataset.pick = field.key;
      button.append(
        el("span", "model-value", value || "（預設）"),
        el("span", "model-count", "—"),
      );

      button.addEventListener("click", openPicker);
      wrap.append(input, button);
    } else {
      wrap.append(input);
    }
  }

  if (field.help) wrap.append(el("p", "help", field.help));
  return wrap;
}

function collectConfig() {
  const values = {};
  for (const input of document.querySelectorAll("[data-key]")) {
    const key = input.dataset.key;
    if (!key) continue;

    if (input.type === "checkbox") {
      values[key] = input.checked ? "1" : "0";
      continue;
    }

    const value = input.value.trim();
    if (input.dataset.secret === "1") {
      if (value !== "") values[key] = value;
      continue;
    }
    values[key] = value;
  }
  return values;
}

async function saveSettings() {
  const button = $("sheetSave");
  button.disabled = true;

  try {
    const res = await fetch("/api/config", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ values: collectConfig() }),
    });
    const data = await res.json();
    if (!res.ok) throw new Error(data.error ?? `HTTP ${res.status}`);

    $("sheetHint").textContent = `已儲存 ${data.changed?.length ?? 0} 項，重啟 npm run bot 才會生效。`;
    toast("已儲存 · 重啟後生效");
  } catch (err) {
    toast(err instanceof Error ? err.message : String(err));
  } finally {
    button.disabled = false;
  }
}

$("settingsBtn").addEventListener("click", openSettings);
$("sheetClose").addEventListener("click", closeSettings);
scrim.addEventListener("click", closeSettings);
$("sheetSave").addEventListener("click", saveSettings);

sheetForm.addEventListener("change", (event) => {
  const target = event.target;
  if (target instanceof HTMLSelectElement && target.dataset.key === "FISHD_PROVIDER") {
    void loadModels(target.value, true);
  }
});

$("pickerBack").addEventListener("click", closePicker);

$("pickerSearch").addEventListener("input", (event) => {
  const target = event.target;
  if (target instanceof HTMLInputElement) renderPicker(target.value);
});

$("pickerUse").addEventListener("click", () => {
  const manual = $("pickerManual");
  const id = manual instanceof HTMLInputElement ? manual.value.trim() : "";
  if (id === "") return;
  const input = modelInput();
  if (input) input.value = id;
  updateModelButton();
  closePicker();
});

boot();
