# dsh-llm-sampling-params

一個 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）插件，將**每個模型的採樣參數**注入發送到 OpenAI 相容 LLM 閘道（llama.cpp、SGLang、vLLM）的每個 chat-completions 請求。

## 為什麼

dsh 的 `LlmCallConfig` 只帶 `temperature` / `maxTokens` / `stop`——從不發送 `top_p`、`top_k`、`min_p`、`repeat_penalty`、`presence_penalty` 或 `frequency_penalty`。OpenAI 相容閘道（llama.cpp、SGLang、vLLM）全部支援這些**按請求**參數。本插件將匹配模型的採樣組蓋印到 chat-completions 呼叫的 wire body 上，讓你**切換模型別名**就能切換採樣行為（例如高溫創意角色 vs. 低溫編碼角色）——無需重新載入模型、不佔額外 VRAM。

## 運作原理

插件在 transport 層 wrap `globalThis.fetch`：

1. dsh process 內每個 `fetch()` 呼叫都經過 wrapper。
2. URL 包含 `/v1/chat/completions` 的請求，wrapper 解析 JSON body。
3. 讀取 `body.model`（別名），在 `sampling-params` 的 `models` 表查詢。
4. 找到就將採樣組蓋印到解析後的 body，重新序列化 `init.body`。
5. 原始 fetch 發送修改後的 body。

**為什麼用 fetch wrapper：** dsh 的 agent-loop 請求到達時是 **deep-frozen**（mutate 會 throw），且 pi-ai adapter 不會從 `GenerateOptions` 轉發 `onPayload`。Wrap `fetch` 在所有這些抽象之下操作——它直接編輯已組好的 JSON body，不碰任何 dsh 內部。

## 角色如何運作

- 閘道可將**一個已載入的模型以多個別名**（如 `model-i`、`model-p`、`model-t`）提供，全部指向相同的底層權重——切換別名**不佔額外 VRAM**。（llama.cpp：`a =` alias 清單；vLLM：多個 `--served-model-name`；SGLang：單一 served name、寬鬆匹配。）
- dsh 的 `llm-pi-ai` 將每個別名列為可選模型，切換 UI 裡的模型就選定採樣角色。
- 本插件讀取每個請求的 `model` 欄位（別名），在 `sampling-params` 的 `models` 表查詢。**未配置的別名原樣通過。**

## 零衝突

- dsh 已發送的欄位（`temperature` / `maxTokens`）留給 dsh，除非模型明確設定。
- 其他採樣欄位是 dsh 從不發送的，因此沒有競爭來源——插件僅覆蓋 server 預設值。

## 安裝

```sh
# 從 npm（發布後）
dsh plugin --profile web add dsh-llm-sampling-params

# 從本地目錄
dsh plugin --profile web add link:C:/path/to/dsh-llm-sampling-params
```

然後重啟 `dsh web`（或刷新 GUI 頁面）。

## 配置模型

`models` 表放在你的 dsh 設定裡。**放哪裡取決於你的 dsh 版本：**

| dsh | 表放哪裡 |
|-----|---------|
| **0.2.x** | profile 的 `cordis.patch.yml`，作為頂層 `sampling-params` entry |
| **0.1.x** | `$DSH_HOME/settings.yaml` 的 `sampling-params:` 區段（即時生效） |

### DSH 0.2.x

在 profile 的 `cordis.patch.yml` 加一個頂層 entry（改 `cordis.patch.yml`，不是 `cordis.yml`）。`id: sampling-params` 是 binding key，必須與插件 namespace 相符：

```yaml
- id: sampling-params
  name: dsh-llm-sampling-params
  config:
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
```

### 從 0.1.x 遷移到 0.2.x

升級 dsh 到 0.2.x 會把 `$DSH_HOME/settings.yaml` 改名成 `settings.yaml.imported`（凍結備份，不再讀取），你的 `sampling-params.models` 表就擱淺在那裡。要遷移：把 `models:` 區塊從 `settings.yaml.imported` 抽出，加進 profile 的 `cordis.patch.yml` 作為 `sampling-params` entry，並將該區塊**+2 空格**縮排以嵌在 `config:` 下。一次性自動 import 不會重跑，所以要手動搬（或經設定 UI）。

> 每個模型是**完整**採樣組——每個欄位必填，因此為每個別名配置全部七個數值。

## 連接埠

本插件**從不硬編碼 LLM port**。它匹配請求 URL 中的 `/v1/chat/completions` 路徑——host 和 port 來自你的 dsh provider 配置（如 `llm-pi-ai.providers.llama.baseURL`）。以下範例以 `<host>:<port>` 作為佔位符。

## Wire 欄位名稱

wire body 使用 snake_case 名稱。配置的 `repeat_penalty` 會**同時**以 `repeat_penalty`（llama.cpp）和 `repetition_penalty`（SGLang / vLLM）兩個名稱送出，所以無論後端是哪家，正確的那個都會被採用。

| 模型鍵 | wire 欄位（送出） |
|--------|---------------------|
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `top_k` | `top_k` |
| `min_p` | `min_p` |
| `repeat_penalty` | `repeat_penalty` + `repetition_penalty` |
| `presence_penalty` | `presence_penalty` |
| `frequency_penalty` | `frequency_penalty` |

## 驗證採樣已生效

llama.cpp 的 `/slots` 端點回顯 server 實際採用的採樣參數（llama.cpp 專屬；SGLang / vLLM 用下方的 debug log）。查詢模型以確認請求的採樣生效：

```sh
curl "http://<host>:<port>/slots?model=<model-id>"
```

返回 slot 的 `params` 物件反映 `temperature`、`top_p`、`top_k`、`min_p`、`repeat_penalty`、`presence_penalty` 和 `frequency_penalty`——與模型配置值相符即確認注入已達 server。

## 除錯注入（任何 provider）

要確認出向請求**真的**帶上 sampling 參數——對**任何** OpenAI 相容 provider 都適用，不只 llama-server——開啟內建 debug log：

- 用 env `DSH_SAMPLING_DEBUG=1` 啟動 dsh，**或**建立 marker 檔 `~/.dsh/_sampling-debug-on`。
- 重啟 dsh 讓 `apply()` 重讀開關。
- 在 GUI 對話（選一個已配置的 alias）。
- 每個注入的請求會 append 一行 JSON 到 `~/.dsh/_sampling-debug.log`：

  ```json
  {"ts":"2026-01-01T00:00:00.000Z","model":"model-i","injected":{"temperature":0.2,"top_p":0.8,"top_k":20,"min_p":0.05,"repeat_penalty":1.0,"presence_penalty":0.0,"frequency_penalty":0.0}}
  ```

- 取消：unset env / 刪 marker 檔（下次重啟生效）。log 是 best-effort，不影響請求。

## 相容性

- 支援 dsh **0.1.x 與 0.2.x**——設定讀取路徑是 version-adaptive（0.1.x 用 `settings.register`、0.2.x 用 profile-entry config）。
- 需要 dsh 內含 `@deepseek-ai/dsh-settings` 與 `@deepseek-ai/schemastery`（兩者隨 dsh 提供）。
- 目標必須是遵循這些 wire 欄位的 OpenAI 相容閘道（llama.cpp、SGLang、vLLM 都符合）。
- Wrapper 以 `Symbol.for` 標記保護，hot-reload 不會重複 wrap。

## 授權

MIT
