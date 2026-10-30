const petEl = document.getElementById("pet");
const bubble = document.getElementById("bubble");
const shareEl = document.getElementById("share");
const chat = document.getElementById("chat");
const input = document.getElementById("input");
const sprite = document.getElementById("sprite");
const placeholder = document.getElementById("placeholder");

let bubbleTimer = null;
let shareTimer = null;
let frameTimer = null;
let frames = null;
let frameIndex = 0;
let scaleX = 1;
let soundOn = true;
let chatting = false;
let hovering = false;

const MOODS = ["genki", "sleepy", "hungry", "tsundere"];
const TONE_PROFILE = {
  softcute: { rate: 0.94, pitch: 1.12 },
  playful: { rate: 1.02, pitch: 1.18 },
  healing: { rate: 0.9, pitch: 1.04 },
  energetic: { rate: 1.14, pitch: 1.22 },
  whisper: { rate: 0.82, pitch: 0.98 },
};

function applyMood(mood) {
  for (const name of MOODS) petEl.classList.remove(`mood-${name}`);
  if (MOODS.includes(mood)) petEl.classList.add(`mood-${mood}`);
}

function stopSpeaking() {
  if ("speechSynthesis" in window) window.speechSynthesis.cancel();
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

function showShare(share) {
  if (!share || !share.url) return;
  clearTimeout(shareTimer);
  shareEl.src = `${window.pet.api}${share.url}`;
  shareEl.classList.remove("hidden");
  shareTimer = setTimeout(() => shareEl.classList.add("hidden"), 9000);
}

function setState(name) {
  petEl.classList.remove("idle", "walk", "talk", "eat");
  petEl.classList.add(name);
  if (frames && frames[name]) {
    clearInterval(frameTimer);
    frameIndex = 0;
    const list = frames[name];
    sprite.src = `assets/${list[0]}`;
    if (list.length > 1) {
      frameTimer = setInterval(() => {
        frameIndex = (frameIndex + 1) % list.length;
        sprite.src = `assets/${list[frameIndex]}`;
      }, Math.round(1000 / (frames.fps || 6)));
    }
  }
}

function say(text, { whisper = false, ms = 5200 } = {}) {
  clearTimeout(bubbleTimer);
  bubble.textContent = text;
  bubble.classList.toggle("whisper", whisper);
  bubble.classList.remove("hidden");
  bubbleTimer = setTimeout(() => bubble.classList.add("hidden"), ms);
}

function setFacing(direction) {
  scaleX = direction < 0 ? -1 : 1;
  petEl.style.transform = `scaleX(${scaleX})`;
}

async function loadManifest() {
  try {
    const res = await fetch("assets/manifest.json");
    const manifest = await res.json();
    const states = manifest.states || {};
    const hasFrames = Object.values(states).some((list) => Array.isArray(list) && list.length > 0);
    if (!hasFrames) return;

    frames = { ...states, fps: manifest.fps || 6 };
    sprite.style.display = "block";
    placeholder.style.display = "none";
    setState("idle");
  } catch {
    /* keep the built-in fish */
  }
}

function feed(name) {
  const lines = {
    rice: "白飯！本鯨的碗呢？",
    fish: "小魚乾……哼，勉強吃一口。",
    cake: "蛋糕？誰生日？",
    melon: "西瓜！挖中間那口給我。",
  };
  const line = lines[name] || "……這是什麼？";
  stopSpeaking();
  setState("eat");
  say(line);
  speakAloud(line, "playful");
  setTimeout(() => setState("idle"), 1400);
}

async function talk(text) {
  stopSpeaking();
  setState("talk");
  say("……", { ms: 60000 });

  const result = await window.pet.say(text);
  if (!result.ok) {
    say(`連不上 fishd（${result.error}）。先開 npm run bot。`, { ms: 8000 });
    setState("idle");
    return;
  }

  const data = result.data;
  applyMood(data.mood?.mood ?? data.mood);
  const segments = Array.isArray(data.segments) ? data.segments : [];
  for (let i = 0; i < segments.length; i++) {
    const last = i === segments.length - 1;
    const body = last && data.kaomoji ? `${segments[i]} ${data.kaomoji}` : segments[i];
    say(body);
    if (data.voice) speakAloud(segments[i], data.tone);
    await new Promise((resolve) => setTimeout(resolve, 700));
  }

  if (data.whisper) {
    setTimeout(() => say(data.whisper, { whisper: true, ms: 4000 }), 400);
    if (data.voice) speakAloud(data.whisper, "whisper", { whisper: true });
  }

  showShare(data.share);
  setState("idle");
}

/* ---- interaction ---- */

let down = null;
let moved = false;

function overInteractive(x, y) {
  const el = document.elementFromPoint(x, y);
  return Boolean(el && el.closest && el.closest("#pet, #bubble, #chat, #share"));
}

function setHover(next) {
  if (next === hovering) return;
  hovering = next;
  window.pet.hover(next);
}

function setChatting(next) {
  chatting = next;
  chat.classList.toggle("hidden", !next);
  if (next) {
    setHover(true);
    input.focus();
  } else {
    input.blur();
    setHover(overInteractive(-1, -1));
  }
}

petEl.addEventListener("mousedown", (event) => {
  if (event.button !== 0) return;
  setHover(true);
  down = { x: event.screenX, y: event.screenY };
  moved = false;
  petEl.classList.add("dragging");
  window.pet.dragStart({ x: event.screenX, y: event.screenY });
});

window.addEventListener("mousemove", (event) => {
  setHover(chatting || overInteractive(event.clientX, event.clientY));
  if (!down) return;
  if (Math.abs(event.screenX - down.x) > 4 || Math.abs(event.screenY - down.y) > 4) {
    moved = true;
  }
});

window.addEventListener("mouseleave", () => {
  if (!chatting) setHover(false);
});

window.addEventListener("mouseup", () => {
  if (!down) return;
  down = null;
  petEl.classList.remove("dragging");
  window.pet.dragEnd();

  if (!moved) {
    setState("talk");
    say("……怎麼了？");
    setTimeout(() => setState("idle"), 1200);
    setChatting(!chatting);
  }
});

window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && chatting) setChatting(false);
});

petEl.addEventListener("dblclick", () => {
  feed("rice");
});

window.addEventListener("contextmenu", (event) => {
  event.preventDefault();
  window.pet.menu();
});

chat.addEventListener("submit", (event) => {
  event.preventDefault();
  const text = input.value.trim();
  if (text === "") return;
  input.value = "";
  void talk(text);
});

window.pet.onFeed(feed);
window.pet.onSpeak(async () => {
  stopSpeaking();
  setState("talk");
  say("……", { ms: 60000 });
  try {
    const result = await window.pet.spontaneous();
    if (!result.ok) throw new Error(result.error);
    const data = result.data;
    applyMood(data.mood?.mood ?? data.mood);
    const segments = Array.isArray(data.segments) ? data.segments : [];
    for (const segment of segments) {
      say(segment);
      if (data.voice) speakAloud(segment, data.tone);
      await new Promise((r) => setTimeout(r, 700));
    }
    if (data.whisper) {
      setTimeout(() => say(data.whisper, { whisper: true, ms: 4000 }), 400);
      if (data.voice) speakAloud(data.whisper, "whisper", { whisper: true });
    }
    showShare(data.share);
  } catch {
    say("連不上 fishd。先開 npm run bot。", { ms: 8000 });
  } finally {
    setState("idle");
  }
});
window.pet.onChat(() => {
  setChatting(true);
});
window.pet.onMode(({ mode, sound }) => {
  soundOn = sound !== false;
  if (!soundOn) stopSpeaking();
  if (mode !== "follow") setFacing(1);
  setState(mode === "free" ? "walk" : "idle");
});
window.pet.onFacing((direction) => setFacing(direction));

void loadManifest();
setState("idle");
