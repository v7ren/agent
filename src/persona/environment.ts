// One line that tells the companion where she lives: which machine, which
// brain, and how long she has been awake. It never carries hostnames, user
// names, file paths, IPs, or env values.

export type EnvironmentArgs = {
  platform: string;
  provider: string;
  model: string;
  startedAt: Date;
  now: Date;
};

const PLACES = new Map<string, string>([
  ["win32", "Windows 電腦"],
  ["darwin", "Mac"],
  ["linux", "Linux 主機"],
]);

const FALLBACK_PLACE = "電腦";
const TAG_MAX = 40;

// Anything that looks like a URL, a drive path, an absolute or relative path,
// or an IPv4 address is dropped rather than shown.
const PATHLIKE = /:\/\/|^[A-Za-z]:|^\/|^\.{1,2}\/|\/\/|\b\d{1,3}(?:\.\d{1,3}){3}\b/;

function place(platform: string): string {
  return PLACES.get(platform) ?? FALLBACK_PLACE;
}

function tag(raw: string): string {
  const cleaned = raw.replace(/[^A-Za-z0-9._:/-]/g, "").slice(0, TAG_MAX);
  if (cleaned === "" || PATHLIKE.test(cleaned)) return "";
  return cleaned;
}

function uptime(startedAt: Date, now: Date): string {
  const ms = Math.max(0, now.getTime() - startedAt.getTime());
  if (!Number.isFinite(ms)) return "不到 1 分鐘";
  const minutes = Math.floor(ms / 60_000);
  if (minutes < 1) return "不到 1 分鐘";
  if (minutes < 60) return `${minutes} 分鐘`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小時`;
  return `${Math.floor(hours / 24)} 天`;
}

export function renderEnvironment(args: EnvironmentArgs): string {
  const where = `跑在主人自己的${place(args.platform)}上（不是雲端）`;
  const model = tag(args.model);
  const provider = tag(args.provider);

  let brain = "";
  if (model && provider) brain = `，用的腦是 ${model}（${provider}）`;
  else if (model) brain = `，用的腦是 ${model}`;
  else if (provider) brain = `，用的腦來自 ${provider}`;

  const memory = "你的記憶是這台電腦裡 vault 資料夾的檔案，換機器要連 vault 一起搬才不會少東西";
  const awake = `這次已經醒了 ${uptime(args.startedAt, args.now)}`;

  return `（你的所在：${where}${brain}；${memory}；${awake}。）`;
}
