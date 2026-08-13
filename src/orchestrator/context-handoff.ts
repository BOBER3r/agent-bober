import { z } from "zod";
import { PlanSpecSchema, type PlanSpec } from "../contracts/spec.js";
import {
  SprintContractSchema,
  type SprintContract,
} from "../contracts/sprint-contract.js";

// ── Enums ───────────────────────────────────────────────────────────

export const AgentRoleSchema = z.enum([
  "planner",
  "generator",
  "evaluator",
  "human",
]);
export type AgentRole = z.infer<typeof AgentRoleSchema>;

// ── Decision ────────────────────────────────────────────────────────

export const DecisionSchema = z.object({
  timestamp: z.string().datetime(),
  description: z.string().min(1),
  rationale: z.string().min(1),
  madeBy: AgentRoleSchema,
});
export type Decision = z.infer<typeof DecisionSchema>;

// ── Project Context ─────────────────────────────────────────────────

export const ProjectContextSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  techStack: z.array(z.string()),
  entryPoints: z.array(z.string()),
  currentBranch: z.string(),
});
export type ProjectContext = z.infer<typeof ProjectContextSchema>;

// ── Context Handoff ─────────────────────────────────────────────────

export const ContextHandoffSchema = z.object({
  timestamp: z.string().datetime(),
  from: AgentRoleSchema,
  to: AgentRoleSchema,
  projectContext: ProjectContextSchema,
  spec: PlanSpecSchema,
  currentContract: SprintContractSchema.optional(),
  sprintHistory: z.array(SprintContractSchema),
  instructions: z.string(),
  changedFiles: z.array(z.string()),
  decisions: z.array(DecisionSchema),
  issues: z.array(z.string()),
});
export type ContextHandoff = z.infer<typeof ContextHandoffSchema>;

// ── Summarized Sprint (for compaction) ──────────────────────────────

interface SprintSummary {
  contractId: string;
  specId: string;
  sprintNumber: number;
  title: string;
  status: SprintContract["status"];
  startedAt?: string;
  completedAt?: string;
}

function summarizeSprint(contract: SprintContract): SprintSummary {
  return {
    contractId: contract.contractId,
    specId: contract.specId,
    sprintNumber: contract.sprintNumber,
    title: contract.title,
    status: contract.status,
    startedAt: contract.startedAt,
    completedAt: contract.completedAt,
  };
}

// ── Prompt-size bounds ──────────────────────────────────────────────

/**
 * How many trailing sprints `summarizeOlderSprints` keeps in FULL detail.
 *
 * This is what every call site already passed by hand; it is named here so the
 * prompt path (`serializeHandoffForPrompt`) and the call sites cannot drift.
 */
export const DEFAULT_KEEP_RECENT_SPRINTS = 3;

/**
 * Hard cap on `keepRecent`. The parameter is a REQUEST, not a promise: a caller
 * asking to keep 500 sprints in full would defeat the bound below, so the value
 * is clamped. Every shipped call site passes 3, well under this, so clamping is
 * a no-op today and exists only to keep the bound unconditional.
 */
export const MAX_KEEP_RECENT_SPRINTS = 5;

/**
 * Hard cap on how many SUMMARIZED (older) entries survive compaction.
 *
 * Without this, compaction was O(number of sprints ever run): one summary entry
 * per settled contract, each carrying its full description. Measured against
 * this repository's own corpus — 178 settled contracts as `listContracts`
 * returns them, which is what the call sites actually build — `sprintHistory`
 * serialized to 1,501,283 bytes raw and still 314,860 bytes after
 * `summarizeOlderSprints(handoff, 3)`. Both were handed verbatim to a live
 * model. The cap is what makes the compacted size independent of project age.
 */
export const MAX_SUMMARIZED_SPRINTS = 20;

/**
 * Per-entry cap on a summarized sprint's `description`, in characters.
 *
 * Descriptions were retained in full by the old summarizer and were its single
 * largest surviving field — roughly 560 bytes per entry across this
 * repository's corpus. A summarized sprint only needs to say what it was
 * about; the source contract remains on disk for anything more.
 */
export const MAX_SUMMARIZED_DESCRIPTION_LENGTH = 200;

/** `contractId` of the placeholder that stands in for elided sprint history. */
export const ELIDED_CONTRACT_ID = "elided-sprint-history";

/** Marker prefix on a summarized entry's description. */
const SUMMARIZED_PREFIX = "[Summarized] ";

/**
 * Prefix of the `features` entry carrying the elided COUNT in machine-readable
 * form. The count also appears in the title for the model to read, but a title
 * is display text; re-compacting a handoff must not have to parse English to
 * learn how many sprints an existing placeholder already accounts for.
 */
const ELIDED_COUNT_FEATURE = "elided-sprint-count:";

// ── Helpers ─────────────────────────────────────────────────────────

/**
 * Create a new context handoff document.
 */
export function createHandoff(params: {
  from: AgentRole;
  to: AgentRole;
  projectContext: ProjectContext;
  spec: PlanSpec;
  currentContract?: SprintContract;
  sprintHistory: SprintContract[];
  instructions: string;
  changedFiles?: string[];
  decisions?: Decision[];
  issues?: string[];
}): ContextHandoff {
  return {
    timestamp: new Date().toISOString(),
    from: params.from,
    to: params.to,
    projectContext: params.projectContext,
    spec: params.spec,
    currentContract: params.currentContract,
    sprintHistory: params.sprintHistory,
    instructions: params.instructions,
    changedFiles: params.changedFiles ?? [],
    decisions: params.decisions ?? [],
    issues: params.issues ?? [],
  };
}

/**
 * Serialize a handoff document to a JSON string.
 */
export function serializeHandoff(handoff: ContextHandoff): string {
  return JSON.stringify(handoff, null, 2);
}

/**
 * Deserialize and validate a JSON string into a ContextHandoff.
 * Throws on invalid input.
 */
export function deserializeHandoff(json: string): ContextHandoff {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    throw new Error(
      `Failed to parse handoff JSON: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = ContextHandoffSchema.safeParse(parsed);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid handoff document:\n${issues}`);
  }

  return result.data;
}

/**
 * Truncate a summarized sprint's description to {@link MAX_SUMMARIZED_DESCRIPTION_LENGTH}.
 *
 * Truncation is ANNOUNCED, not silent: the marker tells the model (and a human
 * reading a captured handoff) that text was removed and how much, so a short
 * description is never mistaken for the whole story.
 */
function truncateDescription(description: string): string {
  if (description.length <= MAX_SUMMARIZED_DESCRIPTION_LENGTH) {
    return description;
  }
  const omitted = description.length - MAX_SUMMARIZED_DESCRIPTION_LENGTH;
  return `${description.slice(0, MAX_SUMMARIZED_DESCRIPTION_LENGTH)}… [+${omitted} chars omitted]`;
}

/**
 * The single entry that stands in for sprints dropped by {@link MAX_SUMMARIZED_SPRINTS}.
 *
 * Dropping history silently would make a 400-sprint project look like a
 * 23-sprint one to the model. This entry is schema-valid (so a compacted
 * handoff still round-trips through `deserializeHandoff`) and is marked
 * `[Elided]` in both `contractId` and `title` so it cannot be misread as a real
 * sprint.
 */
function elisionEntry(count: number, specId: string): SprintContract {
  return {
    contractId: ELIDED_CONTRACT_ID,
    specId,
    sprintNumber: 1,
    title: `[Elided] ${count} earlier sprint${count === 1 ? "" : "s"} omitted from this handoff`,
    description:
      `${count} sprint${count === 1 ? "" : "s"} older than the ${MAX_SUMMARIZED_SPRINTS} summaries below ` +
      `were omitted to keep this handoff a bounded size. They are not lost: every one is on disk under ` +
      `.bober/contracts/. This is a placeholder, not a sprint — do not evaluate, implement or depend on it.`,
    status: "completed",
    dependsOn: [],
    features: [`${ELIDED_COUNT_FEATURE}${count}`],
    successCriteria: [
      {
        criterionId: "elided",
        description:
          "Placeholder for elided sprint history — no criteria to verify. See .bober/contracts/.",
        verificationMethod: "manual",
        required: false,
      },
    ],
    nonGoals: ["Treating this placeholder as a real sprint"],
    stopConditions: ["Not a sprint — nothing to stop"],
    definitionOfDone:
      "Not a sprint. This entry records only that older history was omitted from the handoff.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: [],
    iterationHistory: [],
    lastEvalId: null,
  };
}

/** Is this entry one `summarizeOlderSprints` already produced? */
function isSummaryEntry(contract: SprintContract): boolean {
  return (
    contract.description.startsWith(SUMMARIZED_PREFIX) &&
    contract.successCriteria.length === 1 &&
    contract.successCriteria[0].criterionId === "summary"
  );
}

/** Is this the placeholder standing in for already-elided history? */
function isElisionEntry(contract: SprintContract): boolean {
  return contract.contractId === ELIDED_CONTRACT_ID;
}

/** How many sprints an existing elision placeholder already accounts for. */
function elidedCountOf(contract: SprintContract): number {
  const feature = contract.features.find((f) =>
    f.startsWith(ELIDED_COUNT_FEATURE),
  );
  const parsed = Number.parseInt(
    feature?.slice(ELIDED_COUNT_FEATURE.length) ?? "",
    10,
  );
  return Number.isFinite(parsed) && parsed > 0 ? parsed : 0;
}

/**
 * Compact a handoff's sprint history to a size that does NOT grow with project age.
 *
 * Keeps the `keepRecent` most recent sprints in full detail and replaces older
 * ones with minimal summary contracts. Three things make the result bounded:
 *
 *   1. `keepRecent` is clamped to {@link MAX_KEEP_RECENT_SPRINTS}, so the
 *      full-detail tail is O(1).
 *   2. At most {@link MAX_SUMMARIZED_SPRINTS} summaries are retained — the most
 *      recent ones — with a single {@link elisionEntry} standing in for the rest.
 *   3. Each summary's description is truncated to
 *      {@link MAX_SUMMARIZED_DESCRIPTION_LENGTH}.
 *
 * ── What "bounded" means here ───────────────────────────────────────
 *
 * Bounded IN THE LENGTH OF THE HISTORY. The result is O(1) in the number of
 * sprints ever run, which is the growth that actually threatens a long-lived
 * project: this repository reached 178 settled contracts, and the old
 * implementation kept one full-description entry per contract, so its output
 * grew every sprint forever. It is NOT an absolute byte ceiling — the handoff
 * still carries the spec, the current contract and up to
 * {@link MAX_KEEP_RECENT_SPRINTS} full contracts, any one of which a caller can
 * make arbitrarily large. Those are O(1) in history length and are the part of
 * the handoff the agent is actually there to act on.
 *
 * Idempotent: compacting an already-compacted handoff returns an equivalent
 * one, so a call site that compacts explicitly and then hands the result to
 * `serializeHandoffForPrompt` pays nothing and loses nothing.
 *
 * Returns a new handoff; the input is not mutated.
 */
export function summarizeOlderSprints(
  handoff: ContextHandoff,
  keepRecent: number,
): ContextHandoff {
  const history = handoff.sprintHistory;
  const keep = Math.min(Math.max(keepRecent, 0), MAX_KEEP_RECENT_SPRINTS);

  if (history.length <= keep) {
    return handoff;
  }

  const cutoff = history.length - keep;
  const recentSprints = history.slice(cutoff);

  // Pull out any placeholder this handoff already carries and remember what it
  // stood for, so a second pass reports the TRUE elided total instead of
  // counting the placeholder itself as one dropped sprint.
  const olderRaw = history.slice(0, cutoff);
  const olderSprints = olderRaw.filter((c) => !isElisionEntry(c));
  const carriedElided = olderRaw
    .filter(isElisionEntry)
    .reduce((sum, c) => sum + elidedCountOf(c), 0);

  // Drop the OLDEST beyond the cap and keep the most recent summaries: sprints
  // adjacent to the current one are the ones whose decisions still constrain it.
  const dropped = Math.max(olderSprints.length - MAX_SUMMARIZED_SPRINTS, 0);
  const retainedOlder = olderSprints.slice(dropped);

  // Build summary entries as minimal SprintContract objects.
  // Even summaries must satisfy the schema's precision-field minimums so
  // that downstream code can rely on the shape unconditionally.
  const summarized: SprintContract[] = retainedOlder.map((contract) => {
    // Already a summary: re-wrapping would double the `[Summarized]` prefix and
    // truncate an already-truncated description, silently discarding text and
    // leaving a "+N chars omitted" count that understates what was cut. This
    // path is not hypothetical — three call sites compact explicitly and then
    // hand the result to `serializeHandoffForPrompt`, which compacts again.
    if (isSummaryEntry(contract)) {
      return contract;
    }

    const summary = summarizeSprint(contract);
    const summarizedDescription = `${SUMMARIZED_PREFIX}${truncateDescription(contract.description)}`;
    return {
      contractId: summary.contractId,
      specId: summary.specId,
      sprintNumber: summary.sprintNumber,
      title: summary.title,
      description: summarizedDescription,
      status: summary.status,
      dependsOn: contract.dependsOn,
      features: contract.features,
      successCriteria: [
        {
          criterionId: "summary",
          description:
            "Sprint history summarized — original criteria omitted to save context.",
          verificationMethod: "manual",
          required: false,
        },
      ],
      nonGoals: ["Re-evaluating this summarized sprint"],
      stopConditions: ["Sprint already terminal at summary time"],
      definitionOfDone:
        "Summarized historical sprint — see source contract for original criteria.",
      assumptions: [],
      outOfScope: [],
      estimatedFiles: [],
      iterationHistory: [],
      lastEvalId: contract.lastEvalId ?? null,
      startedAt: summary.startedAt,
      completedAt: summary.completedAt,
    };
  });

  const totalElided = carriedElided + dropped;
  const head =
    totalElided > 0 ? [elisionEntry(totalElided, handoff.spec.specId)] : [];

  return {
    ...handoff,
    sprintHistory: [...head, ...summarized, ...recentSprints],
  };
}

/**
 * Serialize a handoff for a MODEL PROMPT — compacted first, unconditionally.
 *
 * This is the one function `runGenerator` and `runEvaluatorAgent` use to turn a
 * handoff into prompt text, and it is where the size bound is enforced, because
 * enforcing it at the call sites did not work: of the nine handoffs built in
 * this codebase, four evaluator handoffs (`mcp/tools/sprint.ts`,
 * `mcp/tools/eval.ts`, `cli/commands/sprint.ts`, `cli/commands/eval.ts`) and the
 * PGE generator handoff (`pge/nodes/sprint-generate.ts`, which builds a
 * `ContextHandoff` literal rather than calling `createHandoff`) applied no
 * compaction at all and shipped the entire settled corpus to a live model.
 *
 * A rule every caller must remember is a rule a tenth caller will forget, so the
 * bound lives on the path all of them already take. Call sites may still compact
 * explicitly — `summarizeOlderSprints` is idempotent.
 */
export function serializeHandoffForPrompt(handoff: ContextHandoff): string {
  return serializeHandoff(summarizeOlderSprints(handoff, DEFAULT_KEEP_RECENT_SPRINTS));
}
