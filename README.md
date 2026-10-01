# dsh-llm-sampling-params

A [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`) plugin that injects **per-model sampling parameters** into every chat-completions request sent to a local **llama.cpp / llama-server** gateway.

## Why

dsh's `LlmCallConfig` only carries `temperature` / `maxTokens` / `stop` — it never sends `top_p`, `top_k`, `min_p`, `repeat_penalty`, `presence_penalty`, or `frequency_penalty`. llama.cpp accepts all of these **per request**. This plugin stamps the matching model's sampling set onto the wire body of chat-completions calls, so you can switch sampling behavior (e.g. a high-temperature creative role vs. a low-temperature coding role) **by switching the model alias** — no model reload, no extra VRAM.

## How it works

The plugin wraps `globalThis.fetch` at the transport layer:

1. Every `fetch()` call in the dsh process flows through the wrapper.
2. For requests whose URL contains `/v1/chat/completions`, the wrapper parses the JSON body.
3. It reads `body.model` (the alias), looks it up in the `sampling-params` `models` table.
4. If found, it stamps the sampling set onto the parsed body and re-serializes `init.body`.
5. The original fetch sends the modified body.

**Why a fetch wrapper:** dsh's agent-loop requests arrive **deep-frozen** (mutation throws), and the pi-ai adapter does not forward `onPayload` from `GenerateOptions`. Wrapping `fetch` operates below all of those abstractions — it edits the already-built JSON body before it leaves the process, so no dsh internal is touched.

## How roles work

- llama.cpp can serve **one loaded GGUF under several aliases** (e.g. `model-i`, `model-p`, `model-t`), all pointing at the same underlying weights — so switching alias costs **no extra VRAM**.
- dsh's `llm-pi-ai` lists each alias as a separate selectable model, so switching the model in the UI picks a sampling role.
- This plugin reads the `model` field of each request (the alias) and looks it up in the `sampling-params` `models` table. **Unconfigured aliases pass through untouched.**

## Zero conflict

- The fields dsh already sends (`temperature` / `maxTokens`) are left to dsh unless a model explicitly sets them.
- Every other sampling field is one dsh never sends, so there is no competing source — the plugin simply overrides the llama.cpp server default.

## Install

```sh
# From npm (once published)
dsh plugin --profile web add dsh-llm-sampling-params

# From a local directory
dsh plugin --profile web add link:C:/path/to/dsh-llm-sampling-params
```

Then restart `dsh web` (or refresh the GUI page).

## Configure models

The `models` table lives in your dsh settings. **Where it goes depends on your dsh version:**

| dsh | where the table goes |
|-----|----------------------|
| **0.2.x** | the profile's `cordis.patch.yml`, as a top-level `sampling-params` entry |
| **0.1.x** | `$DSH_HOME/settings.yaml`, under a `sampling-params:` section (applies live) |

### DSH 0.2.x

Add a top-level entry to your profile's `cordis.patch.yml` (edit `cordis.patch.yml`, not `cordis.yml`). The `id: sampling-params` is the binding key and must match the plugin's namespace:

```yaml
- id: sampling-params
  name: dsh-llm-sampling-params
  config:
    models:
      # Key = the exact model id (alias) sent on the wire.
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

### Migrating from 0.1.x to 0.2.x

Upgrading dsh to 0.2.x renames `$DSH_HOME/settings.yaml` to `settings.yaml.imported` (a frozen backup, no longer read). Your `sampling-params.models` table is stranded there. To migrate, copy the `models:` block out of `settings.yaml.imported` and add it as the `sampling-params` entry in your profile's `cordis.patch.yml`, re-indenting the block by **+2 spaces** to nest under `config:`. The one-time auto-import does not re-run, so do this by hand (or via the settings UI).

> Each model is a **complete** sampling set — every field is required, so configure each alias with all seven numbers.

## Ports

This plugin **never hardcodes an LLM port**. It matches on the `/v1/chat/completions` path in the request URL — the host and port come from your dsh provider configuration (e.g. `llm-pi-ai.providers.llama.baseURL`). The examples below use `<host>:<port>` as a placeholder.

## Wire field names

llama.cpp uses snake_case wire names. **Note:** repetition penalty is `repeat_penalty`, **not** `repetition_penalty`.

| Model key | llama.cpp wire field |
|-----------|----------------------|
| `temperature` | `temperature` |
| `top_p` | `top_p` |
| `top_k` | `top_k` |
| `min_p` | `min_p` |
| `repeat_penalty` | `repeat_penalty` |
| `presence_penalty` | `presence_penalty` |
| `frequency_penalty` | `frequency_penalty` |

## Verifying the sampling was applied

llama-server's `/slots` endpoint echoes the sampling parameters the server actually adopted. Query it for a model to confirm a request's sampling took effect:

```sh
curl "http://<host>:<port>/slots?model=<model-id>"
```

The `params` object of the returned slot reflects `temperature`, `top_p`, `top_k`, `min_p`, `repeat_penalty`, `presence_penalty`, and `frequency_penalty` — a match against the model's configured values confirms the injection reached the server.

## Debugging the injection (any provider)

To confirm the outgoing request actually carries the sampling params — works with **any** OpenAI-compatible provider, not just llama-server — enable the built-in debug log:

- Start dsh with env `DSH_SAMPLING_DEBUG=1`, **or** create the marker file `~/.dsh/_sampling-debug-on`.
- Restart dsh so `apply()` re-reads the switch.
- Have a conversation in the GUI (select a configured alias).
- Each injected request appends one JSON line to `~/.dsh/_sampling-debug.log`:

  ```json
  {"ts":"2026-01-01T00:00:00.000Z","model":"model-i","injected":{"temperature":0.2,"top_p":0.8,"top_k":20,"min_p":0.05,"repeat_penalty":1.0,"presence_penalty":0.0,"frequency_penalty":0.0}}
  ```

- Disable by unsetting the env / deleting the marker file (takes effect on the next restart). The log is best-effort and never affects the request.

## Compatibility

- Supports dsh **0.1.x and 0.2.x** — the settings read path is version-adaptive (`settings.register` on 0.1.x, the profile-entry config on 0.2.x).
- Requires dsh with `@deepseek-ai/dsh-settings` and `@deepseek-ai/schemastery` (both ship with dsh).
- Target must be an OpenAI-compatible gateway that honors these wire fields (llama.cpp `llama-server` does).
- The wrapper is guarded by a `Symbol.for` flag so hot-reload never double-wraps.

## License

MIT
