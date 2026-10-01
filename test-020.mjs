// Unit test: DSH 0.2.x compatibility path.
//
// In 0.2.x the settings service no longer exposes `register` (it is a
// profile-entry model: describe / mutate / configure). A settings edit
// restarts the plugin fiber and re-runs apply(ctx, config) with the new
// config, so the plugin must read the `config` param (via a module-level
// liveConfig), not a scope. This test drives that path and confirms the
// config is refreshed across a simulated restart.
import { fileURLToPath } from "node:url";

const plugin = await import(new URL("./index.js", import.meta.url).href);

// Two versions of the models table; v2 changes model-t's temperature (as a
// settings edit would).
const modelsV1 = {
  "model-t": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  "model-i": { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
};
const modelsV2 = {
  "model-t": { temperature: 0.1, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  "model-i": { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
};

// 0.2.0 settings service shape: describe / mutate / configure, NO register.
const ctx020 = {
  logger: () => ({ warn: () => {}, info: () => {} }),
  settings: { describe: () => [], mutate: async () => {}, configure: () => () => {} },
};

// Capture the wrapped fetch.
let captured = null;
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  captured = { input, init };
  return new Response("{}", { status: 200 });
};

// Initial apply with v1 config.
plugin.apply(ctx020, { models: modelsV1 });
const wrappedFetch = globalThis.fetch;
globalThis.fetch = originalFetch;

async function callFetch(model) {
  captured = null;
  const body = { model, messages: [{ role: "user", content: "hi" }], temperature: 1.0 };
  await wrappedFetch("http://localhost:<PORT>/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return JSON.parse(captured.init.body);
}

let allPassed = true;
const check = (label, cond) => {
  allPassed = allPassed && cond;
  console.log(`  ${cond ? "✅" : "❌"} ${label}`);
};

// Phase 1: v1 config active.
{
  console.log("=== 0.2.0 initial (v1) ===");
  const wt = await callFetch("model-t");
  check("model-t temperature = 0.6 (v1)", wt.temperature === 0.6);
  check("model-t top_p = 0.95", wt.top_p === 0.95);
  check("model-t top_k = 20", wt.top_k === 20);
  const wi = await callFetch("model-i");
  check("model-i temperature = 0.2 (v1)", wi.temperature === 0.2);
}

// Phase 2: simulate a 0.2.x settings edit -> fiber restart -> apply re-run
// with the v2 config. The already-installed wrapper must now read v2.
plugin.apply(ctx020, { models: modelsV2 });
{
  console.log("\n=== 0.2.0 after restart (v2) ===");
  const wt = await callFetch("model-t");
  check("model-t temperature = 0.1 (v2, updated by restart)", wt.temperature === 0.1);
  check("model-t top_p still 0.95", wt.top_p === 0.95);
  const wi = await callFetch("model-i");
  check("model-i temperature = 0.2 (unchanged in v2)", wi.temperature === 0.2);
}

// Phase 3: unconfigured model passes through untouched.
{
  console.log("\n=== 0.2.0 unconfigured (passthrough) ===");
  const w = await callFetch("unconfigured");
  check("top_p absent", !("top_p" in w));
  check("temperature unchanged (1.0)", w.temperature === 1.0);
}

console.log(`\n${allPassed ? "✅ ALL 0.2.0 TESTS PASSED" : "❌ SOME 0.2.0 TESTS FAILED"}`);
process.exit(allPassed ? 0 : 1);
