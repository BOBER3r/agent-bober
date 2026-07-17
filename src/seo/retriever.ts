/**
 * SeoPlaybookRetriever — ranks + never-empty renders SeoSignature[] for a
 * given workflow (spec-20260715-ultimate-seo-suite, Sprint 2; folds the
 * security template's selector.ts (rank + generic-floor dedup) and
 * resolver.ts (never-empty promptFragment) into one file, since the
 * contract lists only this as a single code file).
 *
 * Method name is `retrieve` (sc-2-4) — NOT `resolve` (the architecture API
 * table's name); the binding success criterion and evaluator assert
 * `retrieve({workflow,target,vertical})`.
 */
import type { SeoSignature, SeoWorkflow } from "./types.js";
import type { SeoPlaybookIndex } from "./playbook-index.js";

export interface SeoRetrieveInput {
  workflow: SeoWorkflow;
  target?: string;
  vertical?: string;
  topK?: number;
}

export interface SeoRetrieveResult {
  promptFragment: string;
  signatures: SeoSignature[];
}

/**
 * There is NO "seo" lens in `eval-lenses.ts` LENS_CATALOG — `resolveLensFocus("seo")`
 * would only return a bland generic fallback string. This is a dedicated,
 * purpose-written floor so an empty index still yields useful guidance, and
 * `promptFragment` is guaranteed non-empty (sc-2-4).
 */
const SEO_GENERIC_FLOOR =
  "Apply the generic SEO/GEO playbook: prioritise cited, first-party, evidence-backed signals " +
  "(branded mentions, YouTube presence, comprehensive fan-out coverage) over volume tactics (bulk " +
  "backlinks, mass-produced pages); never recommend a never-encode tactic (parasite SEO, expired-domain " +
  "plays, paid links, AI-recommendation poisoning).";

interface ScoreInput {
  workflow: SeoWorkflow;
  target?: string;
  vertical?: string;
}

/** score = workflow membership + target/vertical keyword overlap. */
function scoreSignature(signature: SeoSignature, input: ScoreInput): number {
  let score = 0;

  if (signature.workflows.includes(input.workflow)) score += 3;

  const needles = [input.target, input.vertical]
    .filter((v): v is string => typeof v === "string" && v.length > 0)
    .map((v) => v.toLowerCase());

  for (const needle of needles) {
    for (const keyword of signature.keywords) {
      const keywordLower = keyword.toLowerCase();
      if (needle.includes(keywordLower) || keywordLower.includes(needle)) score += 1;
    }
  }

  return score;
}

interface SelectInput extends ScoreInput {
  topK: number;
  /** Typically `index.all().filter(s => s.workflows.includes(workflow))`. */
  workflowSigs: SeoSignature[];
  /** Typically `index.generic()` — ALWAYS included in the result. */
  floor: SeoSignature[];
}

/**
 * Pure and total: ranks `workflowSigs` by score, caps at `topK`, then ALWAYS
 * concatenates `floor` (the generic-skill signatures), deduped by
 * `playbookId` — the floor is present even when it did not rank into the
 * top-K on its own merit (sc-2-4).
 */
function selectSeoSignatures(input: SelectInput): SeoSignature[] {
  const workflowSigs = Array.isArray(input.workflowSigs) ? input.workflowSigs : [];
  const floor = Array.isArray(input.floor) ? input.floor : [];
  const topK = Number.isFinite(input.topK) ? Math.max(0, Math.trunc(input.topK)) : 0;

  const ranked = workflowSigs
    .map((signature) => ({ signature, score: scoreSignature(signature, input) }))
    .sort((a, b) => b.score - a.score)
    .slice(0, topK)
    .map((r) => r.signature);

  const selected = [...ranked];
  const seen = new Set(selected.map((s) => s.playbookId));
  for (const floorSig of floor) {
    if (!seen.has(floorSig.playbookId)) {
      seen.add(floorSig.playbookId);
      selected.push(floorSig);
    }
  }

  return selected;
}

function renderSignature(signature: SeoSignature): string {
  return [
    `### ${signature.playbookId} — ${signature.title}`,
    `Invariant: ${signature.invariant}`,
    `Tactic: ${signature.tactic}`,
    `Source: ${signature.primarySourceUrl}`,
    `LiveWeight: ${signature.liveWeightStatus}`,
  ].join("\n");
}

/**
 * Renders the selected signatures into a compact prompt fragment. NEVER
 * empty: falls back to `SEO_GENERIC_FLOOR` when the selected set is empty
 * (e.g. a wholly missing/empty skills directory — closes the analogue of G3).
 */
function renderPromptFragment(signatures: SeoSignature[]): string {
  return signatures.length > 0 ? signatures.map(renderSignature).join("\n\n") : SEO_GENERIC_FLOOR;
}

export class SeoPlaybookRetriever {
  constructor(private readonly index: SeoPlaybookIndex) {}

  /**
   * Never throws: loads (idempotent) the index, ranks the workflow's
   * matching signatures, and always includes the generic floor deduped by
   * `playbookId`. `promptFragment` is never empty.
   */
  async retrieve(input: SeoRetrieveInput): Promise<SeoRetrieveResult> {
    await this.index.load();

    const floor = this.index.generic();
    const workflowSigs = this.index.all().filter((s) => s.workflows.includes(input.workflow));

    const signatures = selectSeoSignatures({
      workflow: input.workflow,
      target: input.target,
      vertical: input.vertical,
      topK: input.topK ?? 8,
      workflowSigs,
      floor,
    });

    return { promptFragment: renderPromptFragment(signatures), signatures };
  }
}
