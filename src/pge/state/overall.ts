import { z } from "zod";

import { PlanSpecSchema } from "../../contracts/spec.js";
import type { PlanSpec } from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import { PhaseSchema } from "../../state/history.js";

/**
 * The PUBLIC half of the three-scope state split (ADR-4).
 *
 * Three scopes, one direction of travel:
 *
 *  1. PUBLIC — {@link OverallStateSchema}. A small, snapshot-pinned key whitelist. Every
 *     key is a channel; every channel is merged by exactly one registered reducer once
 *     per superstep. This is the only state that reaches the commit boundary.
 *  2. PORTS — per-node `inputPorts[]`/`outputPorts[]`, declared in the topology artifact
 *     with a `schemaRef` resolved through a `SchemaCatalog`. Port payloads flow along one
 *     edge; they are not state.
 *  3. PRIVATE — `NodeContext.priv`, a fresh `Map` per task (see `../registry/nodes.ts`).
 *     It is never a channel, is never handed to the commit boundary, and is dropped when
 *     the handler returns, so node-local scratch is structurally incapable of reaching
 *     the committed artifact.
 *
 * ── The key count is 15, and the architecture's prose is the error ──
 *
 * `arch-20260805-pge-graph-engineering-architecture.md:305` comments "Exactly 14 keys"
 * above a schema that enumerates FIFTEEN: runId, projectRoot, featureRequest, specId,
 * currentPhase, spec, sprintContracts, evaluations, messages, refs, counters,
 * branchStatus, testAnchors, verdict, ledger. The enumeration is authoritative and the
 * comment is a miscount — no key is dropped to reach 14, because every enumerated key
 * has a writer in the shipped `coding` topology. {@link OVERALL_STATE_KEY_BUDGET} pins
 * the real number, and `overall.test.ts` pins the sorted key set so neither can move
 * without the whitelist and the budget being amended in the same change.
 *
 * ── Binding, not redefining ──
 *
 * `spec` and `sprintContracts` REUSE `PlanSpecSchema` (`src/contracts/spec.ts`) and
 * `SprintContractSchema` (`src/contracts/sprint-contract.ts`) directly. The
 * {@link Exact} guards below fail `npm run typecheck` — not a test, and not at runtime —
 * if a parallel contract type ever drifts in beside the real one.
 *
 * ── What must never be here ──
 *
 * No raw tool stdout, no workspace diff, no bulk payload. Anything above a channel's
 * `maxInlineBytes` is offloaded to the scratch store and referenced through
 * {@link OverallStateSchema}'s `refs` as a {@link ScratchRef}.
 */

// ── Scratch references ──────────────────────────────────────────────

/** Payload classes the scratch store content-addresses. */
export const SCRATCH_KINDS = ["stdout", "stderr", "diff", "document", "payload"] as const;
export const ScratchKindSchema = z.enum(SCRATCH_KINDS);
export type ScratchKind = z.infer<typeof ScratchKindSchema>;

export const SCRATCH_URI_PATTERN = /^scratch:\/\/[A-Za-z0-9._\-/]+$/;
export const SHA256_HEX_PATTERN = /^[0-9a-f]{64}$/;

/**
 * A handle to an offloaded payload. The bytes live under `.bober/scratch/`; only this
 * 4-field descriptor is ever allowed into state.
 */
export const ScratchRefSchema = z.object({
  uri: z.string().regex(SCRATCH_URI_PATTERN),
  sha256: z.string().regex(SHA256_HEX_PATTERN),
  bytes: z.number().int().min(0),
  kind: ScratchKindSchema,
});
export type ScratchRef = z.infer<typeof ScratchRefSchema>;

// ── Messages ────────────────────────────────────────────────────────

export const MESSAGE_ROLES = ["system", "user", "assistant", "tool"] as const;
export const MessageRoleSchema = z.enum(MESSAGE_ROLES);
export type MessageRole = z.infer<typeof MessageRoleSchema>;

/**
 * One conversational turn.
 *
 * `id` is the INTRINSIC identity the `appendById` reducer unions on, and `seq` is the
 * primary sort key of the canonical form. A message carries either an inline `text` or
 * a `textRef` to offloaded bytes — never a megabyte of inline transcript.
 */
export const GraphMessageSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().min(0),
  role: MessageRoleSchema,
  nodeId: z.string().min(1),
  text: z.string().optional(),
  textRef: ScratchRefSchema.optional(),
  tokens: z.number().int().min(0),
});
export type GraphMessage = z.infer<typeof GraphMessageSchema>;

// ── Sprint verdicts ─────────────────────────────────────────────────

export const SPRINT_VERDICTS = ["pass", "fail", "skipped"] as const;
export const SprintVerdictOutcomeSchema = z.enum(SPRINT_VERDICTS);
export type SprintVerdictOutcome = z.infer<typeof SprintVerdictOutcomeSchema>;

/**
 * The evaluator's verdict on one attempt at one sprint contract.
 *
 * Carries `id` and `seq` for the same reason {@link GraphMessageSchema} does: the
 * `evaluations` channel is merged by `appendById`, so an intrinsic identity is what
 * makes a re-delivered verdict a no-op rather than a duplicate row.
 */
export const SprintVerdictSchema = z.object({
  id: z.string().min(1),
  seq: z.number().int().min(0),
  contractId: z.string().min(1),
  sprintNumber: z.number().int().min(1),
  iteration: z.number().int().min(1),
  verdict: SprintVerdictOutcomeSchema,
  summary: z.string(),
  evalId: z.string().nullable().default(null),
});
export type SprintVerdict = z.infer<typeof SprintVerdictSchema>;

// ── Branch status ───────────────────────────────────────────────────

export const BRANCH_STATES = ["pending", "running", "succeeded", "failed", "abandoned"] as const;
export const BranchStateSchema = z.enum(BRANCH_STATES);
export type BranchState = z.infer<typeof BranchStateSchema>;

/**
 * Per-branch progress. The `branchStatus` channel is a record keyed by branch key, and
 * `lastWriteWinsByKey` is sound there precisely because concurrent branches write
 * DISJOINT key domains — a branch only ever writes its own key.
 *
 * ── `attempts` is the ordering discriminator, not decoration ──
 *
 * Disjointness makes CONCURRENT writers commutative; it says nothing about the same key
 * written twice at different supersteps, which is what a branch's own lifecycle is
 * (`running` -> `succeeded`, or `running` -> `failed`). `lastWriteWinsByKey` resolves that
 * pair by canonical order rather than by recency — there is no "last" in a join — so a
 * transition is only expressible when the LATER value is the canonical-order maximum.
 * Canonical form sorts keys, so `attempts` is compared first, and it is therefore the
 * field that has to carry the order: a writer records the attempts a branch has
 * COMPLETED, which is `0` while it is merely running and at least `1` once it has settled
 * either way. A `running` record claiming an attempt it has not finished would outrank the
 * outcome that follows it and the branch would appear to be running forever.
 */
export const BranchStatusSchema = z.object({
  state: BranchStateSchema,
  attempts: z.number().int().min(0),
  errorClass: z.string().optional(),
});
export type BranchStatus = z.infer<typeof BranchStatusSchema>;

// ── Budget ledger ───────────────────────────────────────────────────

/**
 * One charged model call, keyed by `(nodeId, attempt, callIndex)`.
 *
 * `mergeLedger` REPLACES by that key rather than adding, which is what makes per-node
 * sums equal run totals across a crash-resume or a retried superstep: re-charging the
 * same call cannot double-count.
 */
export const LedgerEntrySchema = z.object({
  nodeId: z.string().min(1),
  attempt: z.number().int().min(0),
  callIndex: z.number().int().min(0),
  calls: z.number().int().min(0),
  tokensIn: z.number().int().min(0),
  tokensOut: z.number().int().min(0),
  costUsd: z.number().min(0),
});
export type LedgerEntry = z.infer<typeof LedgerEntrySchema>;

/**
 * The ledger CHANNEL VALUE — a flat list of keyed charges.
 *
 * Deliberately named apart from the `BudgetLedger` INTERFACE in
 * `../registry/nodes.ts`: that one is the collaborator a node calls (`charge`,
 * `totals`), this one is the serialisable value the collaborator accumulates into
 * state.
 */
export const BudgetLedgerSchema = z.array(LedgerEntrySchema);
export type BudgetLedgerState = z.infer<typeof BudgetLedgerSchema>;

// ── Run verdict ─────────────────────────────────────────────────────

export const RUN_VERDICTS = ["pending", "success", "partial", "failed"] as const;
export const RunVerdictSchema = z.enum(RUN_VERDICTS);
export type RunVerdict = z.infer<typeof RunVerdictSchema>;

// ── OverallState ────────────────────────────────────────────────────

/**
 * The public channel set. Fifteen keys, pinned by {@link OVERALL_STATE_KEYS} and by the
 * snapshot test beside this file.
 */
export const OverallStateSchema = z.object({
  runId: z.string().min(1),
  projectRoot: z.string().min(1),
  featureRequest: z.string(),
  specId: z.string().nullable(),
  currentPhase: PhaseSchema,
  spec: PlanSpecSchema.nullable(),
  sprintContracts: z.array(SprintContractSchema),
  evaluations: z.array(SprintVerdictSchema),
  messages: z.array(GraphMessageSchema),
  refs: z.record(z.string(), ScratchRefSchema),
  counters: z.record(z.string(), z.number().int()),
  branchStatus: z.record(z.string(), BranchStatusSchema),
  testAnchors: z.array(z.string()),
  verdict: RunVerdictSchema,
  ledger: BudgetLedgerSchema,
});
export type OverallState = z.infer<typeof OverallStateSchema>;

/**
 * The whitelist, sorted. Amending this list without amending
 * {@link OVERALL_STATE_KEY_BUDGET} fails the snapshot test, and amending either without
 * touching {@link OverallStateSchema} fails {@link _keysAreExact} at `tsc` time.
 */
export const OVERALL_STATE_KEYS = [
  "branchStatus",
  "counters",
  "currentPhase",
  "evaluations",
  "featureRequest",
  "ledger",
  "messages",
  "projectRoot",
  "refs",
  "runId",
  "spec",
  "specId",
  "sprintContracts",
  "testAnchors",
  "verdict",
] as const;
export type OverallStateKey = (typeof OVERALL_STATE_KEYS)[number];

/**
 * The pinned key-count budget.
 *
 * State growth is the failure mode ADR-4 is guarding against, so the number is written
 * down rather than derived: a sprint that adds a sixteenth channel must justify the new
 * number in the same diff.
 */
export const OVERALL_STATE_KEY_BUDGET = 15;

/** The schema's own key set, sorted. The snapshot test compares this to the whitelist. */
export function overallStateKeys(): string[] {
  return Object.keys(OverallStateSchema.shape).sort();
}

// ── Compile-time drift guards ───────────────────────────────────────

/**
 * Mutual assignability. Resolves to `true` only when `A` and `B` are the SAME type;
 * anything else resolves to `never`, so the `= true` initialiser below stops being
 * assignable and `npm run typecheck` fails. Wrapped in tuples so a union distributes as
 * one type rather than member-by-member.
 */
export type Exact<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;

/**
 * sc-5-2 — `sprintContracts` holds the REAL `SprintContract`, not a parallel copy.
 *
 * Redefining the contract inside the graph layer is the specific mistake this catches:
 * a hand-written `{ sprint_id, goals, files_to_edit }` shape (the source documents'
 * errata) would compile fine as an array of objects and only diverge in production.
 * Here it fails the build.
 */
export const _contractsAreExact: Exact<
  OverallState["sprintContracts"][number],
  z.infer<typeof SprintContractSchema>
> = true;

/** sc-5-2 — `spec` is the real `PlanSpec` or `null`, and nothing else. */
export const _specIsExact: Exact<OverallState["spec"], PlanSpec | null> = true;

/** The whitelist and the schema cannot drift apart without failing `tsc`. */
export const _keysAreExact: Exact<OverallStateKey, keyof OverallState> = true;

// ── Construction ────────────────────────────────────────────────────

export interface InitialStateInput {
  runId: string;
  projectRoot: string;
  featureRequest: string;
}

/**
 * The bottom element of every channel, in one place.
 *
 * Each empty value is the identity of that channel's reducer, so an initial state
 * merged with nothing is itself — the property the interpreter's first superstep
 * depends on.
 */
export function initialOverallState(input: InitialStateInput): OverallState {
  return OverallStateSchema.parse({
    runId: input.runId,
    projectRoot: input.projectRoot,
    featureRequest: input.featureRequest,
    specId: null,
    currentPhase: "init",
    spec: null,
    sprintContracts: [],
    evaluations: [],
    messages: [],
    refs: {},
    counters: {},
    branchStatus: {},
    testAnchors: [],
    verdict: "pending",
    ledger: [],
  });
}
