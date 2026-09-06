// Verify the provider/model → sampling injection. The plugin intercepts the
// `llm/stream` waterfall, reads options.provider + options.model, and installs
// an `onPayload` hook that stamps the matching sampling set onto the wire body.
// Alias names are placeholders — swap to your own llama.cpp aliases.
import { fileURLToPath } from "node:url";

const plugin = await import(new URL("./index.js", import.meta.url).href);

// Simulate a configured sampling-params section: provider-qualified + bare keys.
const section = {
  models: {
    "llama:model-t": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
    "nvidia:model-t": { temperature: 1.0, top_p: 0.9, top_k: 50, min_p: 0.0, repeat_penalty: 1.1, presence_penalty: 0.5, frequency_penalty: 0.5 },
    "model-i": { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  },
};

// Capture the llm/stream listener registered by the plugin.
let capturedListener = null;
const ctx = {
  logger: () => ({ warn: () => {}, info: () => {} }),
  settings: { register: () => ({ get: () => section }) },
  on: (event, listener) => { if (event === "llm/stream") capturedListener = listener; },
};
plugin.apply(ctx, {});

// Run the listener as dsh does: (options, next). Returns the onPayload hook.
async function run(options) {
  let nextCalled = false;
  await capturedListener(options, () => { nextCalled = true; });
  return { onPayload: options.onPayload, nextCalled };
}

// Case 1: provider:model composite match (llama:model-t).
{
  const o = { provider: "llama", model: "model-t" };
  const { onPayload, nextCalled } = await run(o);
  const wire = { model: "model-t", messages: [] };
  onPayload?.(wire, { provider: "llama", id: "model-t" });
  console.log("=== llama:model-t (composite) ===");
  for (const k of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty"]) {
    const expected = section.models["llama:model-t"][k];
    const actual = wire[k];
    console.log(`  ${k.padEnd(20)} expected=${expected}  actual=${actual}  ${expected === actual ? "✅" : "❌"}`);
  }
  console.log("  next() called:", nextCalled);
}

// Case 2: same model id under a different provider — composite distinguishes.
{
  const o = { provider: "nvidia", model: "model-t" };
  const { onPayload } = await run(o);
  const wire = { model: "model-t", messages: [] };
  onPayload?.(wire, { provider: "nvidia", id: "model-t" });
  console.log("\n=== nvidia:model-t (same model id, different provider) ===");
  console.log(`  temperature=${wire.temperature} (expected 1.0)  top_p=${wire.top_p} (expected 0.9)`);
  console.log(`  provider distinguished: ${wire.temperature === 1.0 ? "✅" : "❌"}`);
}

// Case 3: bare model fallback (no composite entry for this provider).
{
  const o = { provider: "deepseek", model: "model-i" };
  const { onPayload } = await run(o);
  const wire = { model: "model-i", messages: [] };
  onPayload?.(wire, { provider: "deepseek", id: "model-i" });
  console.log("\n=== deepseek:model-i (bare fallback) ===");
  console.log(`  temperature=${wire.temperature} (expected 0.2)  top_p=${wire.top_p} (expected 0.8)`);
  console.log(`  fallback matched: ${wire.temperature === 0.2 ? "✅" : "❌"}`);
}

// Case 4: no matching sampling — passthrough, no onPayload.
{
  const o = { provider: "llama", model: "unconfigured" };
  const { onPayload, nextCalled } = await run(o);
  console.log("\n=== llama:unconfigured (no match) ===");
  console.log("  onPayload set:", onPayload !== undefined, "(should be false)");
  console.log("  next() called:", nextCalled, "(should be true)");
}
