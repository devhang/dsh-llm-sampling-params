# dsh-llama-cpp-sampling-params — 最終實作設計

## 目標

將 per-model 採樣參數注入 llama.cpp chat-completions 請求，讓切換模型別名即可切換採樣行為。

## 為什麼用 fetch wrapper（而非 llm/stream + onPayload）

### 已證實的技術限制

1. **Agent-loop 請求 deep-frozen**：dsh agent loop 構建 `GenerateOptions` 後 `deepFreeze(structuredClone(options))`。任何 `options.onPayload = ...` 賦值都 throw `TypeError: Cannot add property onPayload, object is not extensible`。
2. **Pi-ai adapter 白名單**：`dsh-llm-pi-ai` 的 `streamWithSnapshot` 構建 `streamSimple(model, context, {...})` 時只用白名單（`temperature`、`maxTokens`、`sessionId`、`signal`、`headers`），`onPayload` 和 `samplingParams` 不會被轉發。
3. **Plugin logger 不可見**：cordis 預設 exporter 只寫記憶體 ring buffer，`log.info`/`log.warn` 不輸出到 stderr 或 log file。

### 結論

`llm/stream` + `onPayload` 方案在 DSH 目前架構下**不可行**。Fetch wrapper 在 transport 層操作，繞過所有上述限制。

> 升級 DSH 0.2.x 後為何失效、以及「換 seam」為何仍不划算的完整複查，見下方「DSH 0.2.x 遷移記錄」一節。

## 架構：`globalThis.fetch` wrapper

```js
const WRAPPED = Symbol.for("dsh-llama-cpp-sampling-params.fetch-wrapped");
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

function apply(ctx, config = {}) {
  // ...settings registration（plain string namespace，見下）...

  if (typeof globalThis.fetch === "function" && !globalThis.fetch[WRAPPED]) {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = async function (input, init) {
      try {
        const url = typeof input === "string" ? input : input?.url;
        const bodyText = typeof init?.body === "string" ? init.body : null;
        if (
          typeof url === "string" &&
          url.includes(CHAT_COMPLETIONS_PATH) &&
          bodyText !== null
        ) {
          const body = JSON.parse(bodyText);
          if (body && typeof body.model === "string") {
            const model = readModel(body.model);
            if (model) {
              for (const key of WIRE_KEYS) {
                if (typeof model[key] === "number") body[key] = model[key];
              }
              init.body = JSON.stringify(body);
            }
          }
        }
      } catch { /* never break traffic */ }
      return originalFetch.call(this, input, init);
    };
    globalThis.fetch[WRAPPED] = true;
  }
}
```

### 資料流

```
pi-ai buildParams → wire body（JSON string）
  → globalThis.fetch(url, { body: "..." })
    → wrapper: JSON.parse(body) → 查 models[body.model] → 注入採樣 → JSON.stringify
    → originalFetch(url, { body: "modified..." })
  → llama.cpp 收到含採樣的 wire body
```

### Settings 註冊的跨版本陷阱

namespace 以 **plain string** 註冊（`ctx.settings.register("sampling-params", ...)`），**不用** `settingsNamespace()` from `@deepseek-ai/dsh-settings`——該 export 是 0.1.1 才加入，較舊/較新的 dsh build 沒有它，直接 import 會讓 plugin 在那些 build 上 load 失敗（git `40624da`）。

## 配置格式

```yaml
sampling-params:
  models:
    # 鍵 = wire 上的精確 model id（別名）
    model-t:
      temperature: 0.6
      top_p: 0.95
      top_k: 20
      min_p: 0.05
      repeat_penalty: 1.0
      presence_penalty: 0.0
      frequency_penalty: 0.0
    model-i:
      temperature: 0.2
      ...
```

**匹配邏輯：** 單一查表 `models[body.model]`。未配置的 model 原樣通過。

**Schema 注意（v0.1.x 最終版）：** `Model` 的 7 個字段**全部必填**——缺任一字段該 entry 會被 schemastery 拒絕（整個 section 維持最後一次有效值）。每個 alias 必須配完整的一套 7 項。

## Alias 角色模式（一模型三 alias，零 OOM）

核心使用模式：**同一個 loaded 模型掛多個 alias，各 alias 綁定不同 role 的採樣參數**，在 dsh UI 切 model 即切 role，不換模型、不重載。

### llama.cpp 端

preset 的 `a =` 語法（alias 清單）：

```ini
[base-model]
a = base-model-i, base-model-p, base-model-t
```

已實證的行為（本地 llama-server 實測）：

| 觀察 | 結論 |
|------|------|
| alias 請求回 200 | llama.cpp 接受 alias，路由到同一個 loaded 實例 |
| `/v1/models` 只列 base id，不單獨列 alias | alias **共享同一份權重，不額外佔 VRAM**（零 OOM） |
| 未列出的 model id 回 **400 `model 'x' not found`** | dsh 端 model entry 的 `id` 必須是 llama.cpp 認得的 alias（或 base id） |

### dsh 端

`llm-pi-ai` 的 provider `models` 列表把每個 alias 註冊成一個可選 model（`id` = alias，`name` = 顯示名）。dsh 的 `PiAiModelProfile` 原生**不認 `samplingParams` 字段**（schemastery 拒未知字段），所以 alias→採樣的映射只能放本 plugin 的 `sampling-params.models`。

### Role 數值模式（3-role 示例）

| Role | temperature | top_p | top_k | min_p | 用途 |
|------|------------|-------|-------|-------|------|
| `-i` instruct | 0.2 | 0.80 | 20 | 0.05 | 低溫直接作答 |
| `-t` think | 0.6 | 0.95 | 20 | 0.05 | 中溫帶思考 |
| `-p` planner | 1.0 | 0.95 | 20 | 0.0 | 高溫規劃 |

三套統一：`repeat_penalty: 1.0`、`presence_penalty: 0.0`、`frequency_penalty: 0.0`。

## 邊界情況

- **未配置的 model** → 查表 miss → 原樣通過（不報錯）。
- **JSON parse 失敗** → catch → 原樣通過。
- **非 chat-completions 請求**（如 `/completion`）→ URL 不匹配 → 原樣通過。
- **非 string body**（如 FormData）→ `bodyText === null` → 原樣通過。
- **Hot-reload** → `Symbol.for` 標記防止重複 wrap。
- **多 provider 同 model id** → 目前用 bare model name 匹配，無法區分。如未來需要，可擴展為 URL-based 匹配。

## 驗證結果

| Alias | temp | top_p | top_k | min_p | /slots 確認 |
|-------|------|-------|-------|-------|-------------|
| `-p` (planner) | 1.0 | 0.95 | 20 | 0.0 | ✅ |
| `-i` (instruct) | 0.2 | 0.8 | 20 | 0.05 | ✅ |
| `-t` (think) | 0.6 | 0.95 | 20 | 0.05 | ✅ |

- **單元**（`test-alias.mjs`）：stub fetch 捕獲出向 body，alias 精確匹配注入 7 項全中；未配置 alias 原樣通過；`model`/`max_tokens` 不受影響。
- **真實 e2e**（`test-e2e-alias.mjs`）：對真實 llama-server 發送經 wrapper 注入的 body，`/slots` 回顯確認 server 端實際採用全部值。
- **e2e 驗證技巧**：`/v1/chat/completions` 不回顯採樣值；`/completion` 加 `response_fields: ["generation_settings"]`，或 GET `/slots` 讀 `params`，可看到 server 端生效值。

## 檔案

| 檔案 | 說明 |
|------|------|
| `index.js` | 核心：fetch wrapper + settings 註冊（~140 行） |
| `cordis.patch.yml` | bundle patch（plugin 註冊 + base config） |
| `package.json` | `dsh.bundle.patch` 指向 patch yml；peer deps: cordis + dsh-settings；dep: schemastery |
| `test-alias.mjs` | 單元測試（stub fetch 捕獲出向 body） |
| `test-e2e-alias.mjs` | 端到端測試（真實 llama-server + /slots 回顯） |
| `README.md` / `README.zh.md` | 雙語文件 |
| `LICENSE` | MIT |

## DSH 0.2.x 遷移記錄

### 0.2.0 為什麼失效

升級 DSH 0.2.x（profile 化架構）後本插件失效，三個**獨立**原因，需分別處理：

1. **Peer-dep gate 擋住 load**：0.2.0 在 bundle composition 階段對 peerDependency 不相容的插件做 skip。本插件 `package.json` 的 peer `@deepseek-ai/dsh-settings` 原範圍 `>=0.1.1-rc.1 <0.2.0-0` 不匹配 0.2.x 運行時（如 `0.2.0-rc.2`），插件被 **skip** → `apply()` 從未執行 → fetch wrapper 從未安裝。
   - 診斷：`dsh --profile <name> --dump-config` 會在 stderr 印出 skip 訊息。
   - 正解：放寬 peer range（已改 `>=0.1.1-rc.1 <0.3.0-0`，v0.2.0）；`dsh plugin allow-version` 只是單一版本豁免的暫解。
2. **設定服務 API 破壞性變更**：0.2.0 的 `@deepseek-ai/dsh-settings` 重建為 profile-entry 模型（`configure` / `describe` / `update` / `replace` / `mutate` / `writable`），**移除了 `register(namespace, Schema, {base, applies})`**；`applies: "live"` 變成 `describe()` 的輸出欄位、不再是 register 輸入。原 `apply()` 呼叫 `ctx.settings.register(...).get()` → 0.2.0 下 `register` 不存在 → `TypeError: ctx.settings.register is not a function` → `apply()` 拋錯 → fetch wrapper 仍未安裝。**這與原因 #1 獨立**：就算用 `allow-version` 解鎖了 skip，apply() 仍會在此掛掉。
   - 0.2.0 下插件的 live config 由 fiber 重啟餵入：`fiber.update(config)` → `internal/update` → `this.config = config` + `restart()` → **`apply(ctx, config)` 重跑並餵入新 config**。
3. **設定資料遷移到 `.imported`**：0.2.0 把 `<home>/settings.yaml` rename 成 `settings.yaml.imported`、逐 section 寫入各 entry 後，`settings.yaml` 不再被讀取；live 設定改放 **profile 的 `cordis.patch.yml`**。本插件的 `sampling-params.models`（一表 N 個 alias）只留在 `settings.yaml.imported`，而 profile 的 `cordis.patch.yml` 沒有對應 entry → 即使插件 load 了、apply() 跑完了，`models` 仍是空的（預設 `{}`）。這是**資料**遷移，非程式碼問題。

**修正（v0.2.0，已完成並驗證）：**
- (A) **放寬 peer range**：`@deepseek-ai/dsh-settings: >=0.1.1-rc.1 <0.3.0-0`（涵蓋 0.2.0-rc.x），解開原因 #1 的 skip。
- (B) **`apply()` 改為 version-adaptive**：module-level `liveConfig`（每次 `apply()` 更新；對應 0.2.0 的 restart 餵新 config），並偵測 `ctx.settings.register` 是否存在——存在（0.1.x）走 `scope.get()` live 路徑；不存在（0.2.0）走 `liveConfig`。同一份程式碼跨 0.1.x / 0.2.0 成立，解開原因 #2。
- (C) **資料遷移（待使用者做）**：把 `sampling-params.models` 補進 profile 的 `cordis.patch.yml`（或經插件設定 UI），解開原因 #3。`.imported` 不會自動重 import。

**驗證**：`test-alias.mjs`（0.1.x：`register` + `scope.get()`）與 `test-020.mjs`（0.2.x：無 `register`、`liveConfig`、模擬 restart 更新）皆通過；`dsh --profile web --dump-config` 確認本插件不再被 skip、`config.models` entry 出現、無相關錯誤。

### 0.2.0 有沒有更乾淨的 seam（fetch-wrapper 是否多餘）

**結論：沒有更乾淨的 dsh 層 seam；fetch-wrapper 仍是最小、且跨 0.1.x / 0.2.x 都成立的注入點。** 0.2.0 的 LLM 攔截點盤點：

| Seam | 性質 | 能否把 sampling 注入 request body |
|------|------|------|
| `llm/stream` waterfall | **response-chunk 包裹器**（`next()` 不吃 options） | ❌ 改不到出向 body |
| `ctx.llm.registerAdapter` | 替換 / 包裹 adapter | ⚠️ 需自寫 `LlmAdapter` 重建 pi-ai provider |
| `globalThis.fetch` wrapper | transport 層 | ✅ 0.2.0 已驗證仍攔得到 |

**pi-ai 底層原生有、但被 dsh 擋在 pi-ai 之上的能力**：`@earendil-works/pi-ai` 的 openai-completions provider 原生支援兩條乾淨路徑——`onPayload(params, model)`（request-body transformer）與 `samplingParams`（`Object.assign(params, options.samplingParams)` 直接展開進 body）。但兩條都過不了 dsh 這一層：`GenerateOptions`（`@deepseek-ai/dsh-llm`）**沒有** `onPayload`/`samplingParams` 欄位；`dsh-llm-pi-ai` 的 `streamWithSnapshot` 組 `streamSimple(...)` 只轉發白名單（見上「為什麼用 fetch wrapper」一節）。

**fetch-wrapper 在 0.2.0 仍有效的驗證**：pi-ai openai-completions 每次呼叫都 `new OpenAI(...)`（per-request）；OpenAI SDK 建構時 `this.fetch = options.fetch ?? getDefaultFetch()`，dsh 未傳 `fetch`，而 `getDefaultFetch()` 是**當下**讀 global `fetch`（非 module-load capture）。wrapper 於 startup 換掉 `globalThis.fetch`，故 per-request 建構時讀到的就是 wrapper → 攔截成立。

### 未來：若 DSH 暴露 seam

若日後 `dsh-llm-pi-ai` 把 `samplingParams`/`onPayload` 轉發進 `streamSimple`（或 `GenerateOptions` 新增這兩欄位），可把 fetch-wrapper 換成 pi-ai 原生路徑（更乾淨、免 JSON 重序列化）：

- **優先用 `samplingParams`**：per-model 設 `samplingParams: { temperature, top_p, top_k, min_p, repeat_penalty, presence_penalty, frequency_penalty }`，pi-ai 直接展開進 body。
- **或用 `onPayload`**：`onPayload: (params, model) => ({ ...params, ...sampling[params.model] })`，功能等同現行 fetch-wrapper。

在那之前，transport 層的 fetch-wrapper 是唯一跨版本成立的注入點。

## 發布

- ~~`npm publish`~~ ✅ 已完成（`dsh-llama-cpp-sampling-params`，latest）
- [ ] 提交 `dsh-market` / `awesome-dsh-plugin` 目錄（GitHub PR）

## 本地開發迴路

Profile 現從 npm 安裝。改動 plugin 測試時：`npm publish` 新版本後在 profile `pnpm update`，或暫時把 profile 的 dependency 改回 `link:<local-checkout-path>`。
