/**
 * SeoRecommendationVerifier — opt-in, downgrade-only, fail-closed adversarial
 * verifier (spec-20260715-ultimate-seo-suite, Sprint 12).
 *
 * Mirrors two precedents:
 * - The security verifier's fold semantics and fail-closed result shape
 *   (`src/orchestrator/security-verifier-agent.ts`, and the fold at
 *   `src/orchestrator/security-auditor-agent.ts:338-354`): `ran===false`
 *   (disabled/parse-failure/provider-error/refusal) returns the input
 *   findings UNCHANGED; on success, `disproved` drops a finding,
 *   `downgraded` lowers its severity by one (floored at 1), and
 *   `confirmed`/unaddressed keeps it unchanged. The new set is always a
 *   strict SUBSET with severities only ever moving DOWN — never
 *   promoted, added, or raised.
 * - The SEO analyzer's single-shot injected-`LLMClient` + 3-tier defensive
 *   parse (`src/seo/analyzer.ts:187-226,280-301`). Unlike the security
 *   verifier, this is a single `llm.chat` call — NOT an agentic loop (no
 *   `runAgenticLoop`/`resolveRoleTools`, nothing to Read/Grep/Glob: SEO
 *   findings cite external URLs, and there is no local evidence to
 *   re-check).
 *
 * NEVER throws: any disabled-flag short-circuit, agent-md-load failure,
 * provider/transport error, or parse failure resolves
 * `{ ran:false, findings }` — the caller (`SeoWorkflowRunner`) keeps the
 * citation gate's findings UNCHANGED (fail-closed, sc-12-3). This is the
 * key divergence from `SeoAnalyzer.analyze`, which propagates transport
 * errors — the verifier is an opt-in stage whose failure must never flip
 * the run's exit code (sc-12-4).
 *
 * Gated on `config.seo?.verifier?.enabled` (schema.ts:688, default false,
 * pre-existing from Sprint 1) at TWO layers, defense-in-depth: the runner
 * (`src/seo/runner.ts`) never constructs or calls a verifier at all when
 * disabled (so a disabled run makes zero provider calls, sc-12-2), and
 * `verify()` itself also short-circuits on the flag so a caller that
 * constructs a `SeoRecommendationVerifier` directly can't accidentally
 * trigger a provider call either.
 */
import { z } from "zod";
import type { LLMClient } from "../providers/types.js";
import { createClient } from "../providers/factory.js";
import { loadAgentDefinition } from "../orchestrator/agent-loader.js";
import { logger } from "../utils/logger.js";
import type { BoberConfig } from "../config/schema.js";
import type { SeoFinding } from "./types.js";

// -- Public types --------------------------------------------------------

export interface SeoVerifyParams {
  /** The citation gate's `cited` findings — the ONLY findings the verifier ever sees. */
  findings: SeoFinding[];
  config: BoberConfig;
  projectRoot: string;
  /** Injected wall-clock snapshot (ISO-8601) — the verifier never reads the clock itself. */
  now: string;
  /** TEST injection — default = a real client via `createClient(...)`. Tests pass a ScriptedClient. */
  llm?: LLMClient;
}

export interface SeoVerifyResult {
  /** False on disabled/parse-failure/provider-error (fail-closed) — `findings` is then the UNCHANGED input. */
  ran: boolean;
  findings: SeoFinding[];
}

/** Injectable seam so `runner.test.ts` can stub the stage (mirrors `SeoRunInput.analyzer`). */
export interface SeoVerifier {
  verify(params: SeoVerifyParams): Promise<SeoVerifyResult>;
}

// -- Model-facing verdict schema (defensive, never trusts the LLM blindly) --

const SeoVerdictSchema = z.object({
  index: z.number().int().min(0),
  verdict: z.enum(["confirmed", "downgraded", "disproved"]),
  confidence: z.enum(["high", "medium", "low"]),
  reason: z.string(),
});

type SeoVerdict = z.infer<typeof SeoVerdictSchema>;

const SeoVerdictsContainerSchema = z.object({
  verdicts: z.array(SeoVerdictSchema),
});

// -- Defaults -------------------------------------------------------------

/** No `config.seo.verifier.model` field exists (schema.ts:688 has ONLY `enabled`) — this is the sole default. */
const DEFAULT_SEO_VERIFIER_MODEL = "sonnet";

function buildDefaultClient(): LLMClient {
  // createClient is the ONLY place SDKs are imported (mirrors runner.ts's buildDefaultAnalyzer).
  return createClient(undefined, null, undefined, DEFAULT_SEO_VERIFIER_MODEL, "SeoVerifier");
}

// -- Prompt assembly --------------------------------------------------------

/**
 * Builds the verifier's user message from ONLY the findings + the injected
 * `now`. Deliberately excludes any sprint/contract framing — the agent md
 * (loaded as the `system` prompt) is the fresh, contract-free adversary; this
 * message carries just the evidence to judge.
 */
function buildVerifierUserMessage(findings: SeoFinding[], now: string): string {
  const findingsJson = JSON.stringify(
    findings.map((finding, index) => ({ index, ...finding })),
    null,
    2,
  );

  return [
    `Current reference date/time (for freshness judgments only): ${now}.`,
    ``,
    `# Findings To Verify`,
    ``,
    findingsJson,
    ``,
    `# Your Task`,
    ``,
    `For each finding above, attempt to DISPROVE it: is the citationUrl a genuine primary source that ` +
      `actually backs the recommendation? Does the evidence actually support the claimed severity? Is ` +
      `anything invented, overstated, or unsupported?`,
    ``,
    `Render one verdict per finding: "confirmed" (it holds — stays at its original severity), "downgraded" ` +
      `(real but overstated — severity moves down by one), or "disproved" (the evidence does not support ` +
      `it — dropped entirely).`,
    ``,
    `Output ONLY a single JSON object (no prose, no markdown fences), one entry per finding, in this exact shape:`,
    `{"verdicts":[{"index":0,"verdict":"confirmed","confidence":"high","reason":"<one-line reason>"}]}`,
  ].join("\n");
}

// -- Defensive parse (3-tier extraction + zod safeParse; NEVER throws) --

type ParseVerdictsResult = { ok: true; verdicts: SeoVerdict[] } | { ok: false; error: string };

/** Mirrors `analyzer.ts:parseFindingsContainer` verbatim, swapping the container schema. */
function parseVerdictsContainer(rawText: string): ParseVerdictsResult {
  let parsed: unknown;

  try {
    parsed = JSON.parse(rawText.trim());
  } catch {
    // Tier 2: extract from a fenced ```json ... ``` block.
    const fenceMatch = /```(?:json)?\s*\n?([\s\S]*?)\n?\s*```/.exec(rawText);
    if (fenceMatch) {
      try {
        parsed = JSON.parse(fenceMatch[1].trim());
      } catch {
        // fall through to tier 3
      }
    }

    // Tier 3: take the first { ... last } span.
    if (parsed === undefined) {
      const braceStart = rawText.indexOf("{");
      const braceEnd = rawText.lastIndexOf("}");
      if (braceStart !== -1 && braceEnd > braceStart) {
        try {
          parsed = JSON.parse(rawText.slice(braceStart, braceEnd + 1));
        } catch {
          return { ok: false, error: `No valid JSON object found in response. Raw: ${rawText.slice(0, 200)}` };
        }
      } else {
        return { ok: false, error: `No JSON object found in response. Raw: ${rawText.slice(0, 200)}` };
      }
    }
  }

  const result = SeoVerdictsContainerSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, verdicts: result.data.verdicts };
}

// -- Downgrade-only fold (structural — no code path raises/adds) ----------

/**
 * Folds verdicts onto `findings` by 0-based `index`. `disproved` drops the
 * finding; `downgraded` lowers `severity` by exactly one, floored at 1
 * (input `severity` is always `1..5`, so `severity-1` is always `0..4`,
 * floored to `1..4` — the cast is safe); `confirmed` OR an unaddressed
 * finding (no matching verdict entry, or an out-of-range `index` the model
 * invented) is kept byte-unchanged. There is no branch here that raises a
 * severity or pushes a finding not already present in `findings` — the
 * downgrade-only guarantee is structural, not trusted from the model.
 */
function applyVerdicts(findings: SeoFinding[], verdicts: SeoVerdict[]): SeoFinding[] {
  const byIndex = new Map(verdicts.map((v) => [v.index, v]));
  const out: SeoFinding[] = [];

  findings.forEach((finding, i) => {
    const v = byIndex.get(i);
    if (v?.verdict === "disproved") return;
    if (v?.verdict === "downgraded") {
      const lowered = Math.max(1, finding.severity - 1) as SeoFinding["severity"];
      out.push({ ...finding, severity: lowered });
      return;
    }
    out.push(finding); // "confirmed" OR unaddressed — fail-closed default: keep unchanged.
  });

  return out;
}

// -- SeoRecommendationVerifier ---------------------------------------------

export class SeoRecommendationVerifier implements SeoVerifier {
  /**
   * Never throws. Resolves `{ ran:false, findings }` (input UNCHANGED) when
   * disabled, when the agent md can't be loaded, on any provider/transport
   * error, or when the response can't be parsed into a valid verdicts
   * container. Resolves `{ ran:true, findings:<folded> }` on a successful,
   * parseable response — always a subset of the input with severities only
   * moving down.
   */
  async verify(params: SeoVerifyParams): Promise<SeoVerifyResult> {
    const { findings, config, projectRoot, now } = params;

    // Nothing to verify — clean no-op, no LLM call needed either way
    // (mirrors runSecurityVerifier's empty-findings short-circuit).
    if (findings.length === 0) {
      return { ran: true, findings };
    }

    // Defense-in-depth (sc-12-2): even a caller that constructs
    // SeoRecommendationVerifier directly and bypasses the runner's own gate
    // (Pattern E) can never trigger a provider call when the flag is off.
    if (config.seo?.verifier?.enabled !== true) {
      return { ran: false, findings };
    }

    try {
      const definition = await loadAgentDefinition("bober-seo-verifier", projectRoot);
      const llm = params.llm ?? buildDefaultClient();

      const response = await llm.chat({
        model: DEFAULT_SEO_VERIFIER_MODEL,
        system: definition.systemPrompt,
        messages: [{ role: "user", content: buildVerifierUserMessage(findings, now) }],
        jsonObjectMode: true,
      });

      const parsedResult = parseVerdictsContainer(response.text);
      if (!parsedResult.ok) {
        logger.debug(`[seo-verifier] parse failed: ${parsedResult.error} — fail-closed`);
        return { ran: false, findings };
      }

      return { ran: true, findings: applyVerdicts(findings, parsedResult.verdicts) };
    } catch (err) {
      // Agent-md-load failure, provider/network error, or any other throw —
      // fail-closed, never propagate a crash out of an opt-in stage.
      logger.debug(
        `[seo-verifier] failed: ${err instanceof Error ? err.message : String(err)} — fail-closed`,
      );
      return { ran: false, findings };
    }
  }
}
