import { Buffer } from "node:buffer";
import { createHash } from "node:crypto";

import { z } from "zod";

import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract } from "../../contracts/sprint-contract.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { GraphMessage, LedgerEntry, OverallState } from "../state/overall.js";
import type { NodeContext, NodeImpl } from "../registry/nodes.js";
import { EFFECTS } from "./effects.js";
import type { ExplainResponse, MocksResponse, SprintBriefingSchema } from "./effects.js";
import {
  MOCK_MANIFEST_REF_KEY,
  SPRINT_GATE_IDS,
  gatePolicyOf,
  nodeSpecOf,
  portOf,
  preconditionIssue,
  refuse,
  soleSuccessor,
} from "./gates.js";
import type { MockManifest } from "./gates.js";
import { syntheticSpec } from "./sprint-generate.js";
import { EXECUTABLE_METHODS } from "./verification.js";

/**
 * The two curator nodes: explain the tests, then curate the mocks that exercise them.
 *
 * ── Why `sprint_curate_explain` makes TWO calls ──
 *
 * `runCurator` returns a `SprintBriefing` (`curator-agent.ts:27-41`) — a markdown blob with
 * `filesAnalyzed`, `patternsFound` and `utilsIdentified` and nothing per-test. sc-12-1 asks
 * for one `expectedBehavior` string PER PROVIDED OR EXISTING TEST, and nonGoal 2 forbids
 * changing `runCurator` to produce one. So the node calls the shipped curator for the
 * briefing and then makes a second, schema-constrained call for the explanations, with the
 * briefing as its context. Both go through `ctx.effects.invoke`; neither agent is touched.
 *
 * ── What counts as a "provided or existing test" ──
 *
 * {@link sprintTestIds} answers it from the contract itself, in two ways that are both real:
 * a test FILE the contract lists in `estimatedFiles`, and a CRITERION whose
 * `verificationMethod` names something executable — the closed vocabulary at
 * `contracts/sprint-contract.ts:55-64` that assumption 1 of the sprint contract points at.
 * Deriving it means a contract that adds a criterion adds an explanation the gate then
 * demands, without an edit here.
 *
 * ── Where an under-delivering curator goes ──
 *
 * The artifact gives the curate step no gate of its own; the branch's short-circuit is
 * `gate_sprint_in`'s declared `gate.onFail`, which is `sprint_exit` (`coding.graph.ts:489`).
 * A curator that explains fewer tests than were asked about, or that answers with a stub,
 * therefore routes THERE — read off the artifact, not spelled — and `sprint_curate_mocks` is
 * never entered. Proceeding with partial explanations would hand the mock curator a brief
 * that silently omits the behaviour it is supposed to cover.
 */

// ── Node ids ────────────────────────────────────────────────────────

export const SPRINT_CURATE_NODE_IDS = {
  explain: "sprint_curate_explain",
  mocks: "sprint_curate_mocks",
} as const;

/** The `refs` key the curator's explanations are offloaded under. */
export const EXPLANATIONS_REF_KEY = "sprint-test-explanations";

/**
 * The minimum length of an explanation, in characters.
 *
 * A module constant and not a config key on purpose: there is no config key for it, and
 * inventing one would put a contract-level quality floor somewhere a project could quietly
 * lower to zero. Forty characters is about one clause — enough to rule out "checks the
 * thing" and cheap enough that a real explanation always clears it.
 */
export const MIN_EXPECTED_BEHAVIOR_LENGTH = 40;

/** Files whose name marks them as tests. */
export const TEST_FILE_PATTERN = /\.(test|spec)\.[cm]?[jt]sx?$/;

// ── The test set ────────────────────────────────────────────────────

/**
 * Every provided or existing test this contract is about, sorted and de-duplicated.
 *
 * Both sources are the contract's own fields, so the set is a function of the artifact of
 * record rather than of anything the curator says about itself.
 */
export function sprintTestIds(contract: SprintContract): string[] {
  const ids = new Set<string>();
  for (const path of contract.estimatedFiles ?? []) {
    if (TEST_FILE_PATTERN.test(path)) ids.add(path);
  }
  const executable = new Set<string>(EXECUTABLE_METHODS);
  for (const criterion of contract.successCriteria) {
    if (executable.has(criterion.verificationMethod)) ids.add(criterion.criterionId);
  }
  return [...ids].sort();
}

/**
 * Why a set of explanations does not satisfy sc-12-1, or `[]`.
 *
 * Three separate claims, each reported separately: one explanation per test, no explanation
 * for a test nobody asked about, and every explanation over the length floor. A caller that
 * only counted would accept a set that explained the same test twice.
 */
export function explanationIssues(
  testIds: readonly string[],
  explanations: ExplainResponse["explanations"],
): ReturnType<typeof preconditionIssue>[] {
  const issues: ReturnType<typeof preconditionIssue>[] = [];
  const expected = new Set(testIds);
  const explained = new Set(explanations.map((entry) => entry.testId));

  if (explanations.length !== testIds.length) {
    issues.push(
      preconditionIssue(
        "explanations",
        `the curator explained ${String(explanations.length)} test(s) and was asked about ${String(testIds.length)}`,
      ),
    );
  }
  const missing = [...expected].filter((id) => !explained.has(id)).sort();
  if (missing.length > 0) {
    issues.push(preconditionIssue("explanations.testId", `no expectedBehavior for ${missing.join(", ")}`));
  }
  const unknown = [...explained].filter((id) => !expected.has(id)).sort();
  if (unknown.length > 0) {
    issues.push(
      preconditionIssue("explanations.testId", `explained ${unknown.join(", ")}, which is not a test of this contract`),
    );
  }
  const tooShort = explanations
    .filter((entry) => entry.expectedBehavior.trim().length < MIN_EXPECTED_BEHAVIOR_LENGTH)
    .map((entry) => entry.testId)
    .sort();
  if (tooShort.length > 0) {
    issues.push(
      preconditionIssue(
        "explanations.expectedBehavior",
        `${tooShort.join(", ")} explained in under ${String(MIN_EXPECTED_BEHAVIOR_LENGTH)} characters`,
      ),
    );
  }
  return issues;
}

// ── Helpers ─────────────────────────────────────────────────────────

function note(ctx: NodeContext, text: string): GraphMessage {
  return {
    id: `${ctx.nodeId}:${ctx.branchKey ?? "root"}:${String(ctx.superstep)}`,
    seq: ctx.superstep,
    role: "assistant",
    nodeId: ctx.nodeId,
    text,
    tokens: text.length,
  };
}

function charge(ctx: NodeContext, callIndex = 0): LedgerEntry {
  const entry: LedgerEntry = {
    nodeId: ctx.nodeId,
    attempt: 0,
    callIndex,
    calls: 1,
    tokensIn: 0,
    tokensOut: 0,
    costUsd: 0,
  };
  ctx.ledger.charge(
    { nodeId: entry.nodeId, attempt: entry.attempt, callIndex: entry.callIndex },
    { calls: entry.calls, tokensIn: entry.tokensIn, tokensOut: entry.tokensOut, costUsd: entry.costUsd },
  );
  return entry;
}

/** The declared `promptRef` of `nodeId`, read off the artifact. */
export function promptRefOf(spec: TopologySpec, nodeId: string): string {
  const node = nodeSpecOf(spec, nodeId);
  return "promptRef" in node && typeof node.promptRef === "string" ? node.promptRef : nodeId;
}

/** The model the node's declared tier binds to. */
function modelOf(spec: TopologySpec, nodeId: string, ctx: NodeContext): string {
  const node = nodeSpecOf(spec, nodeId);
  const tier = "modelTier" in node && node.modelTier !== undefined ? node.modelTier : "frontier";
  return ctx.models.bind(tier).modelId;
}

/** A stable digest of the files a curation depends on, for the cache key. */
function contextFilesHash(contract: SprintContract): string {
  const files = [...(contract.estimatedFiles ?? [])].sort().join("\n");
  return createHash("sha256").update(files).digest("hex");
}

// ── sprint_curate_explain ───────────────────────────────────────────

/**
 * Curate the context and explain every test in natural language (sc-12-1).
 *
 * ── The cache is CONSULTED, not decorated with ──
 *
 * The artifact declares `cache: { ttlSeconds: 1800, scope: "run" }` on this node, which is
 * legal precisely because it declares `effects: []` (`CacheOnEffectfulNode` forbids the
 * combination). So the body actually reads and writes `ctx.cache`, keyed on all six
 * components `CacheKeyParts` names (`registry/nodes.ts:61-68`) — including a hash of the
 * files the contract points at, so a contract whose file list changed is a cache miss.
 */
export function sprintCurateExplainNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_CURATE_NODE_IDS.explain;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const promptRef = promptRefOf(spec, nodeId);
  const shortCircuit = gatePolicyOf(spec, SPRINT_GATE_IDS.entry).onFail;
  const ttlSeconds = "cache" in node && node.cache !== undefined ? node.cache.ttlSeconds : 1800;

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const contract = SprintContractSchema.parse(input);
      const testIds = sprintTestIds(contract);
      const model = modelOf(spec, nodeId, ctx);
      const system = await ctx.prompts.get(promptRef);

      const parts = {
        systemPrompt: system,
        userPrompt: `${contract.contractId}:${testIds.join(",")}`,
        contextFilesHash: contextFilesHash(contract),
        model,
        temperature: 0,
        toolsMask: "curator:explain",
      };
      const cacheKey = ctx.cache.key(parts);
      const hit = await ctx.cache.get(cacheKey, ctx.clock.nowMs());

      let explanations: ExplainResponse["explanations"];
      const ledger: LedgerEntry[] = [];
      if (hit !== undefined) {
        explanations = (hit.value as ExplainResponse).explanations;
      } else {
        const briefing = (await ctx.effects.invoke(
          EFFECTS.curatorBrief,
          {
            contract,
            spec: state.spec ?? syntheticSpec(contract, ctx.clock.nowIso()),
            completedSprints: state.sprintContracts.filter(
              (entry) => entry.status === "completed" && entry.contractId !== contract.contractId,
            ),
            projectRoot: ctx.projectRoot,
          },
          ctx,
        )) as z.infer<typeof SprintBriefingSchema>;
        ledger.push(charge(ctx, 0));

        const response = (await ctx.effects.invoke(
          EFFECTS.curatorExplain,
          { contractId: contract.contractId, testIds, briefing: briefing.briefing, promptRef, model },
          ctx,
        )) as ExplainResponse;
        ledger.push(charge(ctx, 1));
        explanations = response.explanations;
        await ctx.cache.put(cacheKey, { explanations }, ttlSeconds, ctx.clock.nowMs(), parts);
      }

      const issues = explanationIssues(testIds, explanations);
      if (issues.length > 0) {
        return {
          update: { ledger },
          // The branch's declared short-circuit, read off `gate_sprint_in.gate.onFail`.
          goto: { kind: "node", node: shortCircuit },
          output: refuse(ctx, { check: "expected-behavior-per-test", onFail: shortCircuit, issues }),
        };
      }

      const ref = await ctx.scratch.put(
        ctx.runId,
        "document",
        JSON.stringify({ contractId: contract.contractId, explanations }),
      );
      return {
        update: {
          messages: [
            note(ctx, `explained ${String(explanations.length)} test(s) for ${contract.contractId}`),
          ],
          refs: { [explanationsRefKey(contract.contractId)]: ref },
          ledger,
        },
        phase: "generating",
        goto: { kind: "node", node: next },
        output: contract,
      };
    },
  };
}

/** The per-branch `refs` key the explanations live under. */
export function explanationsRefKey(contractId: string): string {
  return `${EXPLANATIONS_REF_KEY}:${contractId}`;
}

// ── sprint_curate_mocks ─────────────────────────────────────────────

/**
 * Curate the mock tests the sprint's implementation will be measured against (sc-12-2).
 *
 * Writes the fixtures through `ctx.effects.invoke` — the node declares `effects:
 * ["fs-write"]`, which is what authorises the call — and offloads the MANIFEST to the
 * scratch store, putting only a `ScratchRef` in `refs`. `gate_mock_coverage` then reads that
 * ref, which is the one channel the artifact declares between them.
 *
 * On a re-curation round the gate's refusal is on the input, and its diagnostics are folded
 * into the request so the second round is answering the first round's rejection rather than
 * re-rolling blind.
 */
export function sprintCurateMocksNode(spec: TopologySpec): NodeImpl<unknown, unknown> {
  const nodeId = SPRINT_CURATE_NODE_IDS.mocks;
  const node = nodeSpecOf(spec, nodeId);
  const next = soleSuccessor(spec, nodeId);
  const promptRef = promptRefOf(spec, nodeId);
  const bound = nodeSpecOf(spec, SPRINT_GATE_IDS.mockCoverage).loop;

  return {
    id: nodeId,
    kind: "llm",
    inputPort: portOf(node, "input"),
    outputPort: portOf(node, "output"),
    inputSchema: z.unknown(),
    outputSchema: z.unknown(),
    handler: async (input, state, ctx) => {
      const contract = resolveCuratedContract(input, state, ctx);
      const rejection = rejectionTextOf(input);
      const round = roundOf(state, bound?.counterKey ?? "mockCurationRounds", ctx);
      const explanations = await readExplanations(state, ctx, contract.contractId);

      const response = (await ctx.effects.invoke(
        EFFECTS.curatorMocks,
        {
          contract,
          projectRoot: ctx.projectRoot,
          explanations,
          round,
          rejection,
          promptRef,
          model: modelOf(spec, nodeId, ctx),
        },
        ctx,
      )) as MocksResponse;

      const manifest: MockManifest = { contractId: response.contractId, tests: response.tests };
      const ref = await ctx.scratch.put(ctx.runId, "document", JSON.stringify(manifest));

      return {
        update: {
          messages: [
            note(
              ctx,
              `curated ${String(manifest.tests.length)} mock test(s) for ${contract.contractId} (round ${String(round)})`,
            ),
          ],
          refs: { [MOCK_MANIFEST_REF_KEY]: ref },
          ledger: [charge(ctx)],
        },
        goto: { kind: "node", node: next },
        output: manifest,
      };
    },
  };
}

/** The contract a curate node is working on, from the payload or from the channel. */
function resolveCuratedContract(
  input: unknown,
  state: Readonly<OverallState>,
  ctx: NodeContext,
): SprintContract {
  const carried = SprintContractSchema.safeParse(input);
  if (carried.success) return carried.data;
  const byBranch = state.sprintContracts.find((entry) => entry.contractId === ctx.branchKey);
  const contract = byBranch ?? state.sprintContracts[0];
  if (contract === undefined) {
    throw new Error(
      `Node "${ctx.nodeId}" was entered with no contract on its input port and none in the sprintContracts channel.`,
    );
  }
  return contract;
}

/** The gate's diagnostics, when this is a re-curation round. */
function rejectionTextOf(input: unknown): string | null {
  if (typeof input !== "object" || input === null) return null;
  const issues = (input as { issues?: unknown }).issues;
  if (!Array.isArray(issues)) return null;
  const text = issues
    .map((issue) => (issue as { message?: unknown }).message)
    .filter((message): message is string => typeof message === "string")
    .join("; ");
  return text.length === 0 ? null : text;
}

/** Which curation round this is, from the counter the interpreter maintains. */
function roundOf(state: Readonly<OverallState>, counterKey: string, ctx: NodeContext): number {
  const branch = ctx.branchKey === null ? "" : `::${ctx.branchKey}`;
  return (state.counters[`${counterKey}${branch}`] ?? 0) + 1;
}

/** The explanations the explain node offloaded, or `[]` when there are none to read. */
async function readExplanations(
  state: Readonly<OverallState>,
  ctx: NodeContext,
  contractId: string,
): Promise<ExplainResponse["explanations"]> {
  const ref = state.refs[explanationsRefKey(contractId)];
  if (ref === undefined) return [];
  try {
    const parsed = z
      .object({ explanations: z.array(z.object({ testId: z.string(), expectedBehavior: z.string() })) })
      .safeParse(JSON.parse(await ctx.scratch.text(ref)));
    return parsed.success ? parsed.data.explanations : [];
  } catch {
    return [];
  }
}

/** Bytes an explanation set occupies, for the byte-budget assertions. */
export function explanationBytes(explanations: ExplainResponse["explanations"]): number {
  return Buffer.byteLength(JSON.stringify(explanations), "utf8");
}
