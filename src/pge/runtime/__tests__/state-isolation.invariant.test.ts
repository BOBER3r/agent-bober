import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { OverallState } from "../../state/overall.js";
import type { NodeContext } from "../../registry/nodes.js";
import { GOLDEN_NODES, goldenContractId, goldenContracts } from "../__fixtures__/golden-graph.js";
import { runGolden } from "../__fixtures__/run-harness.js";

/**
 * BLOCKING INVARIANT SUITE 5 — STATE ISOLATION.
 *
 * The three-scope split is only real if the runtime enforces it. Three claims:
 *
 *  1. A node cannot MUTATE the state it is shown. The snapshot is deeply frozen, so a
 *     mutation throws inside the node instead of quietly corrupting the batch every
 *     sibling in that superstep is reading.
 *  2. A node cannot OBSERVE another branch through a shared reference. Each task gets its
 *     own clone; two branches in the same superstep never hold the same array.
 *  3. `NodeContext.priv` is node-local and dies at the handler's return. Its keys appear in
 *     the trace — so the split is auditable rather than merely asserted — and appear
 *     NOWHERE in committed state.
 *
 * ── Mutation-proven ──
 *
 * This suite was run against two deliberate breakages and failed on each:
 *  - `isolatedSnapshot` returning `state` itself instead of a frozen clone (the mutation
 *    test stopped throwing and the sibling-sharing test found the same object);
 *  - the interpreter reusing one `priv` Map across the tasks of a superstep instead of
 *    creating one per task.
 */

/** The private key the golden generator stashes, spelled once. */
const PRIVATE_KEYS = ["goldenPrivateDraft", "goldenPrivateTokenCount"];

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-isolation-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("ISOLATION: a node cannot mutate the state it is shown", () => {
  it("throws inside the node when it tries, and commits nothing", async () => {
    const attempts: string[] = [];
    const run = await runGolden({
      projectRoot: root,
      concurrency: 4,
      behaviour: {
        contracts: goldenContracts(3),
        handlerOverrides: {
          [GOLDEN_NODES.generate]: async (input, state, ctx) => {
            attempts.push(ctx.branchKey ?? "-");
            // A frozen array in a strict-mode module: this is a TypeError, not a silent
            // no-op, so the node learns immediately and its siblings are untouched.
            (state as unknown as { messages: unknown[] }).messages.push({ id: "smuggled" });
            return { update: {}, goto: { kind: "node", node: GOLDEN_NODES.evaluate }, output: input };
          },
        },
      },
    });

    expect(attempts).toHaveLength(3);
    expect(run.result.failures.map((f) => f.errorClass)).toEqual(["TypeError", "TypeError", "TypeError"]);
    expect(run.finalState.messages.some((m) => m.id === "smuggled")).toBe(false);
  });

  it("freezes the whole graph of the snapshot, not just its top level", async () => {
    const frozen: boolean[] = [];
    await runGolden({
      projectRoot: root,
      behaviour: {
        contracts: goldenContracts(1),
        handlerOverrides: {
          [GOLDEN_NODES.generate]: async (input, state) => {
            frozen.push(
              Object.isFrozen(state),
              Object.isFrozen(state.sprintContracts),
              Object.isFrozen(state.sprintContracts[0]),
              Object.isFrozen(state.sprintContracts[0].successCriteria[0]),
              Object.isFrozen(state.counters),
            );
            return { update: {}, goto: { kind: "node", node: GOLDEN_NODES.evaluate }, output: input };
          },
        },
      },
    });
    expect(frozen).toEqual([true, true, true, true, true]);
  });
});

describe("ISOLATION: branches share no mutable reference (sc-7-10)", () => {
  it("hands every concurrent task its own clone of state and its own priv map", async () => {
    const seen: Array<{ branch: string; state: OverallState; priv: NodeContext["priv"] }> = [];
    const run = await runGolden({
      projectRoot: root,
      concurrency: 4,
      behaviour: {
        contracts: goldenContracts(4),
        handlerOverrides: {
          [GOLDEN_NODES.generate]: async (input, state, ctx) => {
            ctx.priv.set(`only-in-${ctx.branchKey ?? "-"}`, true);
            seen.push({ branch: ctx.branchKey ?? "-", state: state as OverallState, priv: ctx.priv });
            return { update: {}, goto: { kind: "node", node: GOLDEN_NODES.evaluate }, output: input };
          },
        },
      },
    });

    expect(run.result.status).toBe("completed");
    expect(seen).toHaveLength(4);

    // Four distinct state objects, four distinct nested arrays, four distinct priv maps.
    expect(new Set(seen.map((s) => s.state)).size).toBe(4);
    expect(new Set(seen.map((s) => s.state.sprintContracts)).size).toBe(4);
    expect(new Set(seen.map((s) => s.priv)).size).toBe(4);

    // And no branch's private key is visible in any other branch's private map.
    for (const mine of seen) {
      for (const theirs of seen) {
        const key = `only-in-${theirs.branch}`;
        expect(mine.priv.has(key)).toBe(mine.branch === theirs.branch);
      }
    }
  });
});

describe("ISOLATION: private keys exist during execution and never after (sc-7-10)", () => {
  it("records the private keys on the span and finds none of them in merged state", async () => {
    const run = await runGolden({
      projectRoot: root,
      concurrency: 3,
      finalize: true,
      behaviour: { contracts: goldenContracts(3) },
    });

    // THE TRACE SHOWS THEY EXISTED during that node's execution...
    const generatorSpans = run.spans.filter((s) => s.nodeId === GOLDEN_NODES.generate);
    expect(generatorSpans).toHaveLength(3);
    for (const span of generatorSpans) {
      expect(span.privKeys).toEqual([...PRIVATE_KEYS].sort());
    }

    // ...and NONE of them appears anywhere in the committed state, at any depth.
    const committed = JSON.stringify(run.finalState);
    for (const key of PRIVATE_KEYS) {
      expect(committed.includes(key), `private key ${key} leaked into state`).toBe(false);
    }
    // Nor into any `.bober/` artifact the boundary wrote.
    const { readArtifactTree } = await import("../__fixtures__/artifact-tree.js");
    const tree = await readArtifactTree(root, { exclude: [] });
    for (const [path, bytes] of tree) {
      for (const key of PRIVATE_KEYS) {
        // The TRACE is the one place a private key is allowed — that is the audit record.
        if (path.startsWith(".bober/traces/")) continue;
        expect(bytes.includes(key), `private key ${key} leaked into ${path}`).toBe(false);
      }
    }
    expect([...tree.keys()].some((p) => p.startsWith(".bober/traces/"))).toBe(true);
  });

  it("gives a node a FRESH priv map on every execution, including a loop re-entry", async () => {
    const perExecution: Array<string[]> = [];
    const run = await runGolden({
      projectRoot: root,
      behaviour: {
        contracts: goldenContracts(1),
        reworkBranches: [goldenContractId(1)],
        handlerOverrides: {
          [GOLDEN_NODES.generate]: async (input, state, ctx) => {
            perExecution.push([...ctx.priv.keys()]);
            ctx.priv.set("carried", perExecution.length);
            return {
              update: { counters: { [`attempts.${ctx.branchKey ?? "-"}`]: perExecution.length } },
              goto: { kind: "node", node: GOLDEN_NODES.evaluate },
              output: input,
            };
          },
        },
      },
    });

    expect(run.result.status).toBe("completed");
    expect(perExecution).toHaveLength(2);
    // The second execution started with an EMPTY map: nothing carried across the loop.
    expect(perExecution).toEqual([[], []]);
  });
});
