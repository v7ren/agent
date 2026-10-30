export type FieldType = "text" | "password" | "number" | "select" | "bool" | "model";

export interface Field {
  key: string;
  group: string;
  label: string;
  type: FieldType;
  options?: string[];
  help?: string;
  secret?: boolean;
  /** used when the key is absent from .env */
  defaultValue?: string;
}

export const GROUPS = ["模型", "人格", "Discord", "判斷者", "網頁"] as const;

export const FIELDS: Field[] = [
  {
    key: "FISHD_PROVIDER",
    group: "模型",
    label: "提供者",
    type: "select",
    options: ["", "opencode", "deepseek", "stub"],
    help: "留空 = 自動（有 DEEPSEEK_API_KEY 用它，否則用 OpenCode Go）",
  },
  {
    key: "FISHD_MODEL",
    group: "模型",
    label: "主模型",
    type: "model",
    help: "從清單挑，或直接打 id。Go: mimo-v2.6-flash｜deepseek-v4.1-flash（會先思考）",
  },
  {
    key: "FISHD_MAX_TOKENS",
    group: "模型",
    label: "回覆上限 tokens",
    type: "number",
    help: "思考型模型需要 600 以上（思考的 token 也吃這個額度，建議 2000+）",
  },
  {
    key: "FISHD_REASONING",
    group: "模型",
    label: "思考模式",
    type: "select",
    options: ["", "on", "off"],
    help: "DeepSeek 預設就開。off = 回得快、便宜，但變笨",
  },
  {
    key: "FISHD_REASONING_EFFORT",
    group: "模型",
    label: "思考深度",
    type: "select",
    options: ["", "low", "high", "max"],
    help: "留空 = 伺服器預設（high）。max = 最深，也最貴",
  },
  {
    key: "OPENCODE_API_KEY",
    group: "模型",
    label: "OpenCode 金鑰",
    type: "password",
    secret: true,
    help: "留空 = 直接讀 opencode 的 auth.json",
  },
  {
    key: "DEEPSEEK_API_KEY",
    group: "模型",
    label: "DeepSeek 金鑰",
    type: "password",
    secret: true,
    help: "填了之後，把上面的「提供者」設成 deepseek 才會用到它",
  },

  {
    key: "FISHD_PACK",
    group: "人格",
    label: "人格包",
    type: "select",
    help: "留空 = 預設人格。用 node src/bin.ts --import-dsh <repo> 匯入 DSH 人設",
  },
  {
    key: "FISHD_SHARE_DIR",
    group: "人格",
    label: "分享夾",
    type: "text",
    help: "gif／短片放這裡，她可以自己挑來傳。留空 = vault/share",
  },
  {
    key: "FISHD_STATIC_BUDGET",
    group: "人格",
    label: "人格 token 上限",
    type: "number",
    help: "core + rules + pasted 的總上限。放別人的長 prompt 時要調高",
  },
  {
    key: "DISCORD_NAMES",
    group: "人格",
    label: "叫她哪些名字",
    type: "text",
    help: "逗號分隔。被叫到一定回，不受判斷者影響",
  },
  {
    key: "FISHD_VOICE",
    group: "人格",
    label: "語音",
    type: "bool",
    defaultValue: "1",
    help: "桌寵／網頁偶爾會把回覆唸出來；關掉就只剩文字",
  },
  {
    key: "FISHD_VOICE_P",
    group: "人格",
    label: "語音機率",
    type: "number",
    help: "0-1，預設 0.5。1 = 每則都唸",
  },
  {
    key: "FISHD_VOICE_MAX",
    group: "人格",
    label: "語音最長字數",
    type: "number",
    help: "超過這個長度就不唸，避免長文被念成有聲書",
  },
  {
    key: "FISHD_WHISPER_P",
    group: "人格",
    label: "心聲機率",
    type: "number",
    help: "0-1。她偶爾會用小字冒出內心的話，0 = 關閉",
  },
  { key: "DISCORD_AMBIENT", group: "人格", label: "自己接話", type: "bool", defaultValue: "0" },
  {
    key: "DISCORD_TALK",
    group: "人格",
    label: "講話意願",
    type: "number",
    help: "1 = 預設。2 = 兩倍容易接話，3 = 很愛講。0.5 = 更安靜",
  },
  {
    key: "DISCORD_AMBIENT_COOLDOWN",
    group: "人格",
    label: "接話後安靜幾秒",
    type: "number",
    help: "接過一次話之後，同一個頻道至少隔這麼久才會再接。0 = 不限制",
  },
  {
    key: "DISCORD_BURST_MIN",
    group: "人格",
    label: "一次對話看幾分鐘",
    type: "number",
    help: "她會把這段時間內、從她上次開口之後的訊息一起讀，不是只讀最後一句",
  },
  { key: "DISCORD_ARM_MS", group: "人格", label: "決定後等幾毫秒才開口", type: "number" },
  { key: "DISCORD_SETTLE_MIN", group: "人格", label: "自己接話後安靜幾分鐘", type: "number" },
  {
    key: "DISCORD_SETTLE_BIAS",
    group: "人格",
    label: "安靜期要更難才回",
    type: "number",
    help: "1 = 不影響（Jev 自己判斷）；2 = 剛講過話時需要兩倍信心",
  },
  {
    key: "DISCORD_BUDGET",
    group: "人格",
    label: "沉默預算",
    type: "text",
    help: "格式 次數/分鐘，例如 4/30 = 每 30 分鐘最多主動接 4 次",
  },
  {
    key: "DISCORD_SPONTANEOUS",
    group: "人格",
    label: "自己冒出來",
    type: "bool",
    defaultValue: "0",
    help: "沒人講話時，她也會偶爾自己開口（凌晨 1–6 點不會）",
  },
  {
    key: "DISCORD_SPON_CHANNELS",
    group: "人格",
    label: "冒出來的地方",
    type: "text",
    help: "逗號分隔頻道 id。留空 = 用「每句都回」的頻道",
  },
  {
    key: "DISCORD_SPON_DM",
    group: "人格",
    label: "也會私訊主人",
    type: "bool",
    defaultValue: "1",
    help: "自己冒出來的時候，也可能主動私訊主人",
  },
  { key: "DISCORD_SPON_DM_MIN", group: "人格", label: "私訊最短間隔（分）", type: "number" },
  { key: "DISCORD_SPON_DM_MAX", group: "人格", label: "私訊最長間隔（分）", type: "number" },
  {
    key: "DISCORD_SPON_DM_QUIET",
    group: "人格",
    label: "私訊要安靜幾分鐘",
    type: "number",
    help: "你多久沒說話她才會主動私訊。設 0 = 不管",
  },
  {
    key: "DISCORD_SPON_HUSH",
    group: "人格",
    label: "不主動的時段",
    type: "text",
    help: "例如 1-6（凌晨 1 點到 6 點不主動）；off = 不限制",
  },
  { key: "DISCORD_SPON_MIN", group: "人格", label: "最短間隔（分）", type: "number" },
  { key: "DISCORD_SPON_MAX", group: "人格", label: "最長間隔（分）", type: "number" },
  {
    key: "DISCORD_SPON_QUIET",
    group: "人格",
    label: "頻道要安靜幾分鐘",
    type: "number",
    help: "避免打斷正在聊的人",
  },
  {
    key: "DISCORD_AMBIENT_P",
    group: "人格",
    label: "接話基準機率",
    type: "number",
    help: "只有 heuristic 判斷者會用到，0～1",
  },

  { key: "DISCORD_TOKEN", group: "Discord", label: "Bot Token", type: "password", secret: true },
  {
    key: "DISCORD_CHANNEL_IDS",
    group: "Discord",
    label: "每句都回的頻道",
    type: "text",
    help: "逗號分隔的頻道 id",
  },
  { key: "DISCORD_GUILD_IDS", group: "Discord", label: "只服務這些伺服器", type: "text" },
  {
    key: "DISCORD_DM_USERS",
    group: "Discord",
    label: "私訊只回這些人",
    type: "text",
    help: "逗號分隔的 user id。留空 = 任何人的私訊都回",
  },
  { key: "DISCORD_DMS", group: "Discord", label: "回應私訊", type: "bool", defaultValue: "1" },
  {
    key: "DISCORD_OWNER_IDS",
    group: "Discord",
    label: "主人（bot 擁有者）",
    type: "text",
    help: "逗號分隔的 user id。留空 = 沿用上面「私訊只回這些人」。對主人會更主動、更黏",
  },
  {
    key: "DISCORD_SINGLE_SESSION",
    group: "Discord",
    label: "所有頻道共用一個對話",
    type: "bool",
    defaultValue: "0",
    help: "開啟後她在 A 頻道說的、私訊說的，全部是同一段記憶（隱私上要小心）",
  },
  {
    key: "DISCORD_PING",
    group: "Discord",
    label: "會 ping 我",
    type: "bool",
    defaultValue: "0",
    help: "回你時真的標記你；自己冒出來時第一句會 @ 你（真的會吵）",
  },
  {
    key: "DISCORD_ONLY_CHANNELS",
    group: "Discord",
    label: "只在這些頻道出現",
    type: "text",
    help: "填了之後，其他頻道連 @ 她都不理",
  },
  {
    key: "DISCORD_IGNORE_USERS",
    group: "Discord",
    label: "封鎖這些人",
    type: "text",
    help: "逗號分隔的 user id，任何地方都不回",
  },
  { key: "DISCORD_REPLY_ALL", group: "Discord", label: "所有訊息都回", type: "bool", defaultValue: "0" },

  {
    key: "FISHD_GATE",
    group: "判斷者",
    label: "模式",
    type: "select",
    options: ["chain", "jev", "llm", "heuristic"],
    help: "chain = Jev → OpenRouter → 主模型 → heuristic",
  },
  { key: "JEV_MODEL", group: "判斷者", label: "Jev 模型", type: "text", help: "回傳插話機率" },
  {
    key: "JEV_TO_ME_BONUS",
    group: "判斷者",
    label: "被對著說話的加成",
    type: "number",
    help: "句子是在對她說時，門檻除以 (1+這個值)。0.5 = 門檻變 2/3",
  },
  {
    key: "JEV_NOT_ME_PENALTY",
    group: "判斷者",
    label: "對別人說話的懲罰",
    type: "number",
    help: "看起來是在對另一個真人說話時，門檻乘上 (1+這個值)",
  },
  {
    key: "JEV_THRESHOLD",
    group: "判斷者",
    label: "Jev 門檻",
    type: "number",
    help: "0.32 會接吃的話題，0.45 更安靜",
  },
  {
    key: "JEV_AIMED_BIAS",
    group: "判斷者",
    label: "別人之間的對話要更有把握才插話",
    type: "number",
    help: "有人 @ 另一個人、沒叫她時，Jev 的門檻再乘上這個值。1 = 不特別對待；2.5 = 預設；很大 = 幾乎不插嘴",
  },
  { key: "JEV_TIMEOUT_MS", group: "判斷者", label: "Jev 逾時", type: "number" },
  {
    key: "GATE_BASE_URL",
    group: "判斷者",
    label: "第二層端點",
    type: "text",
    help: "OpenAI 相容；留空則不啟用",
  },
  { key: "GATE_API_KEY", group: "判斷者", label: "第二層金鑰", type: "password", secret: true },
  { key: "GATE_MODELS", group: "判斷者", label: "第二層模型", type: "text", help: "逗號分隔，依序嘗試" },
  { key: "GATE_MAX_TOKENS", group: "判斷者", label: "第二層上限 tokens", type: "number" },
  { key: "GATE_TIMEOUT_MS", group: "判斷者", label: "第二層逾時", type: "number" },
  { key: "GATE_MAX_PER_MIN", group: "判斷者", label: "每分鐘最多判斷次數", type: "number" },

  { key: "FISHD_PORT", group: "網頁", label: "連接埠", type: "number" },
  {
    key: "FISHD_WEB",
    group: "網頁",
    label: "跑 Bot 時一起開網頁",
    type: "bool",
    help: "關掉就只有 Discord，沒有設定頁",
    defaultValue: "1",
  },
];

export function fieldOf(key: string): Field | undefined {
  return FIELDS.find((f) => f.key === key);
}

export const SECRET_KEYS = FIELDS.filter((f) => f.secret).map((f) => f.key);
