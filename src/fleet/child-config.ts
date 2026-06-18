import { BoberConfigSchema, createDefaultConfig } from "../config/schema.js";
import type { BoberConfig } from "../config/schema.js";
import type { FleetChild } from "./manifest.js";
import { tierPolicy } from "./tier-policy.js";

// ── DeepSeek / openai-compat constants ──────────────────────────────

const DEEPSEEK_PROVIDER = "openai-compat";
const DEEPSEEK_ENDPOINT = "https://api.deepseek.com";
const DEEPSEEK_MODEL = "deepseek-v4-pro";

// ── Builder ──────────────────────────────────────────────────────────

/**
 * Build a Zod-valid BoberConfig for a fleet child process.
 *
 * Starts from createDefaultConfig() with the DeepSeek (openai-compat)
 * provider set on planner, generator, and evaluator, then shallow-merges
 * child.config top-level keys over the base (a child top-level key fully
 * replaces the base value — no deep merge).
 */
export function buildChildConfig(child: FleetChild): BoberConfig {
  const base = createDefaultConfig(child.folder, "greenfield");

  base.planner = {
    ...base.planner,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };
  base.generator = {
    ...base.generator,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };
  base.evaluator = {
    ...base.evaluator,
    model: DEEPSEEK_MODEL,
    provider: DEEPSEEK_PROVIDER,
    endpoint: DEEPSEEK_ENDPOINT,
  };

  const block = tierPolicy.resolveTier(child.tier);
  if (block) {
    base.planner = { ...base.planner, ...block.planner };
    base.generator = { ...base.generator, ...block.generator };
    base.evaluator = { ...base.evaluator, ...block.evaluator };
  }

  const merged = { ...base, ...(child.config ?? {}) };
  return BoberConfigSchema.parse(merged);
}
