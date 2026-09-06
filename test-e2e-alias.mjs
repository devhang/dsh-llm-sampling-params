// Real end-to-end: the fetch wrapper stamps sampling onto the wire body,
// we send it to a real llama-server, and confirm /slots adopted the values.
//
// NOTE: alias names and host/port are placeholders — swap `model-t` and
// `http://<host>:<port>` to your own llama-server. The plugin never
// hardcodes a port; it comes from your dsh provider baseURL.
import { fileURLToPath } from "node:url";

const plugin = await import(new URL("./index.js", import.meta.url).href);

const section = {
  models: {
    "model-t": { temperature: 0.6, top_p: 0.95, top_k: 20, min_p: 0.05, repeat_penalty: 1.0, presence_penalty: 0.0, frequency_penalty: 0.0 },
  },
};

const ctx = {
  logger: () => ({ warn: () => {}, info: () => {} }),
  settings: { register: () => ({ get: () => section }) },
};

// The plugin wraps globalThis.fetch on apply.
plugin.apply(ctx, {});

// Build the wire body the way pi-ai does.
const wire = {
  model: "model-t",
  messages: [{ role: "user", content: "Reply with exactly: OK" }],
  max_tokens: 12,
};

// 1) Send the wire body through the wrapped fetch to a real llama-server.
//    The wrapper will stamp the sampling params onto the body.
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
const WIRE_KEYS = ["temperature", "top_p", "top_k", "min_p", "repeat_penalty", "presence_penalty", "frequency_penalty"];
let allMatch = true;
for (const k of WIRE_KEYS) {
  const expected = section.models["model-t"][k];
  const actual = gs?.[k];
  const match = Math.abs(expected - actual) < 0.001;
  if (!match) allMatch = false;
  console.log(`  ${k.padEnd(20)} expected=${expected}  server=${actual}  ${match ? "✅ APPLIED" : "❌ NOT APPLIED"}`);
}

console.log(`\n${allMatch ? "✅ E2E PASSED" : "❌ E2E FAILED"}`);
process.exit(allMatch ? 0 : 1);
