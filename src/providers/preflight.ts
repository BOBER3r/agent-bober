import { resolveProviderModel } from "../orchestrator/model-resolver.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "../config/schema.js";

/** Providers that require the optional `openai` peer package. */
const OPENAI_FAMILY = new Set(["openai", "openai-compat"]);

/** The actionable hint string. MUST contain 'npm install openai'. */
export const OPENAI_PEER_HINT =
  'A configured role uses an OpenAI-family provider (openai/openai-compat/DeepSeek), ' +
  'but the optional "openai" package is not installed. Run: npm install openai';

/**
 * Injectable importer so tests can simulate openai present/absent without
 * touching the real module graph. Mirrors the getClient() pattern in openai.ts.
 */
export type OpenaiImporter = () => Promise<unknown>;

const defaultImporter: OpenaiImporter = () => {
  // Construct the specifier at runtime so TypeScript does not attempt
  // to statically resolve the optional peer dependency at compile time.
  const specifier = "openai";
  return import(/* @vite-ignore */ specifier);
};

/** Returns true if any configured role resolves to an openai-family provider. */
export function usesOpenaiFamily(config: Partial<BoberConfig>): boolean {
  const sections = [
    config.planner,
    config.curator,
    config.generator,
    config.evaluator,
    config.codeReview,
  ];
  for (const section of sections) {
    if (!section?.model) continue;
    const { provider } = resolveProviderModel(
      section.model,
      section.provider,
    );
    if (OPENAI_FAMILY.has(provider)) return true;
  }
  return false;
}

/**
 * Preflight: if an openai-family provider is configured but the openai package
 * is absent, emit an install hint via logger.warn and return the hint string.
 * If openai is installed OR no openai-family role is configured, return null.
 * NEVER throws — this is a warning/hint only.
 *
 * @param config - The bober config (or partial). Scans planner/curator/generator/evaluator/codeReview roles.
 * @param importer - Injectable importer for testability (default: dynamic import("openai")).
 * @returns The hint string (contains 'npm install openai') if missing, otherwise null.
 */
export async function preflightOpenaiPeer(
  config: Partial<BoberConfig>,
  importer: OpenaiImporter = defaultImporter,
): Promise<string | null> {
  if (!usesOpenaiFamily(config)) return null; // sc-3-4: anthropic-only => null
  try {
    await importer(); // sc-3-3: openai present => no hint
    return null;
  } catch {
    logger.warn(OPENAI_PEER_HINT); // sc-3-2: openai absent => emit hint
    return OPENAI_PEER_HINT;
  }
}
