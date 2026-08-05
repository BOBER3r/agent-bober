import { readFile, readdir } from "node:fs/promises";
import { beforeAll, describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { DIAGNOSTIC_CODES, findCycles, validateTopology } from "./validate.js";
import type { DiagnosticCode, PromptRefSet, SchemaCatalog, ValidationReport } from "./validate.js";

const FIXTURE_DIR = new URL("./__fixtures__/", import.meta.url);

async function loadFixture(name: string): Promise<unknown> {
  return JSON.parse(await readFile(new URL(`${name}.json`, FIXTURE_DIR), "utf8")) as unknown;
}

/** Unique error-severity codes, so a fixture is pinned to exactly one rule. */
function errorCodes(report: ValidationReport): DiagnosticCode[] {
  return [...new Set(report.diagnostics.filter((d) => d.severity === "error").map((d) => d.code))];
}

const ALL_PROMPTS: PromptRefSet = {
  has: (ref) => ["planner/draft", "generator/sprint", "generator/tests"].includes(ref),
};

/** Resolves every schemaRef the fixtures use except the deliberately bogus one. */
const ALL_SCHEMAS: SchemaCatalog = {
  has: (ref) => ref !== "NoSuchSchema",
  isAssignable: (from, to) => from === to,
};

const FULL_MODE_FIXTURE_OPTS: Partial<Record<DiagnosticCode, Parameters<typeof validateTopology>[1]>> =
  {
    UnknownPromptRef: { mode: "full", prompts: ALL_PROMPTS },
    UnknownSchemaRef: { mode: "full", schemas: ALL_SCHEMAS, prompts: ALL_PROMPTS },
  };

/**
 * Apply a mutation to the well-formed fixture and re-seal its checksum, so a rule under
 * test is not drowned out by ChecksumStale.
 */
async function mutatedValid(
  mutate: (raw: Record<string, unknown>) => void,
): Promise<Record<string, unknown>> {
  const raw = (await loadFixture("valid")) as Record<string, unknown>;
  mutate(raw);
  raw.checksum = checksumTopology(TopologySpecSchema.parse(raw));
  return raw;
}

function nodeOf(raw: Record<string, unknown>, id: string): Record<string, unknown> {
  const found = (raw.nodes as Array<Record<string, unknown>>).find((n) => n.id === id);
  if (!found) throw new Error(`fixture has no node "${id}"`);
  return found;
}

// ── Fixture coverage ────────────────────────────────────────────────

describe("diagnostic fixtures", () => {
  it("ships one dedicated malformed fixture per diagnostic code", async () => {
    const files = (await readdir(FIXTURE_DIR)).filter((f) => f.endsWith(".json")).sort();
    const codesWithFixture = files
      .map((f) => f.replace(/\.json$/, ""))
      .filter((name) => name !== "valid");
    expect(new Set(codesWithFixture).size).toBe(codesWithFixture.length);
    expect(codesWithFixture.sort()).toEqual([...DIAGNOSTIC_CODES].sort());
    expect(DIAGNOSTIC_CODES).toHaveLength(32);
    expect(files).toContain("valid.json");
  });

  it("accepts the well-formed fixture with zero diagnostics", async () => {
    const report = validateTopology(await loadFixture("valid"));
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
    expect(report.spec?.graphId).toBe("fixture");
  });

  // sc-1-3: every code has a fixture that produces EXACTLY that code.
  it.each(DIAGNOSTIC_CODES.map((code) => ({ code })))(
    "$code fixture fails with exactly that code",
    async ({ code }) => {
      const raw = await loadFixture(code);
      const report = validateTopology(raw, FULL_MODE_FIXTURE_OPTS[code]);
      expect(report.ok).toBe(false);
      expect(errorCodes(report)).toEqual([code]);
      expect(report.diagnostics.length).toBeGreaterThan(0);
      for (const d of report.diagnostics) {
        expect(d.message.length).toBeGreaterThan(10);
      }
    },
  );
});

// ── Never throws ────────────────────────────────────────────────────

describe("validateTopology totality", () => {
  const circular: Record<string, unknown> = { nodes: [] };
  circular.self = circular;

  const junk: Array<{ label: string; value: unknown }> = [
    { label: "null", value: null },
    { label: "undefined", value: undefined },
    { label: "number", value: 42 },
    { label: "NaN", value: Number.NaN },
    { label: "string", value: "not a topology" },
    { label: "empty string", value: "" },
    { label: "boolean", value: true },
    { label: "empty array", value: [] },
    { label: "array of nulls", value: [null, null] },
    { label: "empty object", value: {} },
    { label: "nodes: null", value: { nodes: null } },
    { label: "nodes: string", value: { formatVersion: 1, nodes: "x" } },
    { label: "deeply nested junk", value: { a: { b: { c: { d: [[[{ e: 1 }]]] } } } } },
    { label: "circular", value: circular },
    { label: "function", value: () => undefined },
    { label: "date", value: new Date(0) },
    { label: "map", value: new Map([["nodes", []]]) },
    { label: "symbol-keyed", value: { [Symbol("s")]: 1 } },
    { label: "prototype-less", value: Object.create(null) },
    { label: "partial spec", value: { formatVersion: 1, graphId: "g", nodes: [{ kind: "llm" }] } },
  ];

  // sc-1-4: never throws, always returns a ValidationReport.
  it.each(junk)("returns a report for $label instead of throwing", ({ value }) => {
    let report: ValidationReport | undefined;
    expect(() => {
      report = validateTopology(value);
    }).not.toThrow();
    expect(typeof report?.ok).toBe("boolean");
    expect(Array.isArray(report?.diagnostics)).toBe(true);
    expect(report?.ok).toBe(false);
    expect(report?.spec).toBeNull();
    expect(report?.diagnostics.length).toBeGreaterThan(0);
  });

  it("is pure — repeated calls on the same input return deep-equal reports", async () => {
    const raw = await loadFixture("valid");
    const first = validateTopology(raw);
    const second = validateTopology(raw);
    const third = validateTopology(JSON.parse(JSON.stringify(raw)) as unknown);
    expect(second).toEqual(first);
    expect(third).toEqual(first);
  });

  it("does not mutate the input artifact", async () => {
    const raw = await loadFixture("valid");
    const before = JSON.stringify(raw);
    validateTopology(raw, { mode: "full", prompts: ALL_PROMPTS });
    expect(JSON.stringify(raw)).toBe(before);
  });
});

// ── Port typing ─────────────────────────────────────────────────────

describe("PortTypeMismatch", () => {
  // sc-1-5
  it("names both node ids and the offending field path", async () => {
    const report = validateTopology(await loadFixture("PortTypeMismatch"));
    const diagnostic = report.diagnostics.find((d) => d.code === "PortTypeMismatch");
    expect(diagnostic).toBeDefined();
    expect(diagnostic?.nodeIds).toEqual(["plan_draft", "plan_route"]);
    expect(diagnostic?.edgeIds).toEqual(["e2"]);
    expect(diagnostic?.path?.[0]).toBe("edges");
    expect(diagnostic?.path?.[2]).toBe("ports");
    expect(diagnostic?.path?.[3]).toBe("to");
    expect(diagnostic?.message).toContain("PlanSpec");
    expect(diagnostic?.message).toContain("FeatureRequest");
    expect(diagnostic?.message).toContain("plan_draft");
    expect(diagnostic?.message).toContain("plan_route");
  });

  it("reports UndeclaredPort rather than a type mismatch when the port key does not resolve", async () => {
    const report = validateTopology(await loadFixture("UndeclaredPort"));
    expect(errorCodes(report)).toEqual(["UndeclaredPort"]);
    const diagnostic = report.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["plan_draft"]);
    expect(diagnostic.path).toEqual(["edges", 1, "ports", "from"]);
  });

  it("uses the injected SchemaCatalog in full mode", async () => {
    const raw = await loadFixture("valid");
    const rejecting: SchemaCatalog = { has: () => true, isAssignable: () => false };
    const report = validateTopology(raw, { mode: "full", schemas: rejecting, prompts: ALL_PROMPTS });
    expect(errorCodes(report)).toEqual(["PortTypeMismatch"]);
    expect(report.diagnostics).toHaveLength(2); // both port-bound edges

    const accepting: SchemaCatalog = { has: () => true, isAssignable: () => true };
    const relaxed = validateTopology(await loadFixture("PortTypeMismatch"), {
      mode: "full",
      schemas: accepting,
      prompts: ALL_PROMPTS,
    });
    expect(relaxed.ok).toBe(true);
  });
});

// ── Cycles ──────────────────────────────────────────────────────────

describe("cycle analysis", () => {
  let spec: TopologySpec;

  beforeAll(async () => {
    spec = TopologySpecSchema.parse(await loadFixture("valid"));
  });

  // sc-1-6
  it("enumerates every cycle via strongly connected components", () => {
    const cycles = findCycles(spec);
    const asSets = cycles.map((c) => [...c.nodeIds].sort().join(","));
    expect(asSets.sort()).toEqual(
      [
        ["plan_draft", "plan_route"].sort().join(","),
        [
          "supervisor",
          "sprint_body",
          "gate_sprint_in",
          "sprint_generate",
          "sprint_test",
          "gate_sprint_out",
        ]
          .sort()
          .join(","),
      ].sort(),
    );
  });

  it("asserts each cycle contains a node declaring counterKey and maxIterations", () => {
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const cycles = findCycles(spec);
    expect(cycles.length).toBeGreaterThan(0);
    for (const cycle of cycles) {
      const bounded = cycle.nodeIds
        .map((id) => byId.get(id))
        .filter((n) => n?.loop !== undefined);
      expect(bounded.length, `cycle [${cycle.nodeIds.join(",")}] has no loop bound`).toBeGreaterThan(0);
      for (const node of bounded) {
        expect(typeof node?.loop?.counterKey).toBe("string");
        expect(node?.loop?.counterKey.length).toBeGreaterThan(0);
        expect(node?.loop?.maxIterations).toBeGreaterThanOrEqual(1);
      }
    }
  });

  it("reports UnboundedCycle for a cyclic edge with no loop bound", async () => {
    const raw = await loadFixture("UnboundedCycle");
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual(["UnboundedCycle"]);
    const cycleNodes = report.diagnostics[0].nodeIds.sort();
    expect(cycleNodes).toEqual(["commit", "finalize", "hitl_commit"]);

    const mutated = TopologySpecSchema.parse(raw);
    expect(findCycles(mutated)).toHaveLength(3);
  });

  it("detects a self-loop as a cycle", async () => {
    const raw = (await loadFixture("valid")) as Record<string, unknown>;
    const edges = raw.edges as Array<Record<string, unknown>>;
    edges.push({ id: "self", from: "commit", to: "commit", kind: "normal" });
    const spec2 = TopologySpecSchema.parse(raw);
    const selfCycles = findCycles(spec2).filter((c) => c.selfLoop);
    expect(selfCycles).toHaveLength(1);
    expect(selfCycles[0].nodeIds).toEqual(["commit"]);
    expect(errorCodes(validateTopology(raw))).toContain("UnboundedCycle");
  });

  it("finds no cycles in an acyclic graph", async () => {
    const raw = (await loadFixture("valid")) as Record<string, unknown>;
    raw.edges = (raw.edges as Array<Record<string, unknown>>).filter(
      (e) => e.id !== "e3" && e.id !== "e11",
    );
    expect(findCycles(TopologySpecSchema.parse(raw))).toEqual([]);
  });
});

// ── Supervisor topology (ADR-5 / ADR-6) ─────────────────────────────

describe("supervisor topology rules", () => {
  let spec: TopologySpec;

  beforeAll(async () => {
    spec = TopologySpecSchema.parse(await loadFixture("valid"));
  });

  // sc-1-7
  it("keeps subgraph nesting at or below the maximum depth", () => {
    for (const sub of spec.subgraphs) {
      expect(sub.depth).toBeLessThanOrEqual(2);
    }
    expect(TopologySpecSchema.safeParse({ ...spec, subgraphs: [{ ...spec.subgraphs[0], depth: 3 }] }).success).toBe(
      false,
    );
  });

  it("routes every subgraph exit edge to the supervisor node", () => {
    const exitGates = new Set(spec.subgraphs.map((s) => s.exitGate));
    const exitEdges = spec.edges.filter((e) => exitGates.has(e.from));
    expect(exitEdges.length).toBeGreaterThan(0);
    for (const edge of exitEdges) {
      expect(edge.to).toBe(spec.defaults.supervisorNodeId);
    }
  });

  it("passes every boundary-crossing edge through a gate node", () => {
    const byId = new Map(spec.nodes.map((n) => [n.id, n]));
    const crossings = spec.edges.filter((e) => {
      const from = byId.get(e.from);
      const to = byId.get(e.to);
      return from !== undefined && to !== undefined && (from.subgraph ?? null) !== (to.subgraph ?? null);
    });
    expect(crossings.length).toBeGreaterThan(0);
    for (const edge of crossings) {
      const kinds = [byId.get(edge.from)?.kind, byId.get(edge.to)?.kind];
      expect(kinds, `edge ${edge.id} crosses a boundary without a gate`).toContain("gate");
    }
  });

  it("declares subgraph persistence as the literal inherit", () => {
    for (const sub of spec.subgraphs) {
      expect(sub.persistence).toBe("inherit");
    }
  });

  it("reports SubgraphDepthExceeded from the derived nesting chain, not only the declared field", async () => {
    const raw = (await loadFixture("valid")) as Record<string, unknown>;
    const nodes = raw.nodes as Array<Record<string, unknown>>;
    const edges = raw.edges as Array<Record<string, unknown>>;
    const subgraphs = raw.subgraphs as Array<Record<string, unknown>>;

    // sprint (depth 1) -> inner (depth 2) -> deepest (depth 3), every declared depth legal.
    nodes.push(
      {
        id: "inner_body",
        kind: "subgraph",
        title: "Inner call site",
        doc: "Nested one level below the sprint subgraph.",
        subgraph: "sprint",
        role: "utility",
        inputPorts: [],
        outputPorts: [],
        reads: [],
        writes: [],
        effects: [],
        subgraphRef: "inner",
      },
      {
        id: "gate_inner_in",
        kind: "gate",
        title: "Inner entry gate",
        doc: "Boundary gate into the inner subgraph.",
        subgraph: "inner",
        role: "utility",
        inputPorts: [],
        outputPorts: [],
        reads: [],
        writes: [],
        effects: [],
        gate: { check: "inner-ready", onFail: "END" },
      },
      {
        id: "deepest_body",
        kind: "subgraph",
        title: "Deepest call site",
        doc: "Nested two levels below the sprint subgraph.",
        subgraph: "inner",
        role: "utility",
        inputPorts: [],
        outputPorts: [],
        reads: [],
        writes: [],
        effects: [],
        subgraphRef: "deepest",
      },
    );
    edges.push(
      { id: "n1", from: "gate_sprint_in", to: "inner_body", kind: "normal" },
      { id: "n2", from: "inner_body", to: "gate_inner_in", kind: "normal" },
      { id: "n3", from: "gate_inner_in", to: "deepest_body", kind: "normal" },
      { id: "n4", from: "deepest_body", to: "gate_sprint_out", kind: "normal" },
    );
    subgraphs.push(
      {
        id: "inner",
        graphId: "fixture.inner",
        depth: 2,
        entryGate: "gate_inner_in",
        exitGate: "gate_sprint_out",
        persistence: "inherit",
      },
      {
        id: "deepest",
        graphId: "fixture.deepest",
        depth: 2,
        entryGate: "gate_inner_in",
        exitGate: "gate_sprint_out",
        persistence: "inherit",
      },
    );

    const parsed = TopologySpecSchema.safeParse(raw);
    expect(parsed.success, "the declared depths must all be schema-legal").toBe(true);

    const report = validateTopology(raw);
    const depthDiags = report.diagnostics.filter((d) => d.code === "SubgraphDepthExceeded");
    expect(depthDiags).toHaveLength(1);
    expect(depthDiags[0].message).toContain("deepest");
    expect(depthDiags[0].message).toContain("depth 3");
  });
});

// ── Modes ───────────────────────────────────────────────────────────

describe("validation modes", () => {
  it("does not resolve promptRef in structural mode", async () => {
    const report = validateTopology(await loadFixture("UnknownPromptRef"));
    expect(report.ok).toBe(true);
    expect(errorCodes(report)).toEqual([]);
  });

  it("resolves promptRef in full mode and names the unresolved ref", async () => {
    const report = validateTopology(await loadFixture("UnknownPromptRef"), {
      mode: "full",
      prompts: ALL_PROMPTS,
    });
    expect(errorCodes(report)).toEqual(["UnknownPromptRef"]);
    expect(report.diagnostics[0].nodeIds).toEqual(["plan_draft"]);
    expect(report.diagnostics[0].message).toContain("planner/absent");
  });

  it("skips prompt resolution in full mode when no PromptRefSet is injected", async () => {
    const report = validateTopology(await loadFixture("UnknownPromptRef"), { mode: "full" });
    expect(report.ok).toBe(true);
  });

  it("defaults to structural mode", async () => {
    const explicit = validateTopology(await loadFixture("UnknownPromptRef"), { mode: "structural" });
    const implicit = validateTopology(await loadFixture("UnknownPromptRef"));
    expect(implicit).toEqual(explicit);
  });
});

// ── Checksum rule ───────────────────────────────────────────────────

describe("ChecksumStale", () => {
  it("fires when the stored checksum does not match the canonical form", async () => {
    const raw = (await loadFixture("valid")) as Record<string, unknown>;
    const good = validateTopology(raw);
    expect(good.ok).toBe(true);

    raw.checksum = `sha256:${"c".repeat(64)}`;
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual(["ChecksumStale"]);
    expect(report.diagnostics[0].path).toEqual(["checksum"]);
    expect(report.diagnostics[0].message).toContain(checksumTopology(TopologySpecSchema.parse(raw)));
  });
});

// ── Policy endpoints (regression: review finding 1) ─────────────────
//
// gate.onFail, hitl.onReject and loop.onExhausted are all typed EndpointSchema, i.e.
// "a node id or END". They used to be resolved by nothing and to enter no adjacency,
// so a dangling recovery target validated clean AND a node reachable only through one
// was falsely reported unreachable.

describe("policy endpoints participate in the control-flow graph", () => {
  it.each([
    { label: "gate.onFail", nodeId: "gate_in", field: ["gate", "onFail"] },
    { label: "hitl.onReject", nodeId: "hitl_commit", field: ["hitl", "onReject"] },
    { label: "loop.onExhausted", nodeId: "plan_route", field: ["loop", "onExhausted"] },
  ])("reports DanglingEdge for an unresolvable $label", async ({ nodeId, field }) => {
    const raw = await mutatedValid((spec) => {
      const node = nodeOf(spec, nodeId);
      (node[field[0]] as Record<string, unknown>)[field[1]] = "does_not_exist";
    });
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual(["DanglingEdge"]);
    const diagnostic = report.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual([nodeId]);
    expect(diagnostic.message).toContain("does_not_exist");
    expect(diagnostic.message).toContain(field.join("."));
    expect(diagnostic.path?.[0]).toBe("nodes");
    expect(diagnostic.path?.slice(2)).toEqual(field);
  });

  it("accepts a policy endpoint naming the reserved terminal", async () => {
    const report = validateTopology(await loadFixture("valid"));
    expect(report.ok).toBe(true);
  });

  it("treats a node reachable only through gate.onFail as reachable", async () => {
    const raw = await mutatedValid((spec) => {
      (spec.nodes as unknown[]).push({
        subgraph: null,
        role: "utility",
        inputPorts: [],
        outputPorts: [],
        reads: [],
        writes: [],
        effects: [],
        id: "recover",
        kind: "tool",
        title: "Recovery",
        doc: "Reached only through gate_in.gate.onFail — no edges[] entry points here.",
        toolRef: "noop",
      });
      (nodeOf(spec, "gate_in").gate as Record<string, unknown>).onFail = "recover";
      (spec.edges as unknown[]).push({ id: "e15", from: "recover", to: "END", kind: "normal" });
    });
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("treats loop.onExhausted:'END' as a terminal path", async () => {
    const raw = await mutatedValid((spec) => {
      (spec.nodes as unknown[]).push({
        subgraph: null,
        role: "utility",
        inputPorts: [],
        outputPorts: [],
        reads: [],
        writes: [],
        effects: [],
        id: "retry_router",
        kind: "router",
        title: "Retry router",
        doc: "Its only path to the terminal endpoint is loop.onExhausted.",
        modelTier: "light",
        loop: { counterKey: "retries", maxIterations: 2, onExhausted: "END" },
        targets: [{ label: "again", to: "retry_router" }],
      });
      (spec.edges as unknown[]).push(
        { id: "e15", from: "finalize", to: "retry_router", kind: "normal" },
        { id: "e16", from: "retry_router", to: "retry_router", kind: "conditional", label: "again" },
      );
    });
    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual([]);
    expect(report.ok).toBe(true);
  });
});

// ── Reducer registry lookup (regression: review finding 3) ──────────

describe("MissingReducer", () => {
  it.each(["toString", "constructor", "valueOf", "hasOwnProperty", "isPrototypeOf", "__proto__"])(
    "reports exactly MissingReducer for the inherited member %s",
    async (ref) => {
      const raw = await mutatedValid((spec) => {
        const channels = spec.channels as Array<Record<string, unknown>>;
        const channel = channels.find((c) => c.id === "branchStatus");
        if (channel) channel.reducerRef = ref;
      });
      const report = validateTopology(raw);
      expect(errorCodes(report)).toEqual(["MissingReducer"]);
    },
  );
});

// ── Subgraph exit gate (regression: review finding 4) ───────────────

describe("SubgraphExitNotSupervisor", () => {
  it("fires when the exit gate routes to the reserved terminal instead of the supervisor", async () => {
    const raw = await mutatedValid((spec) => {
      const edges = spec.edges as Array<Record<string, unknown>>;
      const exitEdge = edges.find((e) => e.id === "e11");
      if (exitEdge) exitEdge.to = "END";
    });
    const report = validateTopology(raw);
    expect(errorCodes(report)).toContain("SubgraphExitNotSupervisor");
    const diagnostic = report.diagnostics.find((d) => d.code === "SubgraphExitNotSupervisor");
    expect(diagnostic?.nodeIds).toEqual(["gate_sprint_out", "END"]);
    expect(diagnostic?.edgeIds).toEqual(["e11"]);
    expect(diagnostic?.message).toContain("supervisor");
  });

  /**
   * Regression: sprint-2 review, blocking finding 2.
   *
   * A fanned-out subgraph exits once PER BRANCH, so it needs a join between the
   * per-branch exit gate and the single return to the supervisor. Requiring
   * `exitGate -> supervisor` unconditionally made that join unrepresentable and pushed
   * the barrier INSIDE the subgraph, where it is per-branch and joins nothing. The rule
   * now permits exactly one hop through a root-level fan-in barrier gate — and nothing
   * else, which is what the negative cases below pin.
   */
  describe("fan-in barrier exemption", () => {
    /** Rewires the fixture to `gate_sprint_out -> <barrier> -> supervisor`, letting each
     * test vary how the barrier node itself is declared. */
    async function withBarrier(
      barrier: Record<string, unknown>,
      onward: Array<Record<string, unknown>> = [
        { id: "e15", from: "reduce_sprints", to: "supervisor", kind: "normal" },
      ],
    ): Promise<Record<string, unknown>> {
      return mutatedValid((spec) => {
        const nodes = spec.nodes as Array<Record<string, unknown>>;
        const edges = spec.edges as Array<Record<string, unknown>>;
        nodes.push(barrier);
        const exitEdge = edges.find((e) => e.id === "e11");
        if (exitEdge) exitEdge.to = "reduce_sprints";
        edges.push(...onward);
      });
    }

    const rootBarrier = (): Record<string, unknown> => ({
      id: "reduce_sprints",
      kind: "gate",
      title: "Sprint fan-in barrier",
      doc: "Joins every dispatched branch and makes one return to the supervisor.",
      subgraph: null,
      role: "utility",
      inputPorts: [],
      outputPorts: [],
      reads: [],
      writes: [],
      effects: [],
      gate: { check: "all-branches-settled", onFail: "supervisor" },
    });

    it("accepts a root-level barrier gate whose every edge routes to the supervisor", async () => {
      const report = validateTopology(await withBarrier(rootBarrier()));
      expect(errorCodes(report)).not.toContain("SubgraphExitNotSupervisor");
    });

    it("still fires when the hop node is not a gate", async () => {
      const report = validateTopology(
        await withBarrier({ ...rootBarrier(), kind: "tool", toolRef: "sprint.reduce", gate: undefined }),
      );
      expect(errorCodes(report)).toContain("SubgraphExitNotSupervisor");
    });

    it("still fires when the barrier is declared INSIDE the subgraph, where it is per-branch", async () => {
      const report = validateTopology(await withBarrier({ ...rootBarrier(), subgraph: "sprint" }));
      expect(errorCodes(report)).toContain("SubgraphExitNotSupervisor");
    });

    it("still fires when the barrier routes somewhere other than the supervisor", async () => {
      const report = validateTopology(
        await withBarrier(rootBarrier(), [
          { id: "e15", from: "reduce_sprints", to: "supervisor", kind: "normal" },
          { id: "e16", from: "reduce_sprints", to: "finalize", kind: "normal" },
        ]),
      );
      expect(errorCodes(report)).toContain("SubgraphExitNotSupervisor");
    });

    it("still fires when the barrier is a dead end with no onward edge at all", async () => {
      const report = validateTopology(await withBarrier(rootBarrier(), []));
      expect(errorCodes(report)).toContain("SubgraphExitNotSupervisor");
    });
  });
});

// ── schemaRef resolution in full mode (regression: review finding 5) ─

describe("UnknownSchemaRef", () => {
  it("calls the injected SchemaCatalog.has for every channel and port schemaRef", async () => {
    const asked: string[] = [];
    const recording: SchemaCatalog = {
      has: (ref) => {
        asked.push(ref);
        return true;
      },
      isAssignable: (from, to) => from === to,
    };
    const report = validateTopology(await loadFixture("valid"), {
      mode: "full",
      schemas: recording,
      prompts: ALL_PROMPTS,
    });
    expect(report.ok).toBe(true);
    expect(asked.length).toBeGreaterThan(0);
    // Channel refs and both port lists are all resolved.
    expect(new Set(asked)).toEqual(
      new Set(["GraphMessage", "Counters", "PlanSpec", "BranchStatus", "FeatureRequest"]),
    );
  });

  it("reports an unresolvable channel schemaRef and names the ref", async () => {
    const report = validateTopology(await loadFixture("UnknownSchemaRef"), {
      mode: "full",
      schemas: ALL_SCHEMAS,
      prompts: ALL_PROMPTS,
    });
    expect(errorCodes(report)).toEqual(["UnknownSchemaRef"]);
    expect(report.diagnostics[0].message).toContain("NoSuchSchema");
    expect(report.diagnostics[0].path).toEqual(["channels", 3, "schemaRef"]);
  });

  it("reports an unresolvable port schemaRef instead of a spurious PortTypeMismatch", async () => {
    const raw = await mutatedValid((spec) => {
      const ports = nodeOf(spec, "plan_route").inputPorts as Array<Record<string, unknown>>;
      ports[0].schemaRef = "NoSuchSchema";
    });
    const report = validateTopology(raw, {
      mode: "full",
      schemas: ALL_SCHEMAS,
      prompts: ALL_PROMPTS,
    });
    expect(errorCodes(report)).toEqual(["UnknownSchemaRef"]);
    const diagnostic = report.diagnostics[0];
    expect(diagnostic.nodeIds).toEqual(["plan_route"]);
    expect(diagnostic.message).toContain("NoSuchSchema");
    expect(diagnostic.path).toEqual(["nodes", 2, "inputPorts", 0, "schemaRef"]);
  });

  it("does not resolve schemaRef in structural mode", async () => {
    const report = validateTopology(await loadFixture("UnknownSchemaRef"));
    expect(report.ok).toBe(true);
  });

  it("skips schema resolution in full mode when no SchemaCatalog is injected", async () => {
    const report = validateTopology(await loadFixture("UnknownSchemaRef"), { mode: "full" });
    expect(report.ok).toBe(true);
  });
});

// ── Model tier vs effective role (regression: review finding 6) ─────

describe("ModelTierMismatch", () => {
  it("fires for a kind:'router' node that omits role and declares the frontier tier", async () => {
    const raw = await mutatedValid((spec) => {
      const node = nodeOf(spec, "plan_route");
      delete node.role; // defaults to "utility", which is in neither role list
      node.modelTier = "frontier";
    });
    // The omitted role really does default rather than fail the schema.
    expect(TopologySpecSchema.parse(raw).nodes[2].role).toBe("utility");

    const report = validateTopology(raw);
    expect(errorCodes(report)).toEqual(["ModelTierMismatch"]);
    expect(report.diagnostics[0].nodeIds).toEqual(["plan_route"]);
    expect(report.diagnostics[0].message).toContain("router");
  });

  it("still fires on the declared-role path", async () => {
    const report = validateTopology(await loadFixture("ModelTierMismatch"));
    expect(errorCodes(report)).toEqual(["ModelTierMismatch"]);
    expect(report.diagnostics[0].nodeIds).toEqual(["plan_draft"]);
  });
});
