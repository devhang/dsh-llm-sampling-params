/**
 * dsh-llama-cpp-sampling-params
 *
 * Injects per-model-alias sampling parameters into every chat-completions
 * request sent to an OpenAI-compatible local gateway (llama.cpp).
 *
 * How models work:
 *   - llama.cpp serves ONE loaded model under several aliases (e.g.
 *     `model-i`, `model-p`, `model-t`) that all point at the same underlying
 *     GGUF — so there is NO extra VRAM cost.
 *   - dsh's `llm-pi-ai` lists each alias as a separate selectable model, so
 *     switching model in the UI picks a sampling role.
 *   - This plugin reads the `model` field of each request (the alias) and
 *     looks it up in the `sampling-params` `models` table. If the alias is
 *     configured, it stamps that model's sampling set onto the wire body.
 *     Unconfigured aliases pass through byte-identical.
 *
 * Why a fetch wrapper: dsh's `GenerateOptions` only carries temperature /
 * maxTokens / stop — it never sends top_p, top_k, min_p, repeat_penalty,
 * presence_penalty, or frequency_penalty. Moreover, agent-loop requests arrive
 * deep-frozen (mutation throws) and the pi-ai adapter does not forward
 * `onPayload` from GenerateOptions. Wrapping `globalThis.fetch` operates at
 * the transport layer, below all of those abstractions, and simply rewrites
 * the already-built JSON body before it leaves the process.
 *
 * Zero conflict: the fields dsh already sends (temperature / maxTokens) are
 * left to dsh unless a model explicitly sets them; every other sampling field
 * is one dsh never sends, so there is no competing source.
 */
import z from "@deepseek-ai/schemastery";

const name = "sampling-params";
const inject = ["settings"];

// llama.cpp wire field names (snake_case). NOTE: repetition penalty is
// `repeat_penalty` on llama.cpp, NOT `repetition_penalty`.
const WIRE_KEYS = [
  "temperature",
  "top_p",
  "top_k",
  "min_p",
  "repeat_penalty",
  "presence_penalty",
  "frequency_penalty",
];

// One model's full sampling set. Each field is required (a model sets every
// number explicitly); a model that omits a field is rejected by the schema, so
// configure each alias with a complete set.
const Model = z.object({
  temperature: z.number(),
  top_p: z.number(),
  top_k: z.number(),
  min_p: z.number(),
  repeat_penalty: z.number(),
  presence_penalty: z.number(),
  frequency_penalty: z.number(),
});

// Plugin config: a table keyed by the exact model id (alias) sent on the
// wire. Each key's value is the sampling set stamped onto requests that name
// that alias. Example:
//   models:
//     model-i: { temperature: 0.2, top_p: 0.8, ... }
//     model-p: { temperature: 1.0, ... }
//     model-t: { temperature: 0.6, ... }
const Config = z.object({
  models: z.dict(Model).default({}),
});

// Mark so we never double-wrap globalThis.fetch (hot-reload safe).
const WRAPPED = Symbol.for("dsh-llama-cpp-sampling-params.fetch-wrapped");

// The OpenAI-compatible chat-completions path we inject into. Only requests
// whose URL carries this path are touched; everything else passes through
// byte-identical.
const CHAT_COMPLETIONS_PATH = "/v1/chat/completions";

function apply(ctx, config = {}) {
  const log = ctx.logger("sampling-params");

  // Register the settings section live so role values can be edited without
  // a restart. NOTE: we pass the namespace as a plain string, not via
  // `settingsNamespace()` from @deepseek-ai/dsh-settings — the export was
  // added in 0.1.1 and is absent in some older/newer versions, so importing
  // it directly breaks plugin load on those dsh builds.
  const scope = ctx.settings.register("sampling-params", Config, {
    base: config,
    applies: "live",
  });

  // Read the sampling set for one exact model id/alias.
  const readModel = (modelId) => {
    try {
      const section = scope.get();
      return section?.models?.[modelId];
    } catch {
      return undefined;
    }
  };

  const registeredModels = (() => {
    try { return Object.keys(scope.get()?.models ?? {}); } catch { return []; }
  })();
  log.info(`sampling-params applied (fetch wrapper); models=${registeredModels.length}`);

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
      } catch (error) {
        // Never break LLM traffic: on any parse/matching error, send the
        // request through untouched.
        log.warn(`sampling-params inject skipped: ${error?.message ?? error}`);
      }
      return originalFetch.call(this, input, init);
    };
    globalThis.fetch[WRAPPED] = true;
  }
}

export { apply, name, inject, Config };
