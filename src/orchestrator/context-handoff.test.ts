import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import {
  SprintContractSchema,
  type SprintContract,
} from "../contracts/sprint-contract.js";
import { PlanSpecSchema } from "../contracts/spec.js";
import { isSettledContractStatus } from "../contracts/sprint-contract.js";
import { listContracts } from "../state/sprint-state.js";
import {
  DEFAULT_KEEP_RECENT_SPRINTS,
  MAX_KEEP_RECENT_SPRINTS,
  MAX_SUMMARIZED_DESCRIPTION_LENGTH,
  MAX_SUMMARIZED_SPRINTS,
  createHandoff,
  deserializeHandoff,
  serializeHandoff,
  serializeHandoffForPrompt,
  summarizeOlderSprints,
  type ContextHandoff,
} from "./context-handoff.js";

/**
 * The defect these tests pin: a handoff's `sprintHistory` grew without bound
 * with project age, and the whole of it was serialized into a live model
 * prompt.
 *
 * Sprint 1 of spec-20260812-terminal-vocabulary fixed the five contract-
 * terminal readers to use `isSettledContractStatus`, which resolved the
 * "completed contracts" list from permanently-empty to the entire settled
 * corpus. Measured against this repository's own `.bober/contracts/` at that
 * point — 178 settled contracts as `listContracts` returns them — that list
 * serialized to 1,501,283 bytes, and `summarizeOlderSprints(handoff, 3)` only
 * brought it to 314,860: the
 * summarizer kept ONE ENTRY PER CONTRACT and retained each full description,
 * so it bounded nothing asymptotically. Four evaluator handoffs and the PGE
 * generator handoff applied no compaction at all.
 *
 * The assertion that matters is therefore not "small" but "does not grow":
 * `serializedSizeGrowsNotAtAll` below drives N over four orders of magnitude
 * and requires the serialized prompt to stay flat.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));

// ── Synthetic corpus ────────────────────────────────────────────────

/**
 * A settled contract of realistic size. Field lengths are drawn from this
 * repository's real corpus (median description 465 chars) so the numbers the
 * bound is measured against are not toy-sized.
 */
function syntheticContract(n: number): SprintContract {
  return SprintContractSchema.parse({
    contractId: `sprint-spec-synthetic-${n}`,
    specId: "spec-synthetic",
    sprintNumber: n,
    title: `Sprint ${n} — a title of about the length this repository actually writes`,
    description:
      `Sprint ${n} does a representative unit of work. `.padEnd(60, " ") +
      "It carries a description of roughly the median length observed across this repository's " +
      "own committed contracts, so that a bound measured against this corpus is measured against " +
      "realistic input rather than a toy string that would make any implementation look bounded. " +
      "Four hundred and sixty-five characters is the median; this is close to it.",
    status: n % 2 === 0 ? "completed" : "passed",
    dependsOn: n > 1 ? [`sprint-spec-synthetic-${n - 1}`] : [],
    features: [`feature-${n}`],
    successCriteria: [
      {
        criterionId: `sc-${n}-1`,
        description:
          "The synthetic criterion is long enough to satisfy the schema's minimum description length.",
        verificationMethod: "unit-test",
        required: true,
      },
      {
        criterionId: `sc-${n}-2`,
        description:
          "A second criterion, so summarized entries measurably drop more than one array element.",
        verificationMethod: "typecheck",
        required: true,
      },
    ],
    nonGoals: [`Anything outside sprint ${n}'s stated scope`],
    stopConditions: [`All of sprint ${n}'s required criteria pass`],
    definitionOfDone: `Sprint ${n} is done when every required criterion passes and no regression appears.`,
    assumptions: [`Sprint ${n - 1} landed as described`],
    outOfScope: ["Refactoring unrelated modules"],
    estimatedFiles: [`src/synthetic/module-${n}.ts`],
    iterationHistory: [],
    lastEvalId: null,
    startedAt: "2026-01-01T00:00:00.000Z",
    completedAt: "2026-01-02T00:00:00.000Z",
  });
}

function syntheticHistory(count: number): SprintContract[] {
  return Array.from({ length: count }, (_, i) => syntheticContract(i + 1));
}

function handoffWithHistory(count: number): ContextHandoff {
  return createHandoff({
    from: "generator",
    to: "evaluator",
    projectContext: {
      name: "synthetic",
      type: "typescript",
      techStack: ["typescript"],
      entryPoints: ["src/index.ts"],
      currentBranch: "main",
    },
    spec: PlanSpecSchema.parse({
      specId: "spec-synthetic",
      title: "Synthetic spec",
      description: "A spec used only to measure handoff size growth.",
      status: "in-progress",
      mode: "brownfield",
      features: [],
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    }),
    currentContract: syntheticContract(count + 1),
    sprintHistory: syntheticHistory(count),
    instructions: "Evaluate the current sprint.",
  });
}

// ── The bound ───────────────────────────────────────────────────────

describe("handoff sprintHistory is bounded independently of project age", () => {
  /**
   * THE regression test. A serialized prompt handoff must not grow as the
   * project accumulates sprints. Driven over four orders of magnitude of N so
   * that any per-sprint term — even a few bytes each — shows up as a
   * multi-kilobyte delta and fails.
   */
  it("serialized prompt size does not grow with the number of settled sprints", () => {
    // Every N here is past the cap (MAX_SUMMARIZED_SPRINTS + keepRecent = 23),
    // spanning three orders of magnitude. Any surviving per-sprint term — even
    // a few bytes each — is a multi-kilobyte delta at N=25,000 and fails.
    const sizes = [25, 250, 2_500, 25_000].map(
      (n) => serializeHandoffForPrompt(handoffWithHistory(n)).length,
    );

    // Flat. The residual variation is O(log N), not O(N): the fixture's sprint
    // numbers appear in each retained entry's id, title and dependsOn, so ids
    // widen from 2 digits at N=25 to 5 at N=25,000 across a FIXED 24 entries.
    // 1 KB leaves room for that and still fails hard on real growth — a
    // surviving term of even one byte per sprint is 25 KB at N=25,000.
    const [smallest] = sizes;
    for (const size of sizes) {
      expect(Math.abs(size - smallest)).toBeLessThan(1024);
    }

    // A fixed ceiling too, so trading linear growth for a huge constant also
    // fails. Uncompacted, N=25,000 of these contracts serializes to ~40 MB.
    for (const size of sizes) {
      expect(size).toBeLessThan(64 * 1024);
    }

    // Liveness: the bound is doing work, not passing because the fixture is
    // empty. A project below the cap keeps genuinely more history than one
    // above it, and the raw handoff at N=25,000 is enormous.
    expect(serializeHandoffForPrompt(handoffWithHistory(4)).length).toBeLessThan(
      smallest,
    );
    expect(serializeHandoff(handoffWithHistory(25_000)).length).toBeGreaterThan(
      100 * smallest,
    );
  });

  it("keeps at most MAX_SUMMARIZED_SPRINTS summaries plus the recent full sprints", () => {
    const compacted = summarizeOlderSprints(
      handoffWithHistory(5_000),
      DEFAULT_KEEP_RECENT_SPRINTS,
    );

    // summaries + the single elision entry + the full-detail tail
    expect(compacted.sprintHistory).toHaveLength(
      MAX_SUMMARIZED_SPRINTS + 1 + DEFAULT_KEEP_RECENT_SPRINTS,
    );
  });

  it("truncates summarized descriptions and says so", () => {
    const compacted = summarizeOlderSprints(
      handoffWithHistory(50),
      DEFAULT_KEEP_RECENT_SPRINTS,
    );
    const summaries = compacted.sprintHistory.filter((c) =>
      c.description.startsWith("[Summarized]"),
    );
    expect(summaries.length).toBeGreaterThan(0);

    for (const entry of summaries) {
      // prefix + cap + an announcement of what was cut — never a bare prefix
      expect(entry.description.length).toBeLessThan(
        MAX_SUMMARIZED_DESCRIPTION_LENGTH + 60,
      );
      expect(entry.description).toContain("chars omitted]");
    }
  });

  it("announces elided sprints rather than dropping them silently", () => {
    const total = 500;
    const compacted = summarizeOlderSprints(
      handoffWithHistory(total),
      DEFAULT_KEEP_RECENT_SPRINTS,
    );

    const elision = compacted.sprintHistory[0];
    const dropped = total - DEFAULT_KEEP_RECENT_SPRINTS - MAX_SUMMARIZED_SPRINTS;
    expect(elision.contractId).toBe("elided-sprint-history");
    expect(elision.title).toContain(`${dropped} earlier sprints omitted`);
    // The count is real, not decorative: it accounts for every input entry.
    expect(dropped + MAX_SUMMARIZED_SPRINTS + DEFAULT_KEEP_RECENT_SPRINTS).toBe(
      total,
    );
  });

  it("keeps the MOST RECENT sprints, in order, at full detail", () => {
    const compacted = summarizeOlderSprints(
      handoffWithHistory(500),
      DEFAULT_KEEP_RECENT_SPRINTS,
    );
    const tail = compacted.sprintHistory.slice(-DEFAULT_KEEP_RECENT_SPRINTS);

    expect(tail.map((c) => c.contractId)).toEqual([
      "sprint-spec-synthetic-498",
      "sprint-spec-synthetic-499",
      "sprint-spec-synthetic-500",
    ]);
    // Full detail: original criteria survive, unlike a summarized entry.
    expect(tail[0].successCriteria).toHaveLength(2);
    expect(tail[0].description.startsWith("[Summarized]")).toBe(false);
  });

  it("clamps keepRecent so a caller cannot ask its way out of the bound", () => {
    const compacted = summarizeOlderSprints(handoffWithHistory(5_000), 5_000);

    expect(compacted.sprintHistory.length).toBeLessThanOrEqual(
      MAX_SUMMARIZED_SPRINTS + 1 + MAX_KEEP_RECENT_SPRINTS,
    );
    expect(serializeHandoff(compacted).length).toBeLessThan(64 * 1024);
  });

  it("leaves a history shorter than keepRecent untouched", () => {
    const handoff = handoffWithHistory(2);
    expect(summarizeOlderSprints(handoff, DEFAULT_KEEP_RECENT_SPRINTS)).toBe(
      handoff,
    );
  });

  it("is idempotent, so an explicit call site pays nothing and loses nothing", () => {
    const once = summarizeOlderSprints(
      handoffWithHistory(500),
      DEFAULT_KEEP_RECENT_SPRINTS,
    );
    const twice = summarizeOlderSprints(once, DEFAULT_KEEP_RECENT_SPRINTS);

    expect(serializeHandoff(twice)).toBe(serializeHandoff(once));
  });

  it("emits a compacted handoff that still round-trips through the schema", () => {
    const json = serializeHandoffForPrompt(handoffWithHistory(500));

    // Throws on any schema violation — including the synthetic elision and
    // summary entries, which must satisfy the contract's precision minimums.
    const parsed = deserializeHandoff(json);
    expect(parsed.sprintHistory.length).toBe(
      MAX_SUMMARIZED_SPRINTS + 1 + DEFAULT_KEEP_RECENT_SPRINTS,
    );
  });

  it("does not mutate the caller's handoff", () => {
    const handoff = handoffWithHistory(500);
    summarizeOlderSprints(handoff, DEFAULT_KEEP_RECENT_SPRINTS);
    expect(handoff.sprintHistory).toHaveLength(500);
  });
});

// ── Against the real corpus ─────────────────────────────────────────

/**
 * The synthetic fixture above can drift from reality; this cannot. It drives
 * the same settled list the four evaluator call sites build — `listContracts`
 * filtered by `isSettledContractStatus`, exactly as
 * `src/mcp/tools/eval.ts` and `src/cli/commands/eval.ts` do — against this
 * repository's committed `.bober/contracts/`, and requires the prompt the
 * model would actually receive to be bounded.
 */
describe("the real committed corpus, through the real settled filter", () => {
  it("compacts to a bounded prompt no matter how far the corpus has grown", async () => {
    const contracts = await listContracts(REPO_ROOT);
    const settled = contracts.filter((c) => isSettledContractStatus(c.status));

    // Liveness: an empty corpus would make every assertion below vacuous, and
    // the corpus being non-empty is itself what sprint 1 fixed.
    expect(settled.length).toBeGreaterThan(MAX_SUMMARIZED_SPRINTS);

    const handoff = createHandoff({
      from: "generator",
      to: "evaluator",
      projectContext: {
        name: "agent-bober",
        type: "typescript",
        techStack: ["typescript"],
        entryPoints: ["src/index.ts"],
        currentBranch: "main",
      },
      spec: PlanSpecSchema.parse({
        specId: "spec-real-corpus",
        title: "Real corpus",
        description: "Measures the bound against this repository's own history.",
        status: "in-progress",
        mode: "brownfield",
        features: [],
        createdAt: "2026-01-01T00:00:00.000Z",
        updatedAt: "2026-01-01T00:00:00.000Z",
      }),
      currentContract: settled[settled.length - 1],
      sprintHistory: settled,
      instructions: "Evaluate the current sprint.",
    });

    const raw = serializeHandoff(handoff).length;
    const bounded = serializeHandoffForPrompt(handoff).length;

    // At 178 settled contracts the raw handoff measured 1,541,849 bytes — far
    // past any model's context window, and shipped verbatim by four evaluator
    // call sites; bounded, it is 60,616. The bounded form must stay a small
    // fraction of the raw one, and the gap widens with every sprint added.
    expect(bounded).toBeLessThan(128 * 1024);
    expect(bounded).toBeLessThan(raw / 4);
  });
});

// ── The bound cannot be bypassed ────────────────────────────────────

/**
 * Enforcing the bound at the call sites is what failed: four evaluator
 * handoffs and the PGE generator handoff shipped the whole settled corpus.
 * The bound now lives in `serializeHandoffForPrompt`, so this scan pins that
 * no production module builds prompt text from the raw serializer instead.
 */
describe("no production prompt path bypasses the bound", () => {
  async function productionSources(dir: string): Promise<string[]> {
    const entries = await readdir(dir, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        files.push(...(await productionSources(full)));
      } else if (
        entry.name.endsWith(".ts") &&
        !entry.name.endsWith(".test.ts") &&
        !entry.name.endsWith(".d.ts")
      ) {
        files.push(full);
      }
    }
    return files;
  }

  it("only context-handoff.ts calls serializeHandoff directly", async () => {
    const files = await productionSources(join(REPO_ROOT, "src"));
    expect(files.length).toBeGreaterThan(0);

    const offenders: string[] = [];
    for (const file of files) {
      const source = await readFile(file, "utf8");
      // "serializeHandoffForPrompt(" does not match: the char after the name
      // is "F", not "(". Re-exports in index.ts carry no paren either.
      if (source.includes("serializeHandoff(")) {
        offenders.push(file.slice(REPO_ROOT.length));
      }
    }

    expect(offenders).toEqual(["src/orchestrator/context-handoff.ts"]);
  });

  it("both agent prompt builders use the bounded serializer", async () => {
    for (const file of [
      "src/orchestrator/generator-agent.ts",
      "src/orchestrator/evaluator-agent.ts",
    ]) {
      const source = await readFile(join(REPO_ROOT, file), "utf8");
      expect(source).toContain("serializeHandoffForPrompt(handoff)");
    }
  });
});
