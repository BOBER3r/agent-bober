/** Medical inference resolver — local-default fail-closed; cloud only behind cloud-inference (Sprint 3). */
import type { BoberConfig } from "../config/schema.js";
import type { LLMClient } from "../providers/types.js";
import type { EgressGuard } from "./egress.js";
import { createClient } from "../providers/factory.js";

// ── Local default (non-egressing) ────────────────────────────────────

/** The local Ollama default — provider openai-compat, localhost endpoint, llama3. Treated as non-egressing. */
const LOCAL = {
  provider: "openai-compat",
  endpoint: "http://localhost:11434/v1",
  model: "llama3",
} as const;

/** Injectable factory seam so tests can spy without real network. Defaults to the real createClient. */
export type ClientFactory = typeof createClient;

// ── buildMedicalInferenceClient ──────────────────────────────────────

/**
 * Resolve the synthesis/critic LLMClient + model from config, gated by cloud-inference.
 *
 * - No inference config => exact local default (back-compat, byte-identical to engine.ts:402).
 * - inference points at the local provider/endpoint => used as-is (non-egressing).
 * - inference points at a CLOUD provider/endpoint AND cloud-inference is OFF => FAIL CLOSED to local.
 * - cloud config AND cloud-inference is ON => the configured cloud client/model is built.
 *
 * The local-vs-cloud decision lives ONLY here; createClient is the sole client-construction seam.
 */
export function buildMedicalInferenceClient(
  config: BoberConfig,
  egress: EgressGuard,
  factory: ClientFactory = createClient,
): { client: LLMClient; model: string } {
  const inf = config.medical?.inference;

  const wantProvider = inf?.provider ?? LOCAL.provider;
  const wantEndpoint = inf?.endpoint ?? LOCAL.endpoint;
  // "Local" = openai-compat against a localhost endpoint. Anything else is treated as cloud.
  const isLocal = wantProvider === LOCAL.provider && wantEndpoint.includes("localhost");

  // FAIL CLOSED: cloud config requested but the cloud-inference axis is not opted in.
  if (!isLocal && !egress.isAllowed("cloud-inference")) {
    return {
      client: factory(LOCAL.provider, LOCAL.endpoint, undefined, LOCAL.model),
      model: LOCAL.model,
    };
  }

  // Either local, or cloud-with-opt-in: honour the (possibly overridden) config.
  const provider = inf?.provider ?? LOCAL.provider;
  const endpoint = inf?.endpoint ?? LOCAL.endpoint;
  const model = inf?.model ?? LOCAL.model;
  return { client: factory(provider, endpoint, undefined, model), model };
}
