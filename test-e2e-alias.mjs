// Real end-to-end: the plugin intercepts `llm/stream`, installs an `onPayload`
// hook that stamps sampling onto the wire body, and we confirm llama-server
// adopted it via the /slots endpoint.
//
// NOTE: alias names and host/port are placeholders — swap `model-t`, the /slots
// `model` query, and `http://<host>:<port>` to your own llama-server. The
// plugin never hardcodes a port; it comes from your dsh provider baseURL.
import { fileURLToPath } from "node:url";

const plugin = await import(new URL("./index.js", import.meta.url).href);

const section = {
  models: {
    "llama:model-t": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  },
};

// Capture the llm/stream listener.
let capturedListener = null;
const ctx = {
  logger: () => ({ warn: () => {}, info: () => {} }),
  settings: { register: () => ({ get: () => section }) },
  on: (event, listener) => { if (event === "llm/stream") capturedListener = listener; },
};
plugin.apply(ctx, {});

// Run the llm/stream listener to install the onPayload hook for this call.
const options = { provider: "llama", model: "model-t" };
await capturedListener(options, () => {});
const onPayload = options.onPayload;

// Build the wire body the way pi-ai does, then let onPayload stamp sampling.
const wire = { model: "model-t", messages: [{ role: "user", content: "Reply with exactly: OK" }], max_tokens: 12 };
onPayload?.(wire, { provider: "llama", id: "model-t" });

// 1) Send the (stamped) wire body to a real llama-server.
const chatResp = await fetch("http://<host>:<port>/v1/chat/completions", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ ...wire, stream: false }),
});
const chatJson = await chatResp.json();
console.log("E2E chat/completions STATUS:", chatResp.status);
console.log("E2E content:", JSON.stringify(chatJson.choices?.[0]?.message?.content));

// 2) Read the slot for the served model and confirm the sampling was adopted.
const slotResp = await fetch("http://<host>:<port>/slots?model=model-base");
const slot = await slotResp.json();
const gs = Array.isArray(slot) ? slot[0]?.params : slot?.params;
console.log("\n=== llama-server adopted (think role values) via /slots ===");
for (const k of ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty"]) {
  const expected = section.models["llama:model-t"][k];
  const actual = gs?.[k];
  const match = Math.abs(expected - actual) < 0.001;
  console.log(`  ${k.padEnd(20)} expected=${expected}  server=${actual}  ${match ? "✅ APPLIED" : "❌ NOT APPLIED"}`);
}
