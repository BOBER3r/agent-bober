#!/usr/bin/env node
// SPIKE runner: prove ClaudeCodeAdapter satisfies LLMClient.chat() end-to-end
// against the user's Claude subscription (NO ANTHROPIC_API_KEY).
//
//   node scripts/spike-claude-code-provider.mjs
//
// Builds nothing; imports the compiled dist adapter (run `npm run build` first).
// Exercises the real `claude -p` subprocess. Prints the normalized ChatResponse
// and asserts the contract shape. Also demonstrates the tools-rejection guard.

import { spawnSync } from "node:child_process";
import { ClaudeCodeAdapter } from "../dist/providers/claude-code.js";

const probe = spawnSync("claude", ["--version"], { stdio: "ignore" });
if (probe.error || probe.status !== 0) {
  console.log("SKIP: `claude` binary not on PATH — skipping claude-code smoke.");
  process.exit(0);
}

function assert(cond, msg) {
  if (!cond) {
    console.error("ASSERT FAILED:", msg);
    process.exit(1);
  }
}

const adapter = new ClaudeCodeAdapter();

console.log("── Spike 1: no-tools planner-style completion (real subscription call) ──");
const res = await adapter.chat({
  model: "haiku", // cheapest for a spike; proves the seam without burning credit
  system:
    "You are a terse planning assistant. Answer in one short sentence, no preamble.",
  messages: [
    { role: "user", content: "Name one risk of building a feature without tests." },
  ],
});

console.log("text:", JSON.stringify(res.text));
console.log("stopReason:", res.stopReason);
console.log("usage:", JSON.stringify(res.usage));

assert(typeof res.text === "string" && res.text.length > 0, "text should be non-empty");
assert(Array.isArray(res.toolCalls) && res.toolCalls.length === 0, "toolCalls should be empty");
assert(typeof res.usage.inputTokens === "number", "usage.inputTokens should be a number");
assert(typeof res.usage.outputTokens === "number", "usage.outputTokens should be a number");
console.log("✓ ChatResponse contract satisfied via subscription (no API key)\n");

console.log("── Spike 2: tools guard must throw (honest about the limitation) ──");
let threw = false;
try {
  await adapter.chat({
    model: "haiku",
    system: "x",
    messages: [{ role: "user", content: "y" }],
    tools: [
      { name: "do_thing", description: "d", input_schema: { type: "object", properties: {} } },
    ],
  });
} catch (err) {
  threw = true;
  console.log("✓ threw as designed:", err.message.split(":")[0]);
}
assert(threw, "adapter must reject custom tools rather than silently drop them");

console.log("\nSPIKE PASSED — claude -p backs LLMClient for no-tools roles on the subscription.");
