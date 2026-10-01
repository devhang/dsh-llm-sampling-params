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
 * Config source across DSH versions: the `models` table is the plugin's
 * settings. On DSH 0.1.x the plugin registers that section with
 * `ctx.settings.register(...)` and reads it live via the returned scope. On
 * 0.2.x the settings service was rebuilt around a profile-entry model
 * (`describe` / `mutate` / `configure`) and no longer exposes `register`; a
 * settings edit restarts the plugin fiber and re-runs `apply(ctx, config)`
 * with the new config, so the plugin caches that config in a module-level
 * `liveConfig` and reads it there. `apply` detects which path is available at
 * runtime, so the same code works on both.
 *
 * Zero conflict: the fields dsh already sends (temperature / maxTokens) are
 * left to dsh unless a model explicitly sets them; every other sampling field
 * is one dsh never sends, so there is no competing source.
 */
import z from "@deepseek-ai/schemastery";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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

// Module-level live config, refreshed on every apply() call. Under DSH 0.2.x a
// settings edit restarts the plugin fiber and re-runs apply() with the new
// config, so this always reflects the latest `models` table. Under 0.1.x the
// registered settings scope (created inside apply below) is the live source
// instead and this only holds the initial value.
let liveConfig = { models: {} };

// Debug switch (best-effort): when enabled, every injection appends one JSON
// line to ~/.dsh/_sampling-debug.log so you can confirm the outgoing body
// actually carries the sampling params. Enable with env DSH_SAMPLING_DEBUG=1
// or by creating the marker file ~/.dsh/_sampling-debug-on; disable by
// unsetting the env / deleting the file (takes effect on the next apply()).
let debugEnabled = false;

function apply(ctx, config = {}) {
  const log = ctx.logger("sampling-params");
  liveConfig = config;
  try {
    debugEnabled =
      Boolean(process.env.DSH_SAMPLING_DEBUG) ||
      fs.existsSync(path.join(os.homedir(), ".dsh", "_sampling-debug-on"));
  } catch {
    debugEnabled = false;
  }

  // Register a live settings scope on DSH 0.1.x, where `ctx.settings.register`
  // exists. On 0.2.x that method is gone (the settings service moved to a
  // profile-entry model: describe / mutate / configure), so scope stays null
  // and readModel below falls back to the config that 0.2.x re-passes to apply
  // on every restart. The namespace is passed as a plain string (not via
  // `settingsNamespace()`) so importing it never breaks plugin load.
  let scope = null;
  const settings = ctx.settings;
  if (settings && typeof settings.register === "function") {
    try {
      scope = settings.register("sampling-params", Config, { base: config, applies: "live" });
    } catch (error) {
      log.warn(`sampling-params settings.register failed; using config param: ${error?.message ?? error}`);
      scope = null;
    }
  }

  // Read the sampling set for one exact model id/alias. Prefer the live scope
  // (0.1.x); otherwise read the latest config passed to apply (0.2.x restart).
  const readModel = (modelId) => {
    if (scope) {
      try {
        const model = scope.get()?.models?.[modelId];
        if (model) return model;
      } catch {
        // fall through to the config-param path
      }
    }
    try {
      return liveConfig?.models?.[modelId];
    } catch {
      return undefined;
    }
  };

  const registeredModels = (() => {
    try {
      const models = scope ? (scope.get()?.models ?? {}) : (liveConfig?.models ?? {});
      return Object.keys(models);
    } catch {
      return [];
    }
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
              // SGLang names the repetition penalty `repetition_penalty` (llama.cpp
              // uses `repeat_penalty`). Send both so the right one is honored regardless
              // of backend; each server ignores the name it does not know.
              if (typeof model.repeat_penalty === "number") {
                body.repetition_penalty = model.repeat_penalty;
              }
              init.body = JSON.stringify(body);
              if (debugEnabled) {
                try {
                  const injected = {};
                  for (const key of WIRE_KEYS) if (typeof model[key] === "number") injected[key] = model[key];
                  if (typeof model.repeat_penalty === "number") injected.repetition_penalty = model.repeat_penalty;
                  fs.appendFileSync(
                    path.join(os.homedir(), ".dsh", "_sampling-debug.log"),
                    JSON.stringify({ ts: new Date().toISOString(), model: body.model, injected }) + "\n"
                  );
                } catch {
                  // debug logging is best-effort; never break traffic
                }
              }
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
