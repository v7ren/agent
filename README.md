# fishd

一個「會聊天、會記得、會自己長狀態」的陪伴型 Agent harness。

它把幾件通常混在一起的東西拆開：

- **人格**：`vault/persona/` 的 Markdown，重載不用重啟。
- **大腦**：OpenAI-compatible provider（DeepSeek、OpenCode Go、stub）。
- **記憶**：Obsidian 風格的 vault（journal、diary、people、checkpoint）。
- **身體**：mood、self、drives、presence、pace，存在 `vault/state/`。
- **社交判斷**：Discord 的 JEV／LLM／heuristic gate，決定她要不要插話。
- **通道**：Discord、Web、CLI、Electron 桌寵，以及 dsh-pet 的 OpenAI／Agent Link 介面。

---

## 目錄

- [快速開始](#快速開始)
- [整體架構](#整體架構)
- [一次回覆的完整流程](#一次回覆的完整流程)
- [JEV 怎麼運作](#jev-怎麼運作)
- [Prompt、預算與快取](#prompt預算與快取)
- [Vault：那些 JSON 與 MD 在幹嘛](#vault那些-json-與-md-在幹嘛)
- [工具](#工具)
- [Sandbox 外掛](#sandbox-外掛)
- [Hooks（規劃）](#hooks規劃)
- [通道與桌寵](#通道與桌寵)
- [設定](#設定)
- [測試與已知限制](#測試與已知限制)

---

## 快速開始

需求：Node.js >= 22.18。

```bash
cp .env.example .env
npm install

npm start          # 終端機聊天
npm run web        # 只開網頁介面
npm run bot        # Discord + 網頁
npm run pet        # Electron 桌寵
```

常用一次性指令：

```bash
node src/bin.ts --check          # 看 provider、gate、人格 token 數
node src/bin.ts --say "在嗎"      # 單次回覆
node src/bin.ts --diary          # 寫昨天的日記
node src/bin.ts --migrate        # 舊 journal 格式遷移
node src/bin.ts --import-dsh <dir-or-git-url>  # 匯入 DSH 人格包
```

驗證：

```bash
npm test           # 520 tests
npm run typecheck
```

---

## 整體架構

```
Discord ──┐
Web UI ───┼──> channel 層（scope / burst / gate / spontaneous）
CLI ──────┤
dsh-pet ──┘
              │
              ▼
        Agent（src/core/loop.ts）
              │
    ┌─────────┼──────────┬─────────────┐
    ▼         ▼          ▼             ▼
 mood/self  drives    memory        provider
 presence   keep      vaultMemory   OpenAI-compatible
 pace       tune      journal       tools / streaming
    │         │          │             │
    └─────────┴──────────┴─────────────┘
              │
              ▼
        vault/（Markdown + JSON）
```

核心目錄：

| 路徑 | 工作 |
|---|---|
| `src/core/loop.ts` | Agent 主迴圈：tick、prompt、tool、表達、持久化、compact |
| `src/core/assemble.ts` | 把 static／stable／chain／hot／tip 組成 messages，維持 prefix hash |
| `src/core/provider.ts` `openai.ts` | provider 選擇、OpenAI-compatible 呼叫、串流、reasoning |
| `src/core/window.ts` `budget.ts` | token 估算、hot window、chain 裁切、compaction 計畫 |
| `src/channels/discord.ts` | Discord 入口：scope、硬觸發、ambient、spontaneous、送出 |
| `src/channels/gate.ts` | JEV、LLM、heuristic、fallback chain |
| `src/memory/` | journal、diary、people、checkpoint、index、compaction |
| `src/persona/` | persona、mood、self、drives、presence、pace、ignore、decline、tune |
| `src/web/` | Web UI、`/api/*`、OpenAI-compatible `/v1/*`、設定頁 |
| `vault/` | 人格、記憶、狀態、分享素材；人類可讀 |

---

## 一次回覆的完整流程

### 1. 進站：誰可以碰到她

Discord 的 `onMessage()` 會先做這幾件事：

1. 只收 DM 或 guild 訊息；忽略 bot 與自己。
2. `scope.ts` 的硬邊界：`DISCORD_IGNORE_USERS`、`DISCORD_DMS`、`DISCORD_DM_USERS`、`DISCORD_ONLY_CHANNELS`。
3. 讀文字；如果只是 tag 她、沒有內容，就當成一句「@她」的招呼。
4. `agent.logHeard()`：**先寫 journal**，即使她最後不回，也聽到了。
5. `IgnoreBook`：她臨時不想理的人，連 @ 都不回（主人除外）。
6. 判斷是「硬觸發」還是「要不要插話」。

### 2. 硬觸發：一定要回

符合以下任一條件就是硬觸發：

- 私訊
- `@她`
- 回覆她的訊息
- 叫她的名字（`DISCORD_NAMES`）
- 在 `DISCORD_CHANNEL_IDS` 裡
- `DISCORD_REPLY_ALL=1`

但如果訊息明顯是 `@另一個人`、且沒有叫她，**不算硬觸發**；它會走 ambient 判斷。

硬觸發會进 `enqueue()`（同一時間只跑一個 turn）。非主人有 token bucket：**6 次／5 分鐘**。佇列滿了（8 個）會回一句「人太多了，等一下再找我」。

### 3. Ambient：沒叫她，她要不要自己接

先把她最近聽到的訊息放進 burst（預設 10 分鐘、最多 12 則），再問 gate。

`considerAmbient()` 的順序：

1. 同頻道冷卻（`DISCORD_AMBIENT_COOLDOWN`）
2. 這個頻道是否已經有排定的插話
3. 同時最多 3 個 gate 在跑
4. **gate 決定要不要**
5. 沉默預算（`DISCORD_BUDGET`，例如 `12/30`＝30 分鐘內最多 12 次主动插話）
6. `arm`：先決定，等 `DISCORD_ARM_MS` 毫秒後才真的送出
7. `pounce()`：用整個 burst 回，不是只回最後一句

`DISCORD_SETTLE_MIN` 是她自己插話後的安靜時間；`DISCORD_SETTLE_BIAS` 可在安靜期提高 gate 門檻。

### 4. Spontaneous：沒人講話，她自己冒出來

`spontTick()` 每 30 秒跑一次，兩條路：

- **她自己排的計畫**：`self {"plan_minutes":…}`；到點優先執行。
- **一般 spontaneous timer**：每個頻道／主人 DM 各自有 `min–max` 間隔。

送出前會檢查：

- `DISCORD_SPON_HUSH`（預設不主動的時段，例如 `2-7`）
- `DISCORD_SPON_QUIET` / `DISCORD_SPON_DM_QUIET`（房間要安靜多久）
- 她是否 `sleeping`（自己選的睡眠）
- 是否在允許的 spontaneous 頻道／主人 DM

Spontaneous 不看 JEV；它是「她自己想講」，不是「判斷要不要插話」。

### 5. Agent turn：真正生成回覆

`runTurn()` 的順序：

1. `tickSelf()`：boredom／longing／睡眠推進；有人講話就 `touchSelf()`。
2. `drives.tick()`：自訂數值（想念、餓、想被誇…）成長，跨門檻會標記 `pendingWake`。
3. `tick(mood)`：energy／hunger／睡眠／tease。
4. 重載 persona（`personaLoader`）；有變就重置 prefix 保護。
5. 組 tip（**唯一每輪都會變的區塊**）：
   - recall 指標（一般 2 個 pointer；另有自動 recall：最多 5 個片段／820 字，會跳過已在前文出現的內容）
   - 多人頻道的 roster
   - 對目前這個人的關係摘要
   - persona notes
   - 主人／陌生人／多人頻道提示
   - self（boredom、longing、睡眠、plan、pending、marks）
   - drives／keeps／tune
   - awareness（delivery、ignore、offline、environment、conversation end、tone、pace、昨天日記）
   - mood
   - 現在時間
6. `assemble()`：static → stable → checkpoint chain → hot → tip。
7. `provider.chat()`：最多 4 輪 tool loop；每輪最多執行 4 個 tool call。
8. `parseExpression()`：讀 `::state`（mood／intensity／why／feel／segments／tone／react／whisper）。
9. 表達：mood nudge、顏文字、tone、voice、segments、whisper、share。
10. 持久化：history、mood.json、self.json、journal、cache；最後 `maybeCompact()`。

Tool 呼叫的訊息**不會進 history**，只有最後的文字回覆會進。這樣對話視窗不會被工具輸出塞滿。

### 6. 回覆長什麼樣

`::state` 是給程式看的，不是給對方看的。一般回覆只寫要說出口的話；需要改狀態時才在最後加一行：

```json
::state {"mood":"genki","intensity":2,"why":"被稱讚","feel":"happy","segments":2,"tone":"energetic"}
```

她也可以「拒絕回」：呼叫 `decline` tool，可以是一句短話或完全沉默；有每小時上限（預設 3 次，`FISHD_DECLINE_MAX_PER_HOUR`）。

---

## JEV 怎麼運作

JEV 是「System One」：它不是生成回覆，而是回答一個問題：

> 最後一則訊息之後，她現在應該插話嗎？

JEV 只在 **ambient** 路徑被呼叫。私訊、@她、回覆她、叫名字、固定頻道、`REPLY_ALL` 這些硬觸發會直接回，不會先問 JEV。

### Gate 模式

`FISHD_GATE`：

| 值 | 行為 |
|---|---|
| `heuristic` | 完全不呼叫模型，只用規則 |
| `jev` | JEV 機率 → heuristic fallback |
| `llm` | 主模型／OpenRouter 判斷 YES/NO → heuristic |
| `chain` | JEV → OpenRouter models → 主 provider → heuristic |

`chain` 是最完整的模式，也是目前 `.env.example` 的預設。

### JEV request

- Endpoint：`https://opencode.ai/inference/systemone/v1/systemone`
- Model：`JEV_MODEL`，預設 `jev-1.13-free`
- Key：`JEV_API_KEY`，沒有就用 `OPENCODE_API_KEY`／opencode auth.json
- Timeout：`JEV_TIMEOUT_MS`，預設 4000ms

送出的 state 包含：

- 最近 10 則訊息（舊到新）
- 大家叫她的名字
- 距離她上次開口幾分鐘
- 她的人設與「不是助理、預設安靜」的指示

然後問兩個 `noul`（0..1 機率）問題：

| 問題 | 欄位 | 意思 |
|---|---|---|
| 她現在該插話嗎？ | `answers.speak.noul` | P(speak) |
| 最後一則是在對她說嗎？ | `answers.to_me.noul` | P(addressed) |

`to_me` 缺失時當 0。

### 決策公式

```text
base = clamp(JEV_THRESHOLD / DISCORD_TALK, 0.02, 0.95)

factor = max(
  0.25,
  1 + JEV_TO_ME_BONUS * to_me
    - JEV_NOT_ME_PENALTY * (1 - to_me)
)

threshold = base * max(1, bias) / factor

speak = p_speak >= threshold
```

`bias` 來自：

```text
bias = settleBias
     * (她正在摸魚 ? 1.6 : 1)
     * (這句明顯是對別人說 ? JEV_AIMED_BIAS : 1)
```

所以：

- 被對著說話 → `to_me` 高 → 門檻下降。
- 明顯在跟另一個真人聊 → `JEV_AIMED_BIAS`（預設 2.5）把門檻拉高。
- 剛插過話（settle）→ 門檻再高。
- 她說自己在摸魚 → 門檻再高。

以預設 `JEV_THRESHOLD=0.32`、`DISCORD_TALK=1` 為例，base 是 0.32；若 `to_me=0.8`、bonus 0.5、penalty 0.35，factor 約 1.33，門檻降到 0.24。若這句是對別人說，bias 2.5，門檻變 0.6。

### Fallback

JEV 任何失敗（沒有 key、timeout、HTTP error、回傳不是機率）都會掉到下一個 gate：

```text
JEV
  └─ OpenRouter models（依序，每個有 6/分鐘上限）
       └─ 主 provider LLM（YES/NO，6/分鐘）
            └─ heuristic
```

所以 gate 壞掉不會讓整個 bot 沉默；最差就是回到啟發式規則。

### Heuristic fallback

`ambientChime()`：

- 訊息 < 4 字 → 不接
- 叫她的名字 → 一定接
- 剛講過話的冷卻內 → 不接
- 問句 → 機率提高
- 兩個不同人在對話 → 機率略降
- 用 message id 做 deterministic seed，所以同一則訊息重播結果一致

`DISCORD_AMBIENT_P` 是 heuristic 的基準機率；`DISCORD_TALK` 會再乘上去。

### 觀察 JEV

- `node src/bin.ts --check` 會印 gate chain、實際 verdict、`p` 與 threshold。
- 執行中的 log 會有 `gate Jev 要插話／不插話`。
- `JevGate` 會保留 `lastProbability` 與 `lastToMe` 給檢查用。

---

## Prompt、預算與快取

### 五層

| 層 | volatility | 內容 | 預設預算 | 特性 |
|---|---|---|---|---|
| static | 0 | persona core／rules／protocol／pack | 4000 tok | 絕不變；超過直接報錯 |
| stable | 1 | 長期 profile／人物摘要 | 900 tok | 目前保留，實務上為空 |
| chain | 2 | checkpoint 摘要 | 12000 tok（大 window）／8000（舊模式） | append-only；太長從中間丟 |
| hot | 3 | 最近對話 | 125000 tok（大 window）／12000（舊模式） | 大 window 由 compact 控制；舊模式從最舊開始丟 |
| tip | 4 | recall／state／mood／clock | 1500 tok | 接在最後一則 user 訊息後面 |

**目前 `bin.ts` 預設使用大 window**：

- `FISHD_CONTEXT_TOKENS` 預設 100,000；`FISHD_COMPACT_KEEP` 預設 0.3。
- `hardLimit()` 是 125,000（limit × 1.25），所以 hot 層預算會拉到 125,000；chain 拉到 12,000。
- 理論上單次 prompt 上限約 4000 + 900 + 12000 + 125000 + 1500 = **143,400 tokens**；實際會由 compaction 壓在 100k 附近，tool schema 另計。
- `FISHD_CONTEXT_TOKENS=0` 或 `off` 會回到舊的 24 輪模式：hot 12,000、chain 8,000，合計約 **26,400 tokens**；此時才看 `FISHD_HOT_TURNS`。

### Prefix cache

`assemble()` 只把 static＋stable 算進 `prefixHash`。這確保：

- 只有 static／stable 變動才會 cache miss。
- chain、hot、tip 可以自由變，不會破壞 prefix。
- 如果 static 偷偷混進 volatile 內容，`strictPrefix` 會直接丟錯，而不是默默讓 cache 失效。

persona 檔案熱重載時，`lastPrefix` 會刻意歸零，避免「改一次 core.md 就每一輪都 prefix changed」。

### Compaction

目前 `bin.ts` 預設使用 **token-window 模式**：

- `windowFromEnv()` 讀 `FISHD_CONTEXT_TOKENS`（預設 100000）與 `FISHD_COMPACT_KEEP`（預設 0.3）。
- 當 history + system 超過 100k，`planCompaction()` 從最舊開始切，讓剩下的內容落在 window 的 30% 左右；切點會對齊 user 訊息，至少保留最後兩則。
- `compactWindow()` 會把切掉的那段做結構化壓縮：
  - 最多 15 條 summary
  - 最多 8 條「還沒完」
  - 最多 8 條人物事實（note／habit／joke／pending／impression）
  - 寫成 `vault/sessions/<scope>/cp-NNN.md`
  - 把人物事實寫回 `vault/nodes/people/<id>.md`
- checkpoint 不覆寫舊檔；chain 太長時 `fitChain()` 保留頭與尾，丟中間。
- 壓縮是非同步 fire-and-forget；失敗保留原文，5 分鐘後再試。
- 一次壓縮最多 4 次 LLM 呼叫（分段 map＋reduce）。
- 最新對話會存到 `vault/state/history/<key>.json`，重啟後載回；同一個檔案旁的 `.roster.json` 記住房間裡有誰。
- `FISHD_CONTEXT_TOKENS=0`／`off` 會回到舊的 turn-count 模式：history 超過 48 則時，把最舊 24 則壓成 checkpoint。

### Token 估算與成本

- `estimateTokens()`：CJK 約 0.95 tok/字，拉丁約 3.6 字/tok。
- `CacheLog` 會記錄 hit／miss／output，DeepSeek 有價格表就換算 USD；其他 provider 顯示 unknown。
- `/stats` 與 CLI `/stats` 都會顯示 hit rate、成本、節省。

---

## Vault：那些 JSON 與 MD 在幹嘛

一個簡單原則：

- **MD = 給人或模型讀的記憶**：人格、journal、diary、人物、checkpoint、log。
- **JSON = 給程式讀的狀態**：mood、self、drives、keep、tune、pace、presence。
- **JSONL = 事件流**：dsh-pet 的 state bus。

### 人格與設定

| 路徑 | 內容 |
|---|---|
| `vault/persona/core.md` | 她是誰、住哪、基本性格 |
| `vault/persona/rules.md` | 回覆規則、語氣、長度、時間 |
| `vault/persona/protocol.md` | `::state` 格式、記憶地圖、self 指令 |
| `vault/persona/packs/<pack>/core.md` | 切換人格包（`FISHD_PACK`） |
| `vault/persona/notes.md` | 她自己的長期筆記（`persona_note`；檔案最多 12 條／700 字，prompt 只帶最新 4 條） |
| `vault/nodes/character/<name>.md` | 完整角色設定／世界觀，需要細節時用 memory 工具讀 |
| `.env` | 金鑰與行為設定，**不進 git** |
| `.env.example` | 設定模板 |

### 對話與記憶

| 路徑 | 內容 |
|---|---|
| `vault/journal/YYYY/MM/YYYY-MM-DD.md` | 逐字對話。一行一個時段；同一人 15 分鐘內連續訊息用 `／` 合併；她的回覆縮排放在下面 |
| `vault/diary/YYYY-MM-DD.md` | 她的第一人稱日記，約 300 字；由 journal 壓縮生成 |
| `vault/nodes/people/<id>.md` | 每個人的關係節點：frontmatter（closeness／warmth／grudge／impression）＋ `習慣`／`進行中`／`一起笑過`／`筆記` |
| `vault/sessions/<scope>/cp-NNN.md` | 對話 checkpoint：summary、`## 還沒完`、`## 連結`（journal／diary／people） |
| `vault/archive/` | 舊資料／遷移備份 |
| `vault/share/index.md` | 分享素材目錄：`- 檔名 | 標籤 | 一句說明` |
| `vault/share/<media>` | 她可以傳的 gif／圖／短片 |

Journal 範例：

```md
- 23:47 （私訊）[[people/123|ren]]：今天加班好累
　我：唔……辛苦了，飯吃了沒？（hungry）
```

### 執行時狀態（`vault/state/`）

| 檔案 | 內容 |
|---|---|
| `mood.json` | 心情、強度、energy、hunger、lastTick、override、tease |
| `self.json` | boredom、longing、lastSeen、睡眠、slacking、task、plan、pending、marks |
| `mood-log.md` | append-only 心情變化紀錄 |
| `self-log.md` | append-only 自我狀態變化紀錄 |
| `drives-rules.json` | 她自訂的數值規則：名稱、起始值、每小時增量、上限、門檻、跨門檻動作 |
| `drives-state.json` | 每個 drive 的目前值、峰值、lastTick、`pendingWake` |
| `keep.json` | 5–10 個「永久記得」的 slots；主人釘選的不能被她自己移除 |
| `tune-log.json` | 她調整 `.env` 的提案／已套用／已撤回紀錄 |
| `pace.json` | 每個人回覆延遲與長度的近期樣本，用來猜「他是不是累了」 |
| `presence.json` | 上次啟動是否還活著、最後心跳時間；用來算離線多久 |
| `pet-events.jsonl` | 給 dsh-pet 的 `thinking/working/idle/error` 事件流 |
| `history/<key>.json` | 大 window 模式：重啟後恢復最近對話（每 room／DM／global 一份） |
| `history/<key>.roster.json` | 大 window 模式的人員名冊，compact 時用來對人 |
| `fishd-run.log` / `*.err.log` | 執行 log，不進 git |
| `vault/voice-cache/` | TTS 快取（如果有用 `src/voice/speak.ts`） |

`drives-rules.json` 範例：

```json
{
  "rules": [
    {
      "name": "想他",
      "startValue": 0,
      "gainPerHour": 4,
      "gainOnUserMessage": -10,
      "max": 80,
      "threshold": 70,
      "onThreshold": "wake",
      "recordPeak": true,
      "quietHoursGain": 0.5
    }
  ]
}
```

`onThreshold` 只能是 `wake`（醒來）、`reset`（歸零）、`halve`（減半）。

`self.json` 的 `plan`／`pending`／`marks` 是她的「未說出口」與「小記號」：

- `plan`：幾分鐘後想主動找他。
- `pending`：有話沒說完，下次可以接。
- `marks`：想他時隨手留的小記號（最多 8 個），會進 prompt，也留在 `self-log.md`。

### 哪些不進 git

`.gitignore` 會排除：

- `.env`、`node_modules/`、log、PID
- `vault/state/`、`vault/journal/`、`vault/sessions/`、`vault/diary/`、`vault/archive/`
- `vault/nodes/people/`（個人資料）
- `vault/persona/notes.md`
- `vault/share/` 的媒體（保留 `index.md`）
- `pet/assets/` 的圖片、`pet/pet.config.json`

人格、角色設定、範例 `vault/share/index.md` 會進 git；真實對話與狀態不會。

---

## 工具

Tool 在 `converse()` 的 tool loop 裡執行；最多 4 輪，每輪最多 4 個 call。超過的呼叫會被回答 `skipped: too many calls`，不會留下孤兒 tool_call。

| 工具 | 做什麼 |
|---|---|
| `memory_search` | 搜 vault，回傳路徑＋行號＋短摘要（最多 8 個） |
| `memory_open` | 讀某個檔案片段（預設 40 行，最多 80 行，輸出 2000 字） |
| `memory_timeline` | 讀某一天的 journal（最後 40 筆，2000 字） |
| `memory_diary` | 讀某一天的 diary |
| `relationship` | 更新 person 節點：closeness／warmth／impression／habit／pending／joke／resolve／grudge |
| `self` | 改自己的狀態：mood、energy、hunger、boredom、longing、sleep、mark、task、plan、pending |
| `share` | 從 `vault/share` 挑一張圖／短片 |
| `persona_note` | 寫進 `vault/persona/notes.md`（長期事實，不是對話細節） |
| `ignore` | 暫時不理某個人（非主人；有時限） |
| `decline` | 拒絕回答；可選沉默 |
| `drive` | 管理自訂數值（list／set／remove／ack） |
| `keep` | 管理永久記事 slots（list／add／replace／remove） |
| `tune` | 調整少數行為設定；超出 soft range 要主人 `/tune approve` |

`FISHD_TOOLS=0` 可以完全關掉工具。

---

## Sandbox 外掛

`src/plugins/sandbox/` 讓她可以使用 Puppet Master 的 Potato Bot sandbox（預設 `pm-sbx-main`），不改 `core/loop.ts`、記憶、人設或 vault。外掛借用既有的 `DriveKit` 工具接口：`src/bin.ts` 只多一行 `sandboxDrives(CONFIG.stateDir)`。

關掉時（`FISHD_SANDBOX` 不是 `1`）完全沒有影響：工具不會出現，watcher 不會啟動。

### 啟用

```env
FISHD_SANDBOX=1
```

重啟 `npm run bot`／`npm run web` 後，工具才會進 prompt。舊進程不會熱載入。

### 她拿到什麼

| 工具 | 做什麼 |
|---|---|
| `sandbox_status` | 現在有沒有電腦：`available`／`pm_active`／`asleep`／`starting`／`not_set_up`，以及今天還剩幾個動作 |
| `computer_observe` | 看螢幕：尺寸、指標位置、前景視窗、畫面是否變了。這是唯讀，PM 正在用也可以看 |
| `computer_act` | 最多 24 個動作：move、click、double_click、drag、scroll、type、key、wait、launch（chrome／terminal／files／editor） |

### 行為與限制

- **PM 優先**：PM 最近 90 秒用過 sandbox 時，`computer_act` 會回 `PM_HAS_PRIORITY`；`observe` 仍可讀。等 PM 安靜後再試。
- **同一個 sandbox**：跟 Potato Bot 共用 `pm-sbx-main` 與 `47801`。token 從 guest 的 `/run/pm-sbx/control.token` 讀取；沒有時用 `~pm/.pm-sbx/control.token`。
- **每日上限**：500 個動作（`FISHD_SANDBOX_ACTIONS_PER_DAY`）。超過就整筆拒絕，不部分執行。
- **保活**：`npm run bot`／`web` 會在背景啟動 watcher。PM 閒置或關閉把 sandbox 停掉後，watcher 會把它開回來；fish 結束後 watcher 自己結束，不會永久佔用。`FISHD_SANDBOX_KEEPALIVE=0` 可關閉。log 在 `vault/state/plugins/sandbox/watch.log`。
- **只限主人**：沿用 `DriveKit` 的 owner 限制，陌生人不能操作。
- **不寫心智圖**：外掛狀態只在 `vault/state/plugins/sandbox/`，不寫 journal、diary、people、persona、mood、self。
- **同步限制**：fish 的 tool loop 是同步的，每次呼叫會啟動一次 `bridge.mjs`；呼叫期間 fish 會短暫阻塞（通常數百毫秒，截圖或頁面動作可能數秒）。
- **PM 重啟** 會終止 sandbox，fish 進程不死，watcher 會重開；`/home/pm` 的檔案會保留，執行中的程式不會。
- **沒有 shell／檔案工具**：目前只有螢幕與動作。shell、讀寫檔案、安裝套件是下一步；在共用的 sandbox 上不要用 root 繞過 PM 的設計。

---

## Hooks（規劃）

目前尚未實作。目標是讓她可以自己排「等某件事發生再動作」，例如：

```text
hook add { when: "sandbox_ready", prompt: "沙箱好了就打開 Chrome 檢查 X", notify: true }
```

條件成立後由一個 runner 以 spontaneous turn 喚醒她，她可以在同一輪直接呼叫 sandbox 工具，不需要使用者再說話。會沿用同一個 `DriveKit` 接口與 Discord 的 `proactive` 路徑，不改 core、記憶或人設。

規劃中的條件：`sandbox_ready`、`sandbox_stopped`、`after_minutes`、`at`、`file_exists`。限制：只限主人、最多 20 個、每小時最多 6 次喚醒、預設 24 小時過期、單次觸發。

---

## 通道與桌寵

### Discord

主要入口。支援：

- DM、@、回覆、叫名字、固定頻道、`REPLY_ALL`
- ambient 插話（JEV）
- spontaneous（自己開話題、主動 DM 主人）
- `/mood` `/stats` `/recall` `/diary` `/config` `/tune` `/ignore` `/ping` `/help`

`DISCORD_SINGLE_SESSION=1` 時所有頻道與 DM 共用同一個 Agent key（`global`）；否則每個頻道／DM 各自有 conversation window。vault、mood、self、drives 仍然共用。

### Web

`npm run web` 開在 `FISHD_PORT`（預設 7777）。

| 路由 | 用途 |
|---|---|
| `GET /` | 聊天 UI |
| `POST /api/turn` | 一般回覆（`{text}`） |
| `POST /api/spontaneous` | 叫她主動說一句 |
| `GET /api/state` | transcript、mood、stats、journal tail |
| `GET/POST /api/config` | 設定頁讀寫 `.env` |
| `GET /api/models` | provider 可用模型 |
| `GET /api/share/<name>` | 分享素材 |
| `GET /v1/models` | OpenAI-compatible model list |
| `POST /v1/chat/completions` | OpenAI-compatible chat（stream／non-stream） |

`/v1/*` 給 dsh-pet、OpenAI SDK 之類的本機客戶端用；它仍然檢查 Host 必須是 localhost／127.0.0.1，但允許沒有 `Origin` 的請求。

### Electron 桌寵 `pet/`

- 連 `POST /api/turn` 與 `/api/spontaneous`。
- 透明視窗、拖曳、托盤、餵食、心情動畫。
- `speechSynthesis` 唸回覆；`FISHD_VOICE_P` 控制機率。
- SVG 尾巴依 mood 擺動；透明區域滑鼠穿透，魚本體可點。
- 分享圖會顯示在頭頂。

### dsh-pet（外部 Python 桌寵）

本 harness 可以直接當 dsh-pet 的大腦：

- Chat provider：`http://127.0.0.1:7777/v1`，model `fishd-whale`。
- 她工作時的狀態會寫到 `vault/state/pet-events.jsonl`：

```json
{"ts":1793379501.0,"agent":"fishd","state":"working","tool":"memory_search"}
```

- dsh-pet 的 `agent_link.custom_agents` 指向這個檔案，就能在 thinking／working／idle／error 時換動畫。
- `FISHD_PET=0` 可關閉事件流；`FISHD_PET_EVENTS` 可改路徑。

---

## 設定

完整清單看 `.env.example`；以下是行為相關的重點。

### 模型與人格

| Key | 意思 |
|---|---|
| `FISHD_PROVIDER` | `opencode`／`deepseek`／`stub`；空 = 自動 |
| `FISHD_MODEL` | 模型 id |
| `FISHD_MAX_TOKENS` | 回覆上限，不是 context |
| `FISHD_REASONING` / `_EFFORT` | DeepSeek thinking |
| `FISHD_PACK` | 人格包；空 = `vault/persona` |
| `FISHD_STATIC_BUDGET` | static 層 token 上限 |
| `FISHD_CONTEXT_TOKENS` | 大 window token 上限；`0`／`off` 回到舊模式（預設 100000） |
| `FISHD_COMPACT_KEEP` | compact 後保留 window 的比例（預設 0.3） |
| `FISHD_HOT_TURNS` | 舊模式 hot window 幾輪（預設 24；大 window 模式不看這個） |

### Gate 與 JEV

| Key | 意思 |
|---|---|
| `FISHD_GATE` | `heuristic`／`jev`／`llm`／`chain` |
| `JEV_MODEL` | System One 模型 |
| `JEV_THRESHOLD` | 基礎門檻 |
| `JEV_TIMEOUT_MS` | JEV 逾時 |
| `JEV_TO_ME_BONUS` | 被對她說話時降門檻 |
| `JEV_NOT_ME_PENALTY` | 對別人說話時升門檻 |
| `JEV_AIMED_BIAS` | 明顯對別人說話時再乘上的倍率 |
| `DISCORD_TALK` | 講話意願；除以門檻 |
| `GATE_*` | OpenRouter 第二層 gate |

### Discord 節奏

| Key | 意思 |
|---|---|
| `DISCORD_AMBIENT` | 要不要讓她判斷插話 |
| `DISCORD_AMBIENT_P` | heuristic 基準機率 |
| `DISCORD_AMBIENT_COOLDOWN` | 同頻道插話冷卻（秒） |
| `DISCORD_BURST_MIN` | burst 看幾分鐘 |
| `DISCORD_ARM_MS` | 決定後等多久才送 |
| `DISCORD_SETTLE_MIN` | 插話後安靜幾分鐘 |
| `DISCORD_SETTLE_BIAS` | 安靜期的門檻倍率 |
| `DISCORD_BUDGET` | 沉默預算 `N/M`（只算 ambient） |
| `DISCORD_SPONTANEOUS` | 自己開話題 |
| `DISCORD_SPON_MIN/MAX` | 頻道 spontaneous 間隔 |
| `DISCORD_SPON_QUIET` | 頻道要安靜幾分鐘 |
| `DISCORD_SPON_HUSH` | 不主動的時段，例如 `2-7` |
| `DISCORD_SPON_DM*` | 主動私訊主人的間隔與安靜時間 |
| `DISCORD_OWNER_IDS` | 主人；更親近、可收主動 DM、非主人限制不適用 |
| `DISCORD_SINGLE_SESSION` | 所有房間共用一個 conversation key |

### 聲音與桌寵

| Key | 意思 |
|---|---|
| `FISHD_VOICE` | 1 = 允許唸出回覆 |
| `FISHD_VOICE_P` | 唸出的機率 |
| `FISHD_VOICE_MAX` | 超過字數就不唸 |
| `FISHD_PET_EVENTS` | dsh-pet 事件檔路徑 |
| `FISHD_PET` | 0 = 關閉 Pet Link |
| `FISHD_PORT` | Web／dsh-pet API 埠 |

### Sandbox 外掛

| Key | 意思 |
|---|---|
| `FISHD_SANDBOX` | `1` = 開啟 sandbox 工具；預設關 |
| `FISHD_SANDBOX_DISTRO` | WSL distro 名稱，預設 `pm-sbx-main` |
| `FISHD_SANDBOX_CONTROL_PORT` | guest control service 埠，預設 `47801` |
| `FISHD_SANDBOX_DISPLAY` | 顯示器，預設 `:99` |
| `FISHD_SANDBOX_KEEPALIVE` | `0` = 關閉背景保活 watcher；預設開 |
| `FISHD_SANDBOX_WATCH_MS` | watcher 檢查間隔，預設 20000 |
| `FISHD_SANDBOX_PM_BUSY_MS` | PM 最後使用後多久內視為忙碌，預設 90000 |
| `FISHD_SANDBOX_ACTIONS_PER_DAY` | 每日動作上限，預設 500 |
| `FISHD_SANDBOX_TIMEOUT_MS` | 單次 sandbox 呼叫逾時，預設 15000 |

---

## 測試與已知限制

- `npm test`：520 tests（含 sandbox 外掛的工具介面測試）；`npm run typecheck` 乾淨。
- JEV 需要 key；沒有 key 或 timeout 會 fallback，不會讓 bot 沉默。
- `stable` prompt 層目前是保留的，`bin.ts` 沒有填入長期 profile。
- 目前預設是大 window（100k／keep 0.3）；`FISHD_CONTEXT_TOKENS=0` 才會回到 24 輪舊模式。
- dsh-pet 是外部程式，不在這個 repo 內；README 只描述它需要的 `/v1` 與 JSONL 介面。
- `vault/share/` 預設沒有媒體，所以 `share` tool 要有素材才有東西可挑。
- `.env`、journal、diary、people、state、share 媒體都不進 git；要備份請備份整個 `vault/`。
