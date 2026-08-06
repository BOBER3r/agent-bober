import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createDefaultConfig } from "../config/schema.js";
import { CHECKPOINT_IDS, isCheckpointId } from "../orchestrator/checkpoints/types.js";

import { computeEffectGates } from "./runtime/interpreter.js";
import {
  assertKnownCheckpointId,
  createInterruptController,
  GATED_EFFECTS,
  gatedEffectsOf,
} from "./runtime/interrupt.js";
import { AUTHORED_GRAPHS } from "./topology/coding.graph.js";

import type { TopologySpec } from "../contracts/topology.js";

/**
 * Cross-layer invariants the TOPOLOGY LAYER cannot check about itself.
 *
 * ADR-2's ESLint boundary forbids `src/pge/topology/**` from importing the orchestrator,
 * so `CHECKPOINT_IDS` is invisible to the shipped validator BY DESIGN — a topology may
 * therefore spell a checkpoint id no `bober approve` can answer and every structural rule
 * still passes. That is not a hole in the validator; it is the price of the boundary. The
 * repo's answer to a rule no type and no in-layer validator can express is a test that
 * reads across layers (`src/orchestrator/repo-invariants.test.ts` is the precedent), and
 * this is that test for the PGE artifact.
 *
 * It lives at `src/pge/` rather than `src/pge/topology/` for a mechanical reason:
 * `eslint.config.js` guards `src/pge/topology/**\/*.ts` with no `.test.ts` exemption, so a
 * detector placed inside the guarded subtree could not import `CHECKPOINT_IDS` or the
 * interpreter at all. `zero-execution.test.ts` and `eslint-boundary.test.ts` sit here for
 * exactly the same reason.
 *
 * ── Why this cannot be defeated by the next artifact edit ──
 *
 * The file spells no checkpoint id and no node name. It enumerates from `AUTHORED_GRAPHS`
 * on one side and from `CHECKPOINT_IDS` / `GATED_EFFECTS` on the other. A new HITL node, a
 * whole new authored graph, a renamed id, or an id dropped from the enum all flow through
 * automatically. There is no allowlist to append an exception to and no fixture to swap.
 * The only ways to make an illegal id pass are to delete this file or to deliberately
 * widen `CHECKPOINT_IDS` — and forcing that second choice into the open, as a reviewed
 * change to the shipped vocabulary, is the point.
 *
 * ── Why it binds AUTHORED_GRAPHS and never the validator fixtures ──
 *
 * `src/pge/topology/__fixtures__/*.json` are NEGATIVE fixtures: 31 of the 33 deliberately
 * carry an ungated `process-exec` node, and several deliberately carry an unknown
 * checkpoint id, because that is what the diagnostic under test is supposed to reject.
 * Walking them would assert the opposite of their purpose. `AUTHORED_GRAPHS` is exactly
 * what `bober pge dump` serialises, and `pge dump --check` already pins
 * `.bober/topology/coding.json` byte-identical to it, so binding the authored source binds
 * the committed artifact too.
 */

const GRAPHS: readonly (readonly [string, TopologySpec])[] = Object.entries(AUTHORED_GRAPHS);

/** Every node in every authored graph that declares a HITL policy. */
function hitlNodes(): { graphId: string; nodeId: string; checkpointId: string }[] {
  const found: { graphId: string; nodeId: string; checkpointId: string }[] = [];
  for (const [graphId, spec] of GRAPHS) {
    for (const node of spec.nodes) {
      if (node.hitl === undefined) continue;
      found.push({ graphId, nodeId: node.id, checkpointId: node.hitl.checkpointId });
    }
  }
  return found;
}

describe("authored topology invariants", () => {
  it("has at least one authored graph with at least one HITL node to check", () => {
    // Guards against the whole file becoming vacuous if AUTHORED_GRAPHS is ever emptied or
    // the `hitl` field renamed: an assertion loop over nothing passes silently.
    expect(GRAPHS.length).toBeGreaterThan(0);
    expect(hitlNodes().length).toBeGreaterThan(0);
  });

  // ── Group A — every checkpoint id the artifact names must be answerable ──

  it("A1: every hitl.checkpointId is one of the shipped CHECKPOINT_IDS", () => {
    const offenders = hitlNodes()
      .filter((entry) => !isCheckpointId(entry.checkpointId))
      .map((entry) => `${entry.graphId}/${entry.nodeId} -> ${entry.checkpointId}`);

    expect(
      offenders,
      `Topology nodes name a checkpoint id the shipped subsystem cannot answer:\n  ${offenders.join(
        "\n  ",
      )}\nLegal ids are: ${CHECKPOINT_IDS.join(", ")}`,
    ).toEqual([]);
  });

  it("A2: every hitl.checkpointId survives the shipped assertKnownCheckpointId guard", () => {
    // A1 re-implements the membership check and could drift from the guard the runtime
    // actually calls. A2 goes through that guard, so it fails if and only if a real run
    // would die at `interrupt.ts` the moment the node is evaluated.
    for (const entry of hitlNodes()) {
      expect(
        () => assertKnownCheckpointId(entry.nodeId, entry.checkpointId),
        `${entry.graphId}/${entry.nodeId}`,
      ).not.toThrow();
    }
  });

  it("A3: every checkpoint id derived onto a gated node is legal", () => {
    // The SECOND `assertKnownCheckpointId` call site. A gate's id is read off the UPSTREAM
    // node by `computeEffectGates`, by different code on a different path, so A1/A2 never
    // reach it. This is the assertion that directly protects the `git` effect on `commit`.
    const offenders: string[] = [];
    for (const [graphId, spec] of GRAPHS) {
      for (const [nodeId, gate] of computeEffectGates(spec)) {
        if (!isCheckpointId(gate.checkpointId)) {
          offenders.push(`${graphId}/${nodeId} <- ${gate.gateNodeId} -> ${gate.checkpointId}`);
        }
      }
    }
    expect(
      offenders,
      `Effect gates derive a checkpoint id the shipped subsystem cannot answer:\n  ${offenders.join(
        "\n  ",
      )}\nLegal ids are: ${CHECKPOINT_IDS.join(", ")}`,
    ).toEqual([]);
  });

  it("A4: no two HITL nodes in a graph share a checkpointId", () => {
    // Behavioural, not tidiness. `resumeMessageId` is `hitl:<checkpointId>` with no node
    // id, and `applyResume` rebuilds `messages` by replacing the row with that id — so a
    // second gate's resume EVICTS the first gate's recorded human decision from state.
    // `.bober/approvals/<checkpointId>.*.json` is keyed by id alone and the audit line
    // records no nodeId, so the collision is invisible afterwards too.
    for (const [graphId, spec] of GRAPHS) {
      const byCheckpoint = new Map<string, string[]>();
      for (const node of spec.nodes) {
        if (node.hitl === undefined) continue;
        const owners = byCheckpoint.get(node.hitl.checkpointId) ?? [];
        owners.push(node.id);
        byCheckpoint.set(node.hitl.checkpointId, owners);
      }
      const clashes = [...byCheckpoint.entries()]
        .filter(([, owners]) => owners.length > 1)
        .map(([checkpointId, owners]) => `${checkpointId}: ${owners.join(", ")}`);
      expect(clashes, `${graphId} reuses a checkpoint id across gate nodes`).toEqual([]);
    }
  });

  // ── Group B — every gated effect must actually be reachable through its gate ──

  it("B1: every node declaring a gated effect has a HITL gate on an inbound edge", () => {
    // The assertion that would have caught the ungated-`process-exec` defect on the day it
    // landed, with no new validator rule at all. It also pins the two derivations — what
    // the validator considers gated and what the interpreter derives at runtime — against
    // the drift that produced that defect in the first place.
    const offenders: string[] = [];
    for (const [graphId, spec] of GRAPHS) {
      const gates = computeEffectGates(spec);
      for (const node of spec.nodes) {
        const gated = gatedEffectsOf(node);
        if (gated.length === 0) continue;
        if (gates.get(node.id) === undefined) {
          offenders.push(`${graphId}/${node.id} declares ${gated.join(", ")} with no gate`);
        }
      }
    }
    expect(
      offenders,
      `Nodes declare a gated effect that no HITL node has a declared edge into:\n  ${offenders.join(
        "\n  ",
      )}`,
    ).toEqual([]);
  });

  describe("B2: a real evaluation of every node resolves, and git still fails closed", () => {
    let root = "";

    beforeAll(async () => {
      root = await mkdtemp(join(tmpdir(), "pge-topology-invariants-"));
    });

    afterAll(async () => {
      await rm(root, { recursive: true, force: true });
    });

    it("no non-HITL node throws UngatedEffectError under the shipped controller", async () => {
      // B1 asserts the derivation; this asserts the CONSEQUENCE, through the real
      // controller with the default (autopilot → noop) resolution. If any gated node is
      // still ungated, `maybeInterrupt` throws and `interpreter.run` dies before a single
      // node body executes — which is exactly the failure mode this file exists to stop.
      for (const [graphId, spec] of GRAPHS) {
        const controller = createInterruptController();
        const gates = computeEffectGates(spec);
        for (const node of spec.nodes) {
          if (node.hitl !== undefined) continue;
          await expect(
            controller.maybeInterrupt(
              node,
              {},
              {
                runId: "topology-invariants",
                projectRoot: root,
                config: createDefaultConfig("topology-invariants", "brownfield"),
                superstep: 0,
              },
              gates.get(node.id) ?? null,
            ),
            `${graphId}/${node.id}`,
          ).resolves.toBeDefined();
        }
      }
    });

    it("a git-effect node is still refused without a recorded approval", async () => {
      // The other half: proving the sprint region can run must not quietly prove that the
      // commit path can too. Under autopilot the gate records no grant, so every node
      // carrying a `git` effect is blocked with FAIL_CLOSED and its body never entered.
      let checked = 0;
      for (const [graphId, spec] of GRAPHS) {
        const controller = createInterruptController();
        const gates = computeEffectGates(spec);
        for (const node of spec.nodes) {
          if (node.hitl !== undefined) continue;
          if (!node.effects.includes("git")) continue;
          checked += 1;
          const outcome = await controller.maybeInterrupt(
            node,
            {},
            {
              runId: "topology-invariants",
              projectRoot: root,
              config: createDefaultConfig("topology-invariants", "brownfield"),
              superstep: 0,
            },
            gates.get(node.id) ?? null,
          );
          expect(outcome, `${graphId}/${node.id}`).toMatchObject({ approved: false });
          expect("feedback" in outcome ? outcome.feedback : "").toMatch(/^FAIL_CLOSED:/);
        }
      }
      // A loop that checked nothing would pass vacuously.
      expect(checked).toBeGreaterThan(0);
    });
  });

  it("B3: GATED_EFFECTS still names git and the deploy path, and nothing more", () => {
    // A one-line regression guard against the other, wrong way to make B1 green: dropping
    // an effect out of GATED_EFFECTS instead of gating the node that declares it.
    expect([...GATED_EFFECTS].sort()).toEqual(["git", "process-exec"]);
    expect(GATED_EFFECTS).not.toContain("sandbox-exec");
  });
});
