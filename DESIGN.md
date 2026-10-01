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

## 發布

- ~~`npm publish`~~ ✅ 已完成（`dsh-llama-cpp-sampling-params`，latest）
- [ ] 提交 `dsh-market` / `awesome-dsh-plugin` 目錄（GitHub PR）

## 本地開發迴路

Profile 現從 npm 安裝。改動 plugin 測試時：`npm publish` 新版本後在 profile `pnpm update`，或暫時把 profile 的 dependency 改回 `link:<local-checkout-path>`。
