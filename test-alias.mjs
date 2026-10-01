// Unit test: verify the fetch wrapper injects sampling params into the
// chat-completions wire body based on the model alias.
// Alias names are placeholders — swap to your own llama.cpp aliases.
import { fileURLToPath } from "node:url";

const plugin = await import(new URL("./index.js", import.meta.url).href);

// Simulate a configured sampling-params section.
const section = {
  models: {
    "model-t": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
    "model-i": { temperature: 0.2, top_p: 0.8, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
    "model-p": { temperature: 1.0, top_p: 0.95, top_k: 20, min_p: 0.0, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  },
};

// Capture the wrapped fetch.
let capturedFetch = null;
const ctx = {
  logger: () => ({ warn: () => {}, info: () => {} }),
  settings: { register: () => ({ get: () => section }) },
};

// Stub globalThis.fetch so the plugin wraps it.
const originalFetch = globalThis.fetch;
globalThis.fetch = async function (input, init) {
  capturedFetch = { input, init };
  return new Response("{}", { status: 200 });
};

plugin.apply(ctx, {});

// Restore original fetch after apply.
const wrappedFetch = globalThis.fetch;
globalThis.fetch = originalFetch;

// Helper: call the wrapped fetch with a chat-completions body, return the modified body.
async function callFetch(model) {
  capturedFetch = null;
  const body = { model, messages: [{ role: "user", content: "hi" }], temperature: 1.0 };
  await wrappedFetch("http://localhost:<PORT>/v1/chat/completions", {
    method: "POST",
    body: JSON.stringify(body),
  });
  return JSON.parse(capturedFetch.init.body);
}

const WIRE_KEYS = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty"];
let allPassed = true;

// Case 1: model-t (think) — should inject think sampling.
{
  const wire = await callFetch("model-t");
  console.log("=== model-t (think) ===");
  for (const k of WIRE_KEYS) {
    const expected = section.models["model-t"][k];
    const actual = wire[k];
    const ok = expected === actual;
    if (!ok) allPassed = false;
    console.log(`  ${k.padEnd(20)} expected=${expected}  actual=${actual}  ${ok ? "✅" : "❌"}`);
  }
}

// Case 2: model-i (instruct) — should inject instruct sampling.
{
  const wire = await callFetch("model-i");
  console.log("\n=== model-i (instruct) ===");
  for (const k of WIRE_KEYS) {
    const expected = section.models["model-i"][k];
    const actual = wire[k];
    const ok = expected === actual;
    if (!ok) allPassed = false;
    console.log(`  ${k.padEnd(20)} expected=${expected}  actual=${actual}  ${ok ? "✅" : "❌"}`);
  }
}

// Case 3: model-p (planner) — should inject planner sampling.
{
  const wire = await callFetch("model-p");
  console.log("\n=== model-p (planner) ===");
  for (const k of WIRE_KEYS) {
    const expected = section.models["model-p"][k];
    const actual = wire[k];
    const ok = expected === actual;
    if (!ok) allPassed = false;
    console.log(`  ${k.padEnd(20)} expected=${expected}  actual=${actual}  ${ok ? "✅" : "❌"}`);
  }
}

// Case 4: unconfigured model — should pass through unchanged.
{
  const wire = await callFetch("unconfigured");
  console.log("\n=== unconfigured (passthrough) ===");
  const hasTopP = "top_p" in wire;
  const ok = !hasTopP;
  if (!ok) allPassed = false;
  console.log(`  top_p absent: ${ok ? "✅" : "❌"}`);
  console.log(`  temperature unchanged: ${wire.temperature === 1.0 ? "✅" : "❌"}`);
}

// Case 5: non-chat-completions URL — should pass through unchanged.
{
  capturedFetch = null;
  const body = { model: "model-t", prompt: "hi" };
  await wrappedFetch("http://localhost:<PORT>/v1/completion", {
    method: "POST",
    body: JSON.stringify(body),
  });
  const wire = JSON.parse(capturedFetch.init.body);
  console.log("\n=== /v1/completion (non-target URL) ===");
  const hasTopP = "top_p" in wire;
  const ok = !hasTopP;
  if (!ok) allPassed = false;
  console.log(`  top_p absent: ${ok ? "✅" : "❌"}`);
}

console.log(`\n${allPassed ? "✅ ALL TESTS PASSED" : "❌ SOME TESTS FAILED"}`);
process.exit(allPassed ? 0 : 1);
