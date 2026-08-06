// ── whole-graph.test.ts ─────────────────────────────────────────────
//
// ONE PgeEngine run of the COMMITTED artifact, and the three claims that can only be made
// about such a run:
//
//   sc-13-7  the run manifest's per-node sums equal the run totals, and a configured
//            ceiling ABORTS the run with a typed BudgetExceededError;
//   sc-13-8  zero frontier-tier model calls are attributable to routing, classification or
//            syntax nodes, with span -> node kind read FROM THE ARTIFACT;
//   sc-13-10 a substituted project root receives every write and the original receives none.
//
// Nothing is adapted. The engine is `new PgeEngine(...)` as `selectPipelineEngine` returns
// it, the graph is `.bober/topology/coding.json` copied into a temp root, and the only
// substitution is the collaborator set at the effect seam the artifact already declares.

import { mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { NodeKind } from "../../contracts/topology.js";
import { completionMarkerPath } from "../../orchestrator/finalize.js";
import { BudgetExceededError } from "../runtime/ledger.js";
import type { NodeUsage } from "../runtime/ledger.js";
import { readSpans, tracePath } from "../runtime/trace.js";
import type { Span } from "../runtime/trace.js";
import { PgeEngine } from "./pge-engine.js";
import {
  CODING_GRAPH_ID,
  artifactNodeKinds,
  conformanceConfig,
  seedCommittedArtifact,
  wholeGraphBindings,
} from "./__fixtures__/whole-graph.js";

let tmpRoots: string[] = [];

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});

async function seededRoot(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-pge-whole-"));
  tmpRoots.push(dir);
  await seedCommittedArtifact(dir);
  return dir;
}

// ── sc-13-8 ─────────────────────────────────────────────────────────

describe("a pge run's model tiers (sc-13-8)", () => {
  it("charges NO frontier-tier model to any routing, classification or syntax node", async () => {
    const projectRoot = await seededRoot();
    await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) => wholeGraphBindings(input),
    }).run("Wire the graph engine.", projectRoot, conformanceConfig(), { runId: "run-tiers" });

    const spans: Span[] = await readSpans(tracePath(projectRoot, "run-tiers"));
    expect(spans.length).toBeGreaterThan(20);

    // THE NODE KINDS COME FROM THE COMMITTED ARTIFACT, never from a list written here. A
    // hardcoded list would make this assertion a statement about the test.
    const kinds: Map<string, NodeKind> = await artifactNodeKinds();
    expect(kinds.size).toBe(44);

    // Every span belongs to a node the artifact declares — otherwise "map the span to its
    // kind" would silently skip the very span that broke the rule.
    for (const span of spans) {
      expect(kinds.has(span.nodeId), `span for undeclared node "${span.nodeId}"`).toBe(true);
    }

    // "Routing, classification or syntax": a router routes, a gate classifies — and
    // `gate_syntax`, the syntax check itself, IS a gate.
    const cheapKinds = new Set<NodeKind>(["router", "gate"]);
    const offenders = spans
      .filter((span) => cheapKinds.has(kinds.get(span.nodeId) as NodeKind))
      .filter((span) => span.model?.tier === "frontier")
      .map((span) => span.nodeId);
    expect(offenders).toEqual([]);

    // The syntax gate specifically, named from the artifact's own declaration rather than
    // inferred: it ran, and it ran on no model at all.
    const syntaxSpans = spans.filter((span) => span.nodeId === "gate_syntax");
    expect(syntaxSpans.length).toBeGreaterThan(0);
    expect(syntaxSpans.every((span) => span.model === undefined)).toBe(true);

    // The negative control: the assertion above must not be passing because NOTHING carries
    // a tier. Frontier spans exist, and every one of them belongs to an `llm` node.
    const frontier = spans.filter((span) => span.model?.tier === "frontier");
    expect(frontier.length).toBeGreaterThan(0);
    expect([...new Set(frontier.map((span) => kinds.get(span.nodeId)))]).toEqual(["llm"]);

    // And the routers really did run — an empty router set would satisfy `offenders` too.
    const routerSpans = spans.filter((span) => kinds.get(span.nodeId) === "router");
    expect(routerSpans.length).toBeGreaterThan(0);
    expect([...new Set(routerSpans.map((span) => span.model?.tier))]).toEqual(["light"]);

    // A gate declares no tier at all in the artifact, so its span carries no model.
    const gateSpans = spans.filter((span) => kinds.get(span.nodeId) === "gate");
    expect(gateSpans.length).toBeGreaterThan(0);
    expect(gateSpans.every((span) => span.model === undefined)).toBe(true);
  });
});

// ── sc-13-7 ─────────────────────────────────────────────────────────

const ZERO: NodeUsage = { calls: 0, tokensIn: 0, tokensOut: 0, costUsd: 0 };

describe("cost accounting (sc-13-7)", () => {
  it("per-node sums equal the run totals for calls, tokens and USD", async () => {
    const projectRoot = await seededRoot();
    const perNode: Array<Record<string, NodeUsage>> = [];
    const totals: NodeUsage[] = [];

    await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) =>
        wholeGraphBindings(input, {
          // Charged from inside a real node's collaborator, through the ledger the run
          // built — so the numbers reconciled below are numbers the run actually booked.
          charge: { calls: 1, tokensIn: 1000, tokensOut: 400, costUsd: 0.25 },
          ledgerProbe: (ledger) => {
            perNode.push(ledger.perNode());
            totals.push(ledger.totals());
          },
        }),
    }).run("Wire the graph engine.", projectRoot, conformanceConfig(), { runId: "run-ledger" });

    expect(perNode.length).toBeGreaterThan(0);
    const lastPerNode = perNode[perNode.length - 1];
    const lastTotals = totals[totals.length - 1];

    const summed = Object.values(lastPerNode).reduce(
      (into, usage) => ({
        calls: into.calls + usage.calls,
        tokensIn: into.tokensIn + usage.tokensIn,
        tokensOut: into.tokensOut + usage.tokensOut,
        costUsd: into.costUsd + usage.costUsd,
      }),
      { ...ZERO },
    );

    expect(summed.calls).toBe(lastTotals.calls);
    expect(summed.tokensIn).toBe(lastTotals.tokensIn);
    expect(summed.tokensOut).toBe(lastTotals.tokensOut);
    expect(summed.costUsd).toBeCloseTo(lastTotals.costUsd, 10);

    // Non-vacuity: something was actually spent, by more than one node.
    expect(lastTotals.costUsd).toBeGreaterThan(0);
    expect(lastTotals.tokensIn).toBeGreaterThan(0);
    expect(Object.keys(lastPerNode).length).toBeGreaterThan(1);
  });

  it("ABORTS with a typed BudgetExceededError when the configured ceiling is passed", async () => {
    const projectRoot = await seededRoot();
    const config = conformanceConfig();
    const capped = { ...config, pipeline: { ...config.pipeline, budget: { maxUsd: 0.5 } } };

    const promise = new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) =>
        wholeGraphBindings(input, {
          charge: { calls: 1, tokensIn: 10, tokensOut: 10, costUsd: 4 },
        }),
    }).run("Wire the graph engine.", projectRoot, capped, { runId: "run-ceiling" });

    // The CLASS, across the seam — not a message, not a `success: false` result.
    await expect(promise).rejects.toBeInstanceOf(BudgetExceededError);
    await promise.catch((error: unknown) => {
      expect(error).toBeInstanceOf(BudgetExceededError);
      expect((error as BudgetExceededError).kind).toBe("usd");
      expect((error as Error).message).toContain("0.500000");
    });

    // The run did NOT continue: it never reached its terminal, so no completion marker
    // claims that it did.
    await expect(stat(completionMarkerPath(projectRoot, "run-ceiling"))).rejects.toThrow();
  });

  it("runs UNCAPPED when no ceiling is configured, spending past what would have tripped one", async () => {
    // The negative control for the test above: the same spend, no `pipeline.budget`, and the
    // run reaches its terminal. Without it, the abort could be an artefact of the spend.
    const projectRoot = await seededRoot();
    const result = await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) =>
        wholeGraphBindings(input, {
          charge: { calls: 1, tokensIn: 10, tokensOut: 10, costUsd: 4 },
        }),
    }).run("Wire the graph engine.", projectRoot, conformanceConfig(), { runId: "run-uncapped" });

    expect(result.success).toBe(true);
    await expect(stat(completionMarkerPath(projectRoot, "run-uncapped"))).resolves.toBeDefined();
  });
});

// ── sc-13-10 ────────────────────────────────────────────────────────

describe("project-root substitution (sc-13-10)", () => {
  it("writes EVERYTHING under the substituted root and NOTHING under the original", async () => {
    // The "original" root is a fully-seeded project: if any store held a module-level
    // instance bound at import time, or any node reached for a default root, this is where
    // the writes would land.
    const original = await seededRoot();
    const before = await snapshot(original);

    const substituted = await seededRoot();
    const result = await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) => wholeGraphBindings(input),
    }).run("Wire the graph engine.", substituted, conformanceConfig(), { runId: "run-worktree" });

    expect(result.success).toBe(true);

    // The substituted root received the run.
    const after = await snapshot(substituted);
    expect(after).toContain(".bober/traces/run-worktree.jsonl");
    expect(after.some((path) => path.startsWith(".bober/contracts/"))).toBe(true);
    expect(after.some((path) => path.startsWith(".bober/specs/"))).toBe(true);
    expect(after).toContain(".bober/history.jsonl");

    // The original received NOTHING — asserted as an exact set difference, so a single new
    // file anywhere under it fails, not merely a file at a path this test thought to check.
    expect(await snapshot(original)).toEqual(before);
  });

  it("runs TWO engines against two roots without either seeing the other's artifacts", async () => {
    // A module-level store would also show up as cross-talk between two runs in ONE process,
    // which a single-run test cannot see.
    const first = await seededRoot();
    const second = await seededRoot();

    await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) => wholeGraphBindings(input),
    }).run("First feature.", first, conformanceConfig(), { runId: "run-first" });
    await new PgeEngine({
      graphId: CODING_GRAPH_ID,
      bindings: (input) => wholeGraphBindings(input),
    }).run("Second feature.", second, conformanceConfig(), { runId: "run-second" });

    const firstPaths = await snapshot(first);
    const secondPaths = await snapshot(second);
    expect(firstPaths).toContain(".bober/traces/run-first.jsonl");
    expect(firstPaths).not.toContain(".bober/traces/run-second.jsonl");
    expect(secondPaths).toContain(".bober/traces/run-second.jsonl");
    expect(secondPaths).not.toContain(".bober/traces/run-first.jsonl");
  });
});

/** Every file under `root`, as project-relative POSIX paths, sorted. */
async function snapshot(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string, prefix: string): Promise<void> => {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries) {
      const rel = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
      if (entry.isDirectory()) await walk(join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  await walk(root, "");
  return out.sort();
}
