import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { PlanSpecSchema } from "../../../contracts/spec.js";
import type { PlanSpec } from "../../../contracts/spec.js";
import { SprintContractSchema } from "../../../contracts/sprint-contract.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import type { CodingBindings } from "../../registry/index.js";
import type { PgeRegistriesInput } from "../pge-engine.js";
import { REPO_ROOT, wholeGraphBindings } from "./whole-graph.js";

/**
 * The real workload sprint 1 of spec-20260812-pge-real-workload-errors measures the graph
 * engine against: this checkout's own committed multi-sprint `PlanSpec`, and the
 * `SprintContract`s it materialised to.
 *
 * ── Why THIS spec ──
 *
 * Every case in the 42-case golden dataset is a fixture, and the largest `PlanSpec`-shaped
 * object anywhere in it is 1,181 bytes — nowhere near the 4096-byte cap every channel in
 * `.bober/topology/coding.json` declares. `spec-20260805-pge-graph-engineering.json` is not
 * a fixture: it is the 14-sprint plan that BUILT the graph engine itself, checked into this
 * repository the way any other artifact is. Measuring against it is measuring against a
 * real plan rather than a synthetic one nobody would ever actually submit.
 *
 * ── What is deliberately NOT here ──
 *
 * Driving a `PgeEngine` and capturing the interpreter's own `GraphRunResult` — that
 * happens in `real-workload.test.ts`, through the engine's own `PgeEngineDeps.interpreterFactory`
 * seam (`../pge-engine.ts:162`). This module only loads data and builds the one collaborator
 * override the workload needs; it drives nothing.
 */

// ── The real spec ────────────────────────────────────────────────────

export const REAL_SPEC_ID = "spec-20260805-pge-graph-engineering";
export const REAL_SPEC_PATH = join(REPO_ROOT, ".bober", "specs", `${REAL_SPEC_ID}.json`);

/** The real spec, parsed. Every byte measurement is taken off this PARSED value, never the file. */
export async function realPlanSpec(): Promise<PlanSpec> {
  return PlanSpecSchema.parse(JSON.parse(await readFile(REAL_SPEC_PATH, "utf-8")));
}

/**
 * `spec.sprints`' own committed contract files, read from `.bober/contracts/` rather than
 * hand-listed — so a spec that gains or loses a sprint changes what this loads without this
 * fixture being edited.
 */
export async function realContracts(spec: PlanSpec): Promise<SprintContract[]> {
  // `PlanSpec.sprints` is `z.array(z.unknown()).optional()` (src/contracts/spec.ts:160) — a
  // spec's own sprint ids, untyped at the schema boundary because the planner writes them
  // before any contract exists to validate against. Narrowed to strings here rather than
  // cast, so a spec whose `sprints` entry is not a string id fails loudly instead of
  // producing a broken file path.
  const sprintIds = (spec.sprints ?? []).filter((id): id is string => typeof id === "string");
  const contracts: SprintContract[] = [];
  for (const sprintId of sprintIds) {
    const path = join(REPO_ROOT, ".bober", "contracts", `${sprintId}.json`);
    contracts.push(SprintContractSchema.parse(JSON.parse(await readFile(path, "utf-8"))));
  }
  return contracts;
}

/** The real spec and its real contracts, held together for the life of one measurement. */
export interface Workload {
  readonly spec: PlanSpec;
  readonly contracts: SprintContract[];
}

export async function realWorkload(): Promise<Workload> {
  const spec = await realPlanSpec();
  return { spec, contracts: await realContracts(spec) };
}

// ── Bindings ────────────────────────────────────────────────────────

/**
 * `wholeGraphBindings` with ONLY the two plan-region collaborators replaced: the planner
 * answers with the REAL spec instead of drafting `goldenPlanSpec()`, and materialize
 * answers with the REAL committed contracts instead of `whole-graph.ts`'s four. Every other
 * collaborator — research, curator, generator, evaluator, reviewer, documenter, committer —
 * is the shipped whole-graph fixture body, unchanged, so anything downstream of the plan
 * region is attributable to the byte caps and not to a second fixture.
 */
export function realWorkloadBindings(input: PgeRegistriesInput, workload: Workload): CodingBindings {
  const base = wholeGraphBindings(input);
  return {
    ...base,
    planner: async () => ({ kind: "ready" as const, spec: workload.spec }),
    materialize: async () => workload.contracts,
  };
}
