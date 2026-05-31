#!/usr/bin/env node
// SPIKE: verify DeepSeek works through the EXISTING openai-compat adapter,
// including TOOL CALLING (the capability that makes it usable for ALL roles,
// unlike the claude-code provider). No new adapter code — this is the whole point.
//
//   DEEPSEEK_API_KEY=sk-... node scripts/spike-deepseek.mjs
//
// Run `npm run build` first (imports compiled dist).

import { createClient } from "../dist/providers/factory.js";

const key = process.env.DEEPSEEK_API_KEY;
if (!key) {
  console.log("SKIP: DEEPSEEK_API_KEY not set — skipping DeepSeek smoke.");
  process.exit(0);
}

function assert(c, m) { if (!c) { console.error("ASSERT FAILED:", m); process.exit(1); } }

// Existing openai-compat adapter, pointed at DeepSeek's OpenAI-compatible endpoint.
const client = createClient(
  "openai-compat",
  "https://api.deepseek.com",
  { apiKey: key },
  "deepseek-v4-pro",
  "Spike",
);

console.log("── Spike 1: plain completion via DeepSeek (openai-compat) ──");
const r1 = await client.chat({
  model: "deepseek-v4-pro",
  system: "You are terse. One sentence, no preamble.",
  messages: [{ role: "user", content: "What is a code knowledge graph, in one sentence?" }],
});
console.log("text:", JSON.stringify(r1.text).slice(0, 200));
console.log("stopReason:", r1.stopReason, "| usage:", JSON.stringify(r1.usage));
assert(typeof r1.text === "string" && r1.text.length > 0, "text non-empty");

console.log("\n── Spike 2: TOOL CALLING (the differentiator vs claude-code) ──");
const r2 = await client.chat({
  model: "deepseek-v4-pro",
  system: "You are an agent. When asked to read a file, you MUST call the read_file tool. Do not answer directly.",
  messages: [{ role: "user", content: "Read the file src/index.ts and tell me what it does." }],
  tools: [
    {
      name: "read_file",
      description: "Read a file from the project by path.",
      input_schema: {
        type: "object",
        properties: { file_path: { type: "string", description: "Path to read" } },
        required: ["file_path"],
      },
    },
  ],
});
console.log("stopReason:", r2.stopReason);
console.log("toolCalls:", JSON.stringify(r2.toolCalls, null, 2));
console.log("usage:", JSON.stringify(r2.usage));
assert(r2.toolCalls.length > 0, "DeepSeek should emit a tool_use call");
assert(r2.toolCalls[0].name === "read_file", "should call read_file");
assert(typeof r2.toolCalls[0].input?.file_path === "string", "tool input should parse with file_path");

console.log("\nDEEPSEEK SPIKE PASSED — existing openai-compat adapter drives DeepSeek WITH tool calling, all roles, zero new code.");
