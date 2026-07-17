/**
 * SeoAnalyzer — LLM-grounded synthesis of `SeoFinding[]` via the
 * provider-agnostic adapter layer (spec-20260715-ultimate-seo-suite,
 * Sprint 10; arch-20260715-ultimate-seo-agents-skills-architecture.md:242-276).
 *
 * The `llm`/`model` are CONSTRUCTOR-injected (mirrors
 * `SeoPlaybookRetriever(index)`, retriever.ts:121, and
 * `getGroundingVerdict({llm,model})`, grounding-critic.ts:170-177) — the
 * real client is built by the Sprint 11 runner via `createClient`
 * (providers/factory.ts:192); tests inject a scripted fake, never a real
 * provider.
 *
 * Defensive parse (3-tier extraction + zod `safeParse`, copied from
 * `validateGroundingVerdict`, grounding-critic.ts:40-88) NEVER throws on a
 * parse failure — it returns `{ findings: [], parsed: false }`
 * (fail-closed, sc-10-2). A TRANSPORT error from `llm.chat` is a different
 * failure mode and is left to propagate (mirrors
 * grounding-critic.test.ts:273-289) — it is not caught here.
 *
 * `now` is injected (Sprint 10 nonGoal: "Analyzer must not read the clock
 * or the filesystem for time") — this file never constructs a Date object
 * and never looks up the current wall-clock time itself.
 *
 * `context` is typed as `SeoRetrieveResult` (retriever.ts:22-25), the
 * concrete type that already carries `promptFragment` — NOT a
 * `SeoPlaybookContext` (that name appears in the architecture prose but no
 * such type exists in the codebase; see the sprint briefing §0).
 */
import { z } from "zod";
import type { LLMClient } from "../providers/types.js";
import type { SeoWorkflow, SeoFinding, DataOutcome, DataProvenance, SeoSignature } from "./types.js";
import type {
  SearchAnalyticsRow,
  UrlInspectionRow,
  SerpRow,
  KeywordRow,
  BacklinkRow,
  AiVisibilityRow,
  LinkGraphRow,
} from "./data-source.js";
import type { SeoRetrieveResult } from "./retriever.js";
import type { BoberConfig } from "../config/schema.js";

// -- Public types (do NOT exist elsewhere — defined here per the briefing) --

/**
 * Per-capability optional `DataOutcome<Row[]>` — a source may abstain/
 * disable per capability. `aiVisibility`/`linkGraph` were added additively
 * (spec-20260717-seo-improver-builder, Sprint 9; ADR-7) — an arm left
 * `undefined` (a capability `WORKFLOW_CAPABILITIES` omits for the running
 * workflow) renders as "not requested" (`describeDataOutcome` below), never
 * as an error.
 */
export type SeoDataBundle = {
  searchAnalytics?: DataOutcome<SearchAnalyticsRow[]>;
  urlInspection?: DataOutcome<UrlInspectionRow[]>;
  serp?: DataOutcome<SerpRow[]>;
  keywords?: DataOutcome<KeywordRow[]>;
  backlinks?: DataOutcome<BacklinkRow[]>;
  aiVisibility?: DataOutcome<AiVisibilityRow[]>;
  linkGraph?: DataOutcome<LinkGraphRow[]>;
};

export type SeoAnalyzeInput = {
  workflow: SeoWorkflow;
  target: string;
  /** The existing retriever output (retriever.ts:22-25) — the arch calls this `SeoPlaybookContext`. */
  context: SeoRetrieveResult;
  data: SeoDataBundle;
  /**
   * Accepted for interface parity with the architecture's `SeoAnalyzeInput`
   * (arch:250-256) and the Sprint 11 runner contract. Not consumed by this
   * sprint's `analyze` body — `llm`/`model` are constructor-injected, and no
   * analyzer behaviour this sprint reads `config`.
   */
  config: BoberConfig;
  /** Injected wall-clock snapshot (ISO-8601) — the analyzer never reads the clock itself. */
  now: string;
};

export type SeoAnalysis = {
  workflow: SeoWorkflow;
  target: string;
  findings: SeoFinding[];
  /** false when the LLM output could not be parsed (fail-closed, sc-10-2). */
  parsed: boolean;
  dataProvenance: DataProvenance[];
};

// -- Model-facing finding schema (defensive, never trusts the LLM blindly) --

const SeoFindingEvidenceSchema = z.object({
  metric: z.string(),
  value: z.string(),
  source: z.string(),
  url: z.string(),
});

/**
 * What we require the MODEL to emit per finding. `workflow` is deliberately
 * excluded — the analyzer stamps `input.workflow` onto every finding itself
 * rather than trusting the model to echo it back correctly. `severity` is a
 * strict 1..5 literal union: an out-of-range value (e.g. `7`) fails
 * validation rather than silently producing an out-of-range `SeoFinding`.
 */
const SeoModelFindingSchema = z.object({
  recommendation: z.string().min(1),
  playbookRef: z.string().min(1),
  citationUrl: z.string(),
  evidence: z.array(SeoFindingEvidenceSchema).default([]),
  severity: z.union([z.literal(1), z.literal(2), z.literal(3), z.literal(4), z.literal(5)]),
  humanApprovalRequired: z.boolean(),
  confidence: z.enum(["firm", "tentative"]),
});

type SeoModelFinding = z.infer<typeof SeoModelFindingSchema>;

const SeoFindingsContainerSchema = z.object({
  findings: z.array(SeoModelFindingSchema),
});

// -- Prompt construction ------------------------------------------------

const SEO_FINDING_JSON_SHAPE = `{
  "findings": [
    {
      "recommendation": "<concrete, actionable recommendation>",
      "playbookRef": "<the playbookId (from the playbook context above) this recommendation is grounded in>",
      "citationUrl": "<REQUIRED absolute http(s) URL to a primary source backing this recommendation>",
      "evidence": [ { "metric": "<name>", "value": "<observed value>", "source": "<data source>", "url": "<source url>" } ],
      "severity": 1,
      "humanApprovalRequired": false,
      "confidence": "firm"
    }
  ]
}`;

function describeDataOutcome<T>(label: string, outcome: DataOutcome<T> | undefined): string {
  if (outcome === undefined) return `${label}: not requested.`;
  switch (outcome.kind) {
    case "disabled":
      return `${label}: disabled (no data source configured for this capability).`;
    case "abstain":
      return `${label}: abstained — ${outcome.reason}.`;
    case "data":
      return (
        `${label} (source: ${outcome.provenance.source}, retrieved: ${outcome.provenance.retrievedAt}):\n` +
        JSON.stringify(outcome.rows)
      );
    default: {
      const _exhaustive: never = outcome;
      return _exhaustive;
    }
  }
}

function buildDataBundleSummary(data: SeoDataBundle): string {
  return [
    describeDataOutcome("Search Analytics", data.searchAnalytics),
    describeDataOutcome("URL Inspection", data.urlInspection),
    describeDataOutcome("SERP", data.serp),
    describeDataOutcome("Keywords", data.keywords),
    describeDataOutcome("Backlinks", data.backlinks),
    describeDataOutcome("AI Visibility", data.aiVisibility),
    describeDataOutcome("Link Graph", data.linkGraph),
  ].join("\n\n");
}

/** Prompt = the retriever's `promptFragment` + the serialized `DataOutcome` bundle + an explicit output contract. */
function buildSystemPrompt(input: SeoAnalyzeInput): string {
  return [
    `You are an SEO analysis engine for the "${input.workflow}" workflow, target "${input.target}".`,
    `Current reference date/time (for freshness judgments only): ${input.now}.`,
    `Ground every recommendation in the playbook context and the gathered data below — never invent data.`,
    `--- Playbook context ---`,
    input.context.promptFragment,
    `--- Gathered data ---`,
    buildDataBundleSummary(input.data),
    `--- Output contract ---`,
    `Output ONLY a single JSON object (no prose, no markdown fences, no tool calls) with EXACTLY this shape:`,
    SEO_FINDING_JSON_SHAPE,
    `Rules:`,
    `- EVERY finding MUST have a non-empty, well-formed http(s) "citationUrl" pointing to a primary ` +
      `source (an official search-engine/platform documentation page, or a first-party data point ` +
      `already present in the gathered data above). A finding without a well-formed citationUrl will ` +
      `be dropped before it reaches any human or report.`,
    `- Set "humanApprovalRequired": true for any tactic that touches policy compliance or spend ` +
      `(paid links, ad/budget spend, live-API-cost actions, or anything that could trigger a manual ` +
      `search-engine action).`,
    `- "severity" must be an integer from 1 (informational) to 5 (critical).`,
    `- If the evidence is thin or indirect, set "confidence": "tentative" rather than overstating certainty.`,
    `- If there is nothing actionable in the data above, return {"findings": []}.`,
  ].join("\n\n");
}

// -- Defensive parse (3-tier extraction + zod safeParse; NEVER throws) --

type ParseFindingsResult = { ok: true; findings: SeoModelFinding[] } | { ok: false; error: string };

function parseFindingsContainer(rawText: string): ParseFindingsResult {
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

  const result = SeoFindingsContainerSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues.map((i) => `  - ${i.path.join(".")}: ${i.message}`).join("\n");
    return { ok: false, error: issues };
  }

  return { ok: true, findings: result.data.findings };
}

// -- Assembly -------------------------------------------------------------

/**
 * Maps one model-emitted finding onto a full `SeoFinding`, stamping the
 * caller-known `workflow` and applying defense-in-depth for
 * `humanApprovalRequired`: OR the model's value with a lookup — a finding
 * grounded in a `playbookRef` whose matching `SeoSignature.policyClass` is
 * `"human-approve"` is always flagged for human approval, even if the model
 * forgot to set the flag itself.
 *
 * Applies the same signature-driven-override idiom to `confidence`
 * (spec-20260717-seo-improver-builder, Sprint 3, ADR-2): a finding grounded
 * in a signature whose `liveWeightStatus` is `"documented-only"` cannot be
 * emitted as `"firm"` — it is downgraded to `"tentative"`, because
 * "documented" guidance is not (yet) corroborated by a live ranking signal.
 * This is DOWNGRADE-ONLY: `"live-corroborated"`/`"unknown"` never change
 * `confidence`, and there is no branch that upgrades `"tentative"` ->
 * `"firm"`.
 */
function toSeoFinding(
  modelFinding: SeoModelFinding,
  workflow: SeoWorkflow,
  signaturesByPlaybookId: Map<string, SeoSignature>,
): SeoFinding {
  const signature = signaturesByPlaybookId.get(modelFinding.playbookRef);
  const humanApprovalRequired =
    modelFinding.humanApprovalRequired || signature?.policyClass === "human-approve";

  const confidence =
    signature?.liveWeightStatus === "documented-only" && modelFinding.confidence === "firm"
      ? "tentative"
      : modelFinding.confidence;

  return {
    recommendation: modelFinding.recommendation,
    workflow,
    playbookRef: modelFinding.playbookRef,
    citationUrl: modelFinding.citationUrl,
    evidence: modelFinding.evidence,
    severity: modelFinding.severity,
    humanApprovalRequired,
    confidence,
  };
}

function collectDataProvenance(data: SeoDataBundle): DataProvenance[] {
  const provenance: DataProvenance[] = [];
  for (const outcome of [
    data.searchAnalytics,
    data.urlInspection,
    data.serp,
    data.keywords,
    data.backlinks,
    data.aiVisibility,
    data.linkGraph,
  ]) {
    if (outcome?.kind === "data") provenance.push(outcome.provenance);
  }
  return provenance;
}

// -- SeoAnalyzer ------------------------------------------------------------

export class SeoAnalyzer {
  constructor(
    private readonly llm: LLMClient,
    private readonly model: string,
  ) {}

  /**
   * Never throws on a PARSE failure (returns `parsed: false` with empty
   * findings). Does NOT catch a transport error from `llm.chat` — that
   * rejects the returned promise, distinct from a parse failure.
   */
  async analyze(input: SeoAnalyzeInput): Promise<SeoAnalysis> {
    const { workflow, target, context, data } = input;

    const response = await this.llm.chat({
      model: this.model,
      system: buildSystemPrompt(input),
      messages: [{ role: "user", content: "Produce the findings JSON now." }],
      jsonObjectMode: true,
    });

    const dataProvenance = collectDataProvenance(data);
    const parsedResult = parseFindingsContainer(response.text);

    if (!parsedResult.ok) {
      return { workflow, target, findings: [], parsed: false, dataProvenance };
    }

    const signaturesByPlaybookId = new Map(context.signatures.map((s) => [s.playbookId, s]));
    const findings = parsedResult.findings.map((f) => toSeoFinding(f, workflow, signaturesByPlaybookId));

    return { workflow, target, findings, parsed: true, dataProvenance };
  }
}
