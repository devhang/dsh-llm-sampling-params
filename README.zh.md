# dsh-llama-cpp-sampling-params

一個 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，將**每個模型的採樣參數**注入發送到本地 **llama.cpp / llama-server** 閘道的每個 chat-completions 請求。

## 為什麼

dsh 的 `LlmCallConfig` 只帶 `temperature` / `maxTokens` / `stop`——從不發送 `top_p`、`top_k`、`min_p`、`repeat_penalty`、`presence_penalty` 或 `frequency_penalty`。llama.cpp 全部支援這些**按請求**參數。本插件將匹配模型的採樣組蓋印到 chat-completions 呼叫的 wire body 上，讓你**切換模型別名**就能切換採樣行為（例如高溫創意角色 vs. 低溫編碼角色）——無需重新載入模型、不佔額外 VRAM。

## 運作原理

插件在 transport 層 wrap `globalThis.fetch`：

1. dsh process 內每個 `fetch()` 呼叫都經過 wrapper。
2. URL 包含 `/v1/chat/completions` 的請求，wrapper 解析 JSON body。
3. 讀取 `body.model`（別名），在 `sampling-params` 的 `models` 表查詢。
4. 找到就將採樣組蓋印到解析後的 body，重新序列化 `init.body`。
5. 原始 fetch 發送修改後的 body。

**為什麼用 fetch wrapper：** dsh 的 agent-loop 請求到達時是 **deep-frozen**（mutate 會 throw），且 pi-ai adapter 不會從 `GenerateOptions` 轉發 `onPayload`。Wrap `fetch` 在所有這些抽象之下操作——它直接編輯已組好的 JSON body，不碰任何 dsh 內部。

## 角色如何運作

- llama.cpp 可將**一個已載入的 GGUF 以多個別名**（如 `model-i`、`model-p`、`model-t`）提供，全部指向相同的底層權重——切換別名**不佔額外 VRAM**。
- dsh 的 `llm-pi-ai` 將每個別名列為可選模型，切換 UI 裡的模型就選定採樣角色。
- 本插件讀取每個請求的 `model` 欄位（別名），在 `sampling-params` 的 `models` 表查詢。**未配置的別名原樣通過。**

## 零衝突

- dsh 已發送的欄位（`temperature` / `maxTokens`）留給 dsh，除非模型明確設定。
- 其他採樣欄位是 dsh 從不發送的，因此沒有競爭來源——插件僅覆蓋 llama.cpp server 預設值。

## 安裝

```sh
# 從 npm（發布後）
dsh plugin --profile web add dsh-llama-cpp-sampling-params

# 從本地目錄
dsh plugin --profile web add link:C:/path/to/dsh-llama-cpp-sampling-params
```

然後重啟 `dsh web`（或刷新 GUI 頁面）。

## 配置模型

在 `$DSH_HOME/settings.yaml` 設定每個模型的採樣表。該區段**即時生效**——修改無需重啟。

```yaml
sampling-params:
  models:
    # 鍵 = 發送到 wire 的精確 model id（別名）。
    model-t:   # Think
      temperature: 0.6
      top_p: 0.95
      top_k: 20
      min_p: 0.05
      repeat_penalty: 1.0
      presence_penalty: 0.0
      frequency_penalty: 0.0
    model-i:   # Instruct
      temperature: 0.2
      top_p: 0.8
      top_k: 20
      min_p: 0.05
      repeat_penalty: 1.0
      presence_penalty: 0.0
      frequency_penalty: 0.0
    model-p:   # Planner
      temperature: 1.0
      top_p: 0.95
      top_k: 20
      min_p: 0.0
      repeat_penalty: 1.0
      presence_penalty: 0.0
      frequency_penalty: 0.0
```

> 每個模型是**完整**採樣組——每個欄位必填，因此為每個別名配置全部七個數值。

## 連接埠

本插件**從不硬編碼 LLM port**。它匹配請求 URL 中的 `/v1/chat/completions` 路徑——host 和 port 來自你的 dsh provider 配置（如 `llm-pi-ai.providers.llama.baseURL`）。以下範例以 `<host>:<port>` 作為佔位符。

## Wire 欄位名稱

llama.cpp 使用 snake_case wire 名稱。**注意：** 重複懲罰是 `repeat_penalty`，**不是** `repetition_penalty`。

| 模型鍵 | llama.cpp wire 欄位 |
|--------|---------------------|
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `top_k` | `top_k` |
| `min_p` | `min_p` |
| `repeat_penalty` | `repeat_penalty` |
| `presence_penalty` | `presence_penalty` |
| `frequency_penalty` | `frequency_penalty` |

## 驗證採樣已生效

llama-server 的 `/slots` 端點回顯 server 實際採用的採樣參數。查詢模型以確認請求的採樣生效：

```sh
curl "http://<host>:<port>/slots?model=<model-id>"
```

返回 slot 的 `params` 物件反映 `temperature`、`top_p`、`top_k`、`min_p`、`repeat_penalty`、`presence_penalty` 和 `frequency_penalty`——與模型配置值相符即確認注入已達 server。

## 相容性

- 需要 dsh 內含 `@deepseek-ai/dsh-settings` 與 `@deepseek-ai/schemastery`（兩者隨 dsh 提供）。
- 目標必須是遵循這些 wire 欄位的 OpenAI 相容閘道（llama.cpp `llama-server` 符合）。
- Wrapper 以 `Symbol.for` 標記保護，hot-reload 不會重複 wrap。

## 授權

MIT
