import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ProblemReflection, ResearchDigest } from "../../contracts/problem-reflection.js";
import { readFailureArtifact } from "../runtime/graceful-failure.js";
import { LOOP_EXHAUSTED_ERROR_CLASS } from "../runtime/interpreter.js";
import { CODING_GRAPH } from "../topology/coding.graph.js";
import {
  PROSE_ONLY_REFLECTION,
  compileRegion,
  runRegion,
  stubReflection,
  stubResearchDoc,
} from "./__fixtures__/region-harness.js";
import type { CritiqueRequest, ExploreRequest, ReflectRequest } from "./effects.js";
import { isNodeRefusal } from "./gates.js";
import type { NodeRefusal } from "./gates.js";
import { RESEARCH_REGION } from "./regions.js";
import { RESEARCH_DIGEST_REF_KEY, RESEARCH_NODE_IDS } from "./research.js";

/**
 * The research region, compiled out of the COMMITTED artifact and executed end to end.
 *
 * What each test here exists to catch:
 *
 *  - a reflexion loop that "works" because the router always says `retry` and the
 *    interpreter's bound quietly rescues it, leaving a `LoopExhausted` failure that
 *    downgrades the run's verdict for no reason a user could see (sc-11-2);
 *  - an explorer that is re-entered with an EMPTY critique — the mistake `research_route`
 *    declaring `outputPorts: []` invites, because binding `outputPort: null` and then also
 *    returning no output compiles perfectly and forwards `undefined` (sc-11-2);
 *  - a researcher whose PROSE emission is accepted because nothing ever asked it for
 *    structure (sc-11-1);
 *  - a boundary gate that cannot refuse anything, because its own `inputSchema` threw
 *    before its body could route (sc-11-4/sc-11-5's mechanism, exercised here on the
 *    research entry gate);
 *  - a node library that silently edits a shipped agent to make itself expressible
 *    (sc-11-8).
 *
 * Every run below uses a real temp `projectRoot`, real `.bober/` writes and an injected
 * monotonic clock. The only substituted collaborators are the two agent functions at the
 * very edge, and they are substituted through the effect registry the artifact declares as
 * the sole way out — never by mocking a module the node bodies import.
 */

const exec = promisify(execFile);
const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-research-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

// ── Bindings ────────────────────────────────────────────────────────

interface Recorded {
  reflectCalls: ReflectRequest[];
  exploreCalls: ExploreRequest[];
  critiqueCalls: CritiqueRequest[];
  researchPrompts: string[];
}

function recorder(): Recorded {
  return { reflectCalls: [], exploreCalls: [], critiqueCalls: [], researchPrompts: [] };
}

/** The critique text round `n` produces, so a re-entry's critique is identifiable. */
function critiqueForRound(round: number): string {
  return `critique after round ${String(round)}`;
}

interface ResearchStubOptions {
  reflection?: unknown;
  /** `null` ends the loop early; a string asks for another round. */
  critique?: (round: number) => string | null;
}

function researchBindings(
  log: Recorded,
  options: ResearchStubOptions = {},
): Parameters<typeof runRegion>[0]["bindings"] {
  const reflection: unknown = options.reflection ?? stubReflection();
  const critique = options.critique ?? critiqueForRound;
  return {
    reflect: async (req) => {
      log.reflectCalls.push(req);
      return reflection;
    },
    critique: async (req) => {
      log.critiqueCalls.push(req);
      return { critique: critique(req.reflexionRound) };
    },
    // The `Researcher` seam: same three-parameter signature as the shipped `runResearch`,
    // so a real binding and this one are interchangeable.
    research: async (userPrompt) => {
      log.researchPrompts.push(userPrompt);
      return stubResearchDoc(log.researchPrompts.length, null);
    },
  };
}

/** The `research.explore` request each call made, recovered from the effect registry. */
function exploreRequestsFrom(log: Recorded): ExploreRequest[] {
  return log.exploreCalls;
}

// ── sc-11-7 / sc-11-6: compilation out of the committed artifact ────

describe("RESEARCH REGION: compiles from the committed artifact (sc-11-7)", () => {
  it("compiles the region the artifact declares, and nothing it does not", () => {
    const compiled = compileRegion(RESEARCH_REGION, researchBindings(recorder()));

    const expected = [
      ...CODING_GRAPH.nodes.filter((node) => node.subgraph === RESEARCH_REGION).map((n) => n.id),
      "research_body",
      CODING_GRAPH.defaults.supervisorNodeId,
      "graceful_failure",
    ].sort();
    expect([...compiled.graph.nodes.keys()].sort()).toEqual(expected);

    // Every node declaration is the artifact's own. `regionSpec` re-parses its projection
    // through `TopologySpecSchema` (so a projection the artifact schema would reject is a
    // defect in the projector, not a mystery at compile time), which makes these structural
    // equals rather than the same references — but nothing about a node was authored here.
    for (const [id, node] of compiled.graph.nodes) {
      expect(node.spec).toStrictEqual(CODING_GRAPH.nodes.find((entry) => entry.id === id));
    }
  });

  it("carries the artifact's own `research` subgraph declaration into the compiled graph", () => {
    const compiled = compileRegion(RESEARCH_REGION, researchBindings(recorder()));
    const region = compiled.graph.subgraphs.get(RESEARCH_REGION);
    if (!region) throw new Error("the artifact declares a research subgraph");

    const interior = CODING_GRAPH.nodes
      .filter((node) => node.subgraph === RESEARCH_REGION)
      .map((node) => node.id)
      .sort();
    expect([...region.nodes.keys()].sort()).toEqual(interior);
  });
});

// ── sc-11-7: end to end against stub providers ──────────────────────

describe("RESEARCH REGION: runs end to end against stub providers (sc-11-7)", () => {
  it("produces the research document the existing pipeline produces for this phase", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { critique: () => null }),
    });

    expect(run.result.status).toBe("completed");
    expect(run.result.failures).toEqual([]);

    // The REAL document, written by the shipped `saveResearch` through the fs-write effect.
    const doc = stubResearchDoc(1, null);
    const path = join(root, ".bober", "research", `${doc.id}.md`);
    await expect(stat(path)).resolves.toBeTruthy();
    const markdown = await readFile(path, "utf8");
    expect(markdown).toContain(doc.id);

    // The digest is where a later phase looks for it, and the bytes are on disk.
    const ref = run.finalState.refs[RESEARCH_DIGEST_REF_KEY];
    expect(ref).toBeDefined();
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.exitGate]).toBe(1);
    expect(run.handlerLog.calls.graceful_failure).toBeUndefined();
  });

  it("charges the ledger channel once per model call the region made", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { critique: () => null }),
    });
    // reflect + explore + critique, one call each on a single-round run.
    expect(run.finalState.ledger.map((entry) => entry.nodeId).sort()).toEqual([
      RESEARCH_NODE_IDS.critique,
      RESEARCH_NODE_IDS.explore,
      RESEARCH_NODE_IDS.reflect,
    ]);
  });
});

// ── sc-11-2: the bounded reflexion loop ─────────────────────────────

describe("RESEARCH REFLEXION: bounded, critique-carrying, and it exits to collect (sc-11-2)", () => {
  it("re-enters the explorer exactly maxReflexions times and then collects", async () => {
    const declared = CODING_GRAPH.nodes.find((node) => node.id === RESEARCH_NODE_IDS.route);
    const bound = declared?.loop?.maxIterations;
    expect(bound).toBe(3);

    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      // A critic that NEVER accepts: only the declared bound can stop this loop.
      bindings: researchBindings(log, { critique: critiqueForRound }),
    });

    expect(run.result.status).toBe("completed");
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.explore]).toBe(bound);
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.route]).toBe(bound);
    expect(run.finalState.counters.researchReflexions).toBe(bound);
  });

  it("hands each re-entry the PRIOR round's critique in its declared input", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { critique: critiqueForRound }),
    });

    // The explorer's DECLARED input port is `digest: ResearchDigest`, so this is the value
    // the artifact says it receives — not a side channel a test arranged.
    const seen = (run.inputLog.inputs[RESEARCH_NODE_IDS.explore] ?? []) as ResearchDigest[];
    expect(seen.map((digest) => digest.critique)).toEqual([
      null,
      critiqueForRound(1),
      critiqueForRound(2),
    ]);
    expect(seen.map((digest) => digest.reflexionRound)).toEqual([0, 1, 2]);

    // And the critique reached the agent call itself, folded into the prompt because
    // `runResearch` has no parameter for it.
    expect(log.researchPrompts[1]).toContain(critiqueForRound(1));
    expect(log.researchPrompts[2]).toContain(critiqueForRound(2));
    expect(log.researchPrompts[0]).not.toContain("Prior critique");
  });

  it("routes to the collect-findings node rather than the failure terminal, with no loop-exhausted failure", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { critique: critiqueForRound }),
    });

    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.collect]).toBe(1);
    expect(run.handlerLog.calls.graceful_failure).toBeUndefined();
    // The interpreter records a `LoopExhausted` failure whenever IT has to redirect a
    // router that was still heading round the cycle. A router that leaves on its own
    // produces none, and the run's verdict is not downgraded by the bound.
    expect(
      run.result.failures.filter((failure) => failure.errorClass === LOOP_EXHAUSTED_ERROR_CLASS),
    ).toEqual([]);
    expect(run.spans.filter((span) => span.errorClass === LOOP_EXHAUSTED_ERROR_CLASS)).toEqual([]);
  });

  it("leaves the loop EARLY when the critic accepts, so the bound is not the only exit", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { critique: () => null }),
    });

    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.explore]).toBe(1);
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.route]).toBe(1);
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.collect]).toBe(1);
  });
});

// ── sc-11-1: the problem reflection is structured, or refused ───────

describe("PROBLEM REFLECTION: a prose-only emission is refused with the failing Zod path (sc-11-1)", () => {
  it("refuses a prose-only reflection and names the missing goal in the diagnostic", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { reflection: PROSE_ONLY_REFLECTION }),
    });

    expect(run.result.status).toBe("completed");

    // The refusal travelled the port to the supervisor and on to the terminal.
    const refusalInput = (run.inputLog.inputs.supervisor ?? [])[0];
    expect(isNodeRefusal(refusalInput)).toBe(true);
    const refusal = refusalInput as NodeRefusal;
    expect(refusal.nodeId).toBe(RESEARCH_NODE_IDS.reflect);
    expect(refusal.issues.map((issue) => issue.path).sort()).toEqual([
      "constraints",
      "goal",
      "inputs",
      "outputs",
      "rules",
    ]);

    // The explorer was never entered: a reflection that failed structure never explored.
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.explore]).toBeUndefined();
    expect(run.handlerLog.calls.graceful_failure).toBe(1);

    const artifact = await readFailureArtifact(root, run.runId);
    expect(artifact?.reason).toContain("problem-reflection-structured");
  });

  it("accepts a well-formed reflection and carries it into the digest unchanged", async () => {
    const log = recorder();
    const reflection: ProblemReflection = stubReflection("prove the reflection travels");
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      bindings: researchBindings(log, { reflection, critique: () => null }),
    });

    const seen = (run.inputLog.inputs[RESEARCH_NODE_IDS.explore] ?? []) as ResearchDigest[];
    expect(seen[0].reflection).toEqual(reflection);
    expect(exploreRequestsFrom(log)).toEqual([]);
  });
});

// ── Fail-closed research boundary gate ──────────────────────────────

describe("RESEARCH ENTRY GATE: fails closed and leaves the subgraph through its parent", () => {
  it("refuses an empty feature request without ever entering the downstream node", async () => {
    const log = recorder();
    const run = await runRegion({
      projectRoot: root,
      region: RESEARCH_REGION,
      featureRequest: "",
      bindings: researchBindings(log),
    });

    expect(run.result.status).toBe("completed");
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.entryGate]).toBe(1);
    // The node the artifact's `e-research-reflect` edge names was never dispatched.
    expect(run.handlerLog.calls[RESEARCH_NODE_IDS.reflect]).toBeUndefined();

    const refusal = (run.inputLog.inputs.supervisor ?? [])[0] as NodeRefusal;
    expect(isNodeRefusal(refusal)).toBe(true);
    expect(refusal.nodeId).toBe(RESEARCH_NODE_IDS.entryGate);
    expect(refusal.check).toBe("feature-request-present");
    expect(refusal.onFail).toBe("graceful_failure");
    expect(refusal.issues.map((issue) => issue.path)).toEqual(["featureRequest"]);
    expect(log.reflectCalls).toEqual([]);
  });
});

// ── sc-11-8: the shipped agents are untouched ───────────────────────

describe("AGENT ADAPTERS: the shipped agent functions appear in no diff (sc-11-8)", () => {
  const AGENT_FILES = [
    "src/orchestrator/research-agent.ts",
    "src/orchestrator/planner-agent.ts",
  ];

  it("reports no working-tree change to research-agent.ts or planner-agent.ts", async () => {
    const { stdout } = await exec("git", ["status", "--porcelain", "--", ...AGENT_FILES], {
      cwd: REPO_ROOT,
    });
    expect(stdout.trim()).toBe("");
  });

  it("binds the shipped functions themselves, by reference identity", async () => {
    const effects = await import("./effects.js");
    const research = await import("../../orchestrator/research-agent.js");
    const planner = await import("../../orchestrator/planner-agent.js");
    expect(effects.DEFAULT_RESEARCHER).toBe(research.runResearch);
    expect(effects.DEFAULT_PLANNER).toBe(planner.runPlanner);
  });

  // ── The same guarantee for sprint 12's five agents (sprint-12 nonGoal 2) ──
  //
  // Sprint 12 forbids modifying `runCurator`, `runGenerator`, `runEvaluatorAgent`,
  // `runCodeReviewer` and `runDocumenter`, but shipped no check of its own. The identity
  // assertion is the durable half of the pair: the `git status` check above only sees an
  // UNCOMMITTED edit, so once a change lands it stops being evidence, whereas an adapter
  // that starts wrapping or re-implementing an agent breaks reference identity for good.

  const SPRINT_12_AGENT_FILES = [
    "src/orchestrator/curator-agent.ts",
    "src/orchestrator/generator-agent.ts",
    "src/orchestrator/evaluator-agent.ts",
    "src/orchestrator/code-reviewer-agent.ts",
    "src/orchestrator/documenter-agent.ts",
  ];

  it("reports no working-tree change to any of sprint 12's five agent files", async () => {
    const { stdout } = await exec(
      "git",
      ["status", "--porcelain", "--", ...SPRINT_12_AGENT_FILES],
      { cwd: REPO_ROOT },
    );
    expect(stdout.trim()).toBe("");
  });

  it("binds sprint 12's five shipped agents by reference identity too", async () => {
    const effects = await import("./effects.js");
    const curator = await import("../../orchestrator/curator-agent.js");
    const generator = await import("../../orchestrator/generator-agent.js");
    const evaluator = await import("../../orchestrator/evaluator-agent.js");
    const reviewer = await import("../../orchestrator/code-reviewer-agent.js");
    const documenter = await import("../../orchestrator/documenter-agent.js");
    expect(effects.DEFAULT_CURATOR).toBe(curator.runCurator);
    expect(effects.DEFAULT_GENERATOR).toBe(generator.runGenerator);
    expect(effects.DEFAULT_EVALUATOR).toBe(evaluator.runEvaluatorAgent);
    expect(effects.DEFAULT_CODE_REVIEWER).toBe(reviewer.runCodeReviewer);
    expect(effects.DEFAULT_DOCUMENTER).toBe(documenter.runDocumenter);
  });
});
