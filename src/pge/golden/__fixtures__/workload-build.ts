// ── workload-build.ts — how the committed workload corpus comes into existence ──

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { PlanSpecSchema } from "../../../contracts/spec.js";
import type { PlanSpecStatus } from "../../../contracts/spec.js";
import { SprintContractSchema } from "../../../contracts/sprint-contract.js";
import type { SprintContract } from "../../../contracts/sprint-contract.js";
import { PgeEngine } from "../../engine/pge-engine.js";
import {
  REPO_ROOT,
  conformanceConfig,
  seedCommittedArtifact,
  wholeGraphBindings,
} from "../../engine/__fixtures__/whole-graph.js";
import { anchorId } from "../../nodes/anchors.js";
import type { ChannelUpdate } from "../../runtime/commit.js";
import { createFixedClock } from "../../runtime/commit.js";
import { createGraphInterpreter } from "../../runtime/interpreter.js";
import type { GraphInterpreter, RunContext } from "../../runtime/interpreter.js";
import { GraphMessageSchema, SprintVerdictSchema } from "../../state/overall.js";
import { WORKLOAD_DIR } from "../workload.js";
import type { WorkloadEntry, WorkloadProvenance } from "../workload.js";

/**
 * Turns this checkout's own committed real data into the corpus at `.bober/workload/`.
 *
 * Invoked from `workload.test.ts` behind `BUILD_WORKLOAD_CORPUS=1`, the same regeneration
 * shape `capture.ts`/`capture.test.ts` and `real-workload.test.ts`'s own `MEASURE_REAL_WORKLOAD=1`
 * use: a rewrite is a deliberate act with a visible `git diff`, never an implicit side
 * effect of running the suite.
 *
 * ── The four sources, and why each one is what it is ──
 *
 *  1. `spec` / `sprintContracts` — EVERY file under `.bober/specs/` that parses under
 *     {@link PlanSpecSchema} AND has reached a {@link TERMINAL_SPEC_STATUSES terminal status}
 *     becomes one `spec` entry, and its own `spec.sprints`, resolved against
 *     `.bober/contracts/`, becomes one `sprintContracts` entry carrying the WHOLE array —
 *     the shape a real `plan_materialize` write actually is (`src/pge/nodes/plan.ts:421`),
 *     not one contract at a time. 60 of 250 committed contracts and 1 of 53 committed specs
 *     do not parse; both are SKIPPED, by file name. A spec whose own status is NOT terminal
 *     is separately EXCLUDED (see {@link TERMINAL_SPEC_STATUSES}) — it is not a parse
 *     failure, so it is reported through its own {@link BuildReport} field. All three skip
 *     counts are the caller's to report — see {@link BuildReport}.
 *  2. `evaluations` / `messages` — a representative sample (the largest real payload plus a
 *     deterministic spread) of `.bober/eval-results/*.json` summaries and
 *     `.bober/handoffs/gen-report-*.json` notes, each wrapped in the real
 *     `SprintVerdict`/`GraphMessage` shape the channel declares.
 *  3. `testAnchors` / `verdict` — derived from one real committed contract's own
 *     `successCriteria` (via the real {@link anchorId}) and from sprint 1's own committed
 *     measurement's real `verdict`, respectively.
 *  4. `refs` / `counters` / `branchStatus` / `ledger` — no committed file anywhere in the
 *     repository carries one (see the spec's own assumptions). OBSERVED instead: a real
 *     `PgeEngine` run over `wholeGraphBindings`/`conformanceConfig()` (the same deterministic
 *     collaborator set the conformance harness runs), with `RunContext.commit` wrapped to
 *     record every `ChannelUpdate` the interpreter actually committed. `GraphRunResult`
 *     carries no per-write values — only the merged final state — so the spy is the only way
 *     to recover the genuine per-write payload.
 */

// ── Report ──────────────────────────────────────────────────────────

export interface BuildReport {
  readonly written: number;
  readonly skippedSpecs: readonly string[];
  readonly skippedContracts: readonly string[];
  readonly excludedInFlightSpecs: readonly string[];
}

// ── In-flight exclusion ────────────────────────────────────────────

/**
 * The two {@link PlanSpecStatus} values that mean "this spec's own sprint contract files
 * will never be rewritten again by the pipeline that ran it."
 *
 * ── Why this exists — a real defect this corpus hit ──
 *
 * A `sprintContracts` entry is a snapshot of `SprintContractSchema.parse`d bytes read from
 * `.bober/contracts/<sprintId>.json` at BUILD time. Those files are not immutable: the
 * orchestrator that runs a spec's sprints rewrites `status` / `completedAt` /
 * `iterationHistory` INTO THE SAME FILE as each sprint proceeds through
 * proposed → in-progress → completed. So a `sprintContracts` entry captured for a spec
 * that is still being worked goes stale the moment the very next sprint completes — not
 * from drift or a later rebuild, but during the SAME pipeline run that produced the
 * snapshot. This bit for real: sprint 3 of `spec-20260812-pge-real-workload-errors` — the
 * spec whose OWN corpus entry this is — completed sprint 2 between the corpus being built
 * and this test running, and `workload.test.ts`'s "every 'file-group' sprintContracts entry
 * equals the array its own paths parse to" check (which re-parses the source files at TEST
 * time, on purpose — see that file's own header) caught the disagreement. A corpus that
 * invalidates itself while the pipeline that built it is still running cannot serve as a
 * permanent, committed reference.
 *
 * `messages` and `evaluations` do NOT share this failure mode: their sources
 * (`.bober/handoffs/gen-report-*.json`, `.bober/eval-results/*.json`) are written once per
 * (contract, iteration) under an iteration-suffixed filename and never rewritten in place —
 * only WHICH files the representative sample picks can change on a rebuild (see
 * `capForCorpusMax`'s doc comment in `../workload.ts` for why that sampling drift is already
 * absorbed). `spec` / `sprintContracts` are the only two channels sourced from files that
 * are mutated in place across a run, so they are the only two this exclusion applies to.
 *
 * The fix is a property of the SPEC, not a name: any spec not yet at a terminal status is
 * still eligible to have its contract files rewritten by its own pipeline run, so its
 * `spec` and `sprintContracts` entries are excluded — never merely the one specId that
 * happened to surface the bug. A future spec that is mid-run when the corpus is rebuilt is
 * excluded the same way, automatically, with no name to remove later.
 */
const TERMINAL_SPEC_STATUSES: ReadonlySet<PlanSpecStatus> = new Set(["completed", "abandoned"]);

// ── Small helpers ───────────────────────────────────────────────────

/** The sprint number a `contractId` like `sprint-<specId>-07` ends in. */
function sprintNumberOf(contractId: string): number {
  const match = /-(\d+)$/.exec(contractId);
  const parsed = match ? Number.parseInt(match[1] ?? "", 10) : Number.NaN;
  return Number.isFinite(parsed) && parsed >= 1 ? parsed : 1;
}

/**
 * The largest items by `sizeOf`, plus a deterministic spread across the rest.
 *
 * Deterministic (sorted, not random) so two regenerations of an unchanged corpus produce
 * byte-identical files. Always includes the genuine maximum — nonGoal 2 forbids trimming a
 * corpus to make a number look better, and a sample that dropped the largest real payload
 * would do exactly that.
 */
function representativeSample<T>(items: readonly T[], sizeOf: (item: T) => number, count: number): T[] {
  if (items.length <= count) return [...items];
  const sorted = [...items].sort((a, b) => sizeOf(b) - sizeOf(a));
  const topCount = Math.ceil(count / 2);
  const top = sorted.slice(0, topCount);
  const rest = sorted.slice(topCount);
  const wanted = count - top.length;
  const step = Math.max(1, Math.floor(rest.length / Math.max(1, wanted)));
  const spread: T[] = [];
  for (let index = 0; index < rest.length && spread.length < wanted; index += step) {
    const item = rest[index];
    if (item !== undefined) spread.push(item);
  }
  return [...top, ...spread];
}

// ── Writer ──────────────────────────────────────────────────────────

function entryPath(dir: string, entryId: string): string {
  return join(dir, `${entryId}.json`);
}

async function writeEntry(dir: string, entry: WorkloadEntry): Promise<void> {
  await writeFile(entryPath(dir, entry.entryId), `${JSON.stringify(entry, null, 2)}\n`, "utf-8");
}

// ── 1. spec + sprintContracts ───────────────────────────────────────

async function buildSpecAndContractEntries(
  write: (entry: WorkloadEntry) => Promise<void>,
): Promise<{ skippedSpecs: string[]; skippedContracts: string[]; excludedInFlightSpecs: string[] }> {
  const specsDir = join(REPO_ROOT, ".bober", "specs");
  const contractsDir = join(REPO_ROOT, ".bober", "contracts");
  const specFiles = (await readdir(specsDir)).filter((file) => file.endsWith(".json")).sort();

  const skippedSpecs: string[] = [];
  const skippedContracts: string[] = [];
  const excludedInFlightSpecs: string[] = [];

  for (const file of specFiles) {
    const raw: unknown = JSON.parse(await readFile(join(specsDir, file), "utf-8"));
    const parsedSpec = PlanSpecSchema.safeParse(raw);
    if (!parsedSpec.success) {
      skippedSpecs.push(file);
      continue;
    }
    const spec = parsedSpec.data;

    // See TERMINAL_SPEC_STATUSES: a spec still short of a terminal status is still eligible
    // to have its own `.bober/contracts/*.json` files rewritten in place by the pipeline
    // running it, so neither its `spec` nor its `sprintContracts` entry is trustworthy as a
    // permanent, committed snapshot.
    if (!TERMINAL_SPEC_STATUSES.has(spec.status)) {
      excludedInFlightSpecs.push(`${file} (status: ${spec.status})`);
      continue;
    }

    await write({
      entryId: `spec-${spec.specId}`,
      channel: "spec",
      provenance: { kind: "file", path: relative(REPO_ROOT, join(specsDir, file)) },
      value: spec,
    });

    const sprintIds = (spec.sprints ?? []).filter((id): id is string => typeof id === "string");
    const contracts: SprintContract[] = [];
    const paths: string[] = [];
    for (const sprintId of sprintIds) {
      const contractPath = join(contractsDir, `${sprintId}.json`);
      let contractRaw: unknown;
      try {
        contractRaw = JSON.parse(await readFile(contractPath, "utf-8"));
      } catch {
        skippedContracts.push(`${sprintId}.json (unreadable from ${spec.specId})`);
        continue;
      }
      const parsedContract = SprintContractSchema.safeParse(contractRaw);
      if (!parsedContract.success) {
        skippedContracts.push(`${sprintId}.json`);
        continue;
      }
      contracts.push(parsedContract.data);
      paths.push(relative(REPO_ROOT, contractPath));
    }

    if (contracts.length > 0) {
      await write({
        entryId: `sprintContracts-${spec.specId}`,
        channel: "sprintContracts",
        provenance: { kind: "file-group", paths },
        value: contracts,
      });
    }
  }

  return { skippedSpecs, skippedContracts, excludedInFlightSpecs };
}

// ── 2. evaluations + messages ───────────────────────────────────────

interface RawEvalResult {
  readonly evalId: string;
  readonly contractId: string;
  readonly iteration: number;
  readonly overallResult: string;
  readonly summary: string;
}

async function buildEvaluationEntries(write: (entry: WorkloadEntry) => Promise<void>): Promise<void> {
  const evalDir = join(REPO_ROOT, ".bober", "eval-results");
  const files = (await readdir(evalDir)).filter((file) => file.endsWith(".json")).sort();

  const records: { file: string; raw: RawEvalResult }[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(evalDir, file), "utf-8")) as Partial<RawEvalResult>;
    if (typeof raw.summary !== "string" || raw.summary.length === 0) continue;
    if (typeof raw.evalId !== "string" || typeof raw.contractId !== "string") continue;
    records.push({
      file,
      raw: {
        evalId: raw.evalId,
        contractId: raw.contractId,
        iteration: typeof raw.iteration === "number" ? raw.iteration : 1,
        overallResult: raw.overallResult ?? "fail",
        summary: raw.summary,
      },
    });
  }

  const sample = representativeSample(records, (record) => record.raw.summary.length, 6);
  for (const { file, raw } of sample) {
    const verdict = SprintVerdictSchema.parse({
      id: raw.evalId,
      seq: 0,
      contractId: raw.contractId,
      sprintNumber: sprintNumberOf(raw.contractId),
      iteration: raw.iteration,
      verdict: raw.overallResult === "pass" ? "pass" : "fail",
      summary: raw.summary,
      evalId: raw.evalId,
    });
    await write({
      entryId: `evaluations-${raw.evalId}`,
      channel: "evaluations",
      provenance: { kind: "file", path: relative(REPO_ROOT, join(evalDir, file)) },
      value: verdict,
    });
  }
}

interface RawGenReport {
  readonly contractId: string;
  readonly iteration: number;
  readonly notes: string;
}

async function buildMessageEntries(write: (entry: WorkloadEntry) => Promise<void>): Promise<void> {
  const handoffDir = join(REPO_ROOT, ".bober", "handoffs");
  const files = (await readdir(handoffDir))
    .filter((file) => file.startsWith("gen-report-") && file.endsWith(".json"))
    .sort();

  const records: { file: string; raw: RawGenReport }[] = [];
  for (const file of files) {
    const raw = JSON.parse(await readFile(join(handoffDir, file), "utf-8")) as Partial<RawGenReport>;
    if (typeof raw.notes !== "string" || raw.notes.length === 0) continue;
    if (typeof raw.contractId !== "string") continue;
    records.push({
      file,
      raw: { contractId: raw.contractId, iteration: typeof raw.iteration === "number" ? raw.iteration : 1, notes: raw.notes },
    });
  }

  const sample = representativeSample(records, (record) => record.raw.notes.length, 6);
  let seq = 0;
  for (const { file, raw } of sample) {
    seq += 1;
    const message = GraphMessageSchema.parse({
      id: `${raw.contractId}:generator:${String(raw.iteration)}`,
      seq,
      role: "assistant",
      nodeId: "sprint_generate",
      text: raw.notes,
      tokens: raw.notes.length,
    });
    await write({
      entryId: `messages-${raw.contractId}-${String(raw.iteration)}`,
      channel: "messages",
      provenance: { kind: "file", path: relative(REPO_ROOT, join(handoffDir, file)) },
      value: message,
    });
  }
}

// ── 3. testAnchors + verdict ─────────────────────────────────────────

/** A real committed contract with several distinct verification methods, for a genuine anchor set. */
const ANCHOR_SOURCE_CONTRACT_ID = "sprint-spec-20260812-pge-real-workload-errors-1";

async function buildAnchorEntry(write: (entry: WorkloadEntry) => Promise<void>): Promise<void> {
  const contractPath = join(REPO_ROOT, ".bober", "contracts", `${ANCHOR_SOURCE_CONTRACT_ID}.json`);
  const raw: unknown = JSON.parse(await readFile(contractPath, "utf-8"));
  const contract = SprintContractSchema.parse(raw);
  const anchors = contract.successCriteria.map((criterion) => anchorId(criterion.verificationMethod, criterion.criterionId));
  await write({
    entryId: `testAnchors-${contract.contractId}`,
    channel: "testAnchors",
    provenance: { kind: "file", path: relative(REPO_ROOT, contractPath) },
    value: anchors,
  });
}

async function buildVerdictEntry(write: (entry: WorkloadEntry) => Promise<void>): Promise<void> {
  const measurementPath = join(REPO_ROOT, ".bober", "topology", "measurements", "real-workload.json");
  const measurement = JSON.parse(await readFile(measurementPath, "utf-8")) as { verdict: string | null };
  if (measurement.verdict === null) return;
  await write({
    entryId: "verdict-real-workload-measurement",
    channel: "verdict",
    provenance: { kind: "file", path: relative(REPO_ROOT, measurementPath) },
    value: measurement.verdict,
  });
}

// ── 4. refs, counters, branchStatus, ledger — observed from a real run ──

const OBSERVE_RUN_ID = "run-workload-observe";
const OBSERVE_INSTANT = "2026-08-12T00:00:00.000Z";
const OBSERVED_CHANNELS = ["refs", "counters", "branchStatus", "ledger"] as const;

/**
 * Every `ChannelUpdate` a real `PgeEngine` run committed, captured through
 * `RunContext.commit` — the same interception technique sprint 1's
 * `recordingInterpreterFactory` uses on `PgeEngineDeps.interpreterFactory`, one layer
 * deeper: `GraphRunResult` carries only the merged final state, never the individual writes
 * that produced it, so recovering a genuine per-write payload needs the boundary itself.
 */
async function observeChannelUpdates(): Promise<ChannelUpdate[]> {
  const projectRoot = await mkdtemp(join(tmpdir(), "bober-workload-observe-"));
  try {
    await seedCommittedArtifact(projectRoot);
    const updates: ChannelUpdate[] = [];

    const recordingInterpreterFactory = (): GraphInterpreter => {
      const inner = createGraphInterpreter();
      const wrap = (ctx: RunContext): RunContext => ({
        ...ctx,
        commit: {
          ...ctx.commit,
          commit: (graph, current, batch, cctx) => {
            updates.push(...batch);
            return ctx.commit.commit(graph, current, batch, cctx);
          },
        },
      });
      return {
        run: (graph, init, ctx) => inner.run(graph, init, wrap(ctx)),
        resume: (graph, ref, resumeValue, ctx) => inner.resume(graph, ref, resumeValue, wrap(ctx)),
      };
    };

    try {
      await new PgeEngine({
        clock: createFixedClock(OBSERVE_INSTANT),
        bindings: (input) => wholeGraphBindings(input),
        interpreterFactory: recordingInterpreterFactory,
      }).run(
        "Exercise the whole graph so the workload corpus can observe the channels no committed file carries a payload for.",
        projectRoot,
        conformanceConfig(),
        { runId: OBSERVE_RUN_ID },
      );
    } catch {
      // Best-effort: every superstep that DID commit before a later failure already pushed
      // its batch onto `updates`, and those are genuine observed writes regardless of how
      // the run eventually ended.
    }

    return updates;
  } finally {
    await rm(projectRoot, { recursive: true, force: true });
  }
}

async function buildObservedEntries(write: (entry: WorkloadEntry) => Promise<void>): Promise<void> {
  const updates = await observeChannelUpdates();
  const wanted = new Set<string>(OBSERVED_CHANNELS);

  const byChannel = new Map<string, ChannelUpdate[]>();
  for (const update of updates) {
    if (!wanted.has(update.channel)) continue;
    const bucket = byChannel.get(update.channel) ?? [];
    const alreadySeen = bucket.some((existing) => JSON.stringify(existing.value) === JSON.stringify(update.value));
    if (!alreadySeen) bucket.push(update);
    byChannel.set(update.channel, bucket);
  }

  for (const channel of OBSERVED_CHANNELS) {
    const bucket = byChannel.get(channel) ?? [];
    for (const [index, update] of bucket.entries()) {
      const provenance: WorkloadProvenance = {
        kind: "observed",
        source: `node "${update.nodeId}" writing "${channel}" during a wholeGraphBindings run of the coding graph (run ${OBSERVE_RUN_ID})`,
      };
      await write({
        entryId: `${channel}-observed-${String(index + 1)}`,
        channel,
        provenance,
        value: update.value,
      });
    }
  }
}

// ── Entry point ─────────────────────────────────────────────────────

/** Rebuilds the whole committed corpus at `.bober/workload/` from this checkout's own data. */
export async function buildWorkloadCorpus(): Promise<BuildReport> {
  const dir = join(REPO_ROOT, WORKLOAD_DIR);
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });

  let written = 0;
  const write = async (entry: WorkloadEntry): Promise<void> => {
    await writeEntry(dir, entry);
    written += 1;
  };

  const { skippedSpecs, skippedContracts, excludedInFlightSpecs } = await buildSpecAndContractEntries(write);
  await buildEvaluationEntries(write);
  await buildMessageEntries(write);
  await buildAnchorEntry(write);
  await buildVerdictEntry(write);
  await buildObservedEntries(write);

  return { written, skippedSpecs, skippedContracts, excludedInFlightSpecs };
}
