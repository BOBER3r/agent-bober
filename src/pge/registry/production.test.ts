// ── production.test.ts ──────────────────────────────────────────────
//
// sc-13-1 — the COMMITTED artifact and the PRODUCTION registries are the same graph.
//
// The artifact under test is `.bober/topology/coding.json` from this checkout, copied into
// a temp root — never a fixture and never the authored TypeScript literal. `compile()` is
// all-or-nothing in BOTH directions, so a green run here is a proof of a two-way
// correspondence: every node the artifact declares has an implementation
// (`UnregisteredNodeImpl`) and every registered implementation is declared
// (`OrphanNodeImpl`).

import { cp, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { TopologyCompileError, loadCompiledGraph } from "../compile/compiler.js";
import type { CompiledGraph } from "../compile/compiler.js";
import { EFFECTS } from "../nodes/effects.js";
import { codingRegistries, codingSchemaCatalog, createCodingEffectRegistry } from "./index.js";
import type { CodingBindings } from "./index.js";
import { validateTopology } from "../topology/validate.js";
import type { TopologySpec } from "../../contracts/topology.js";
import type { SandboxOutcome } from "../runtime/sandbox.js";
import { createScratchStore } from "../runtime/scratch.js";
import { createTraceWriter } from "../runtime/trace.js";
import type { TraceWriter } from "../runtime/trace.js";

// ── The repository's own committed artifact ─────────────────────────

const HERE = dirname(fileURLToPath(import.meta.url));
/** `<repo>/.bober/topology/coding.json` — src/pge/registry/ is three levels below the root. */
const REPO_ROOT = join(HERE, "..", "..", "..");
const COMMITTED_ARTIFACT = join(REPO_ROOT, ".bober", "topology", "coding.json");
const GRAPH_ID = "coding";

let tmpRoots: string[] = [];

beforeEach(() => {
  tmpRoots = [];
});

afterEach(async () => {
  await Promise.all(tmpRoots.map((r) => rm(r, { recursive: true, force: true })));
  tmpRoots = [];
});

/**
 * A temp project root holding a COPY of the committed artifact.
 *
 * A bare temp root has no `.bober/topology/`, and `loadCompiledGraph` would then throw for
 * a missing FILE — which reads exactly like a compile failure and proves nothing about the
 * registries.
 */
async function rootWithCommittedArtifact(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "bober-pge-production-"));
  tmpRoots.push(dir);
  await mkdir(join(dir, ".bober", "topology"), { recursive: true });
  await cp(COMMITTED_ARTIFACT, join(dir, ".bober", "topology", `${GRAPH_ID}.json`));
  return dir;
}

/** The committed artifact as a validated spec, read the same way the loader reads it. */
async function committedSpec(): Promise<TopologySpec> {
  const raw: unknown = JSON.parse(await readFile(COMMITTED_ARTIFACT, "utf-8"));
  const report = validateTopology(raw, { mode: "structural" });
  expect(
    report.diagnostics.filter((d) => d.severity === "error"),
    "the committed artifact must validate structurally before it can be compiled",
  ).toEqual([]);
  expect(report.spec).toBeDefined();
  return report.spec as TopologySpec;
}

/**
 * The bindings a compilation needs.
 *
 * `runtime` is REAL — a real scratch store and a real trace writer rooted at the temp
 * project root, and a sandbox that refuses every command. Compilation never invokes a node
 * body, so a refusing sandbox is the honest binding here: it cannot execute anything, which
 * is exactly what a compile-only test should be able to promise. The four collaborators
 * this repository does not ship throw when invoked, for the reason `UnboundCollaboratorError`
 * gives — a silent stub would fabricate evidence.
 */
function compileOnlyBindings(projectRoot: string, trace: TraceWriter): CodingBindings {
  const refuse = (name: string) => {
    return (): never => {
      throw new Error(`compile-only binding "${name}" was invoked`);
    };
  };
  return {
    runtime: {
      sandbox: {
        run: (): Promise<SandboxOutcome> => {
          throw new Error("compile-only sandbox was asked to run a command");
        },
      },
      scratch: createScratchStore(projectRoot),
      trace,
    },
    reflect: refuse("reflect"),
    critique: refuse("critique"),
    explain: refuse("explain"),
    mocks: refuse("mocks"),
  };
}

// ── sc-13-1 ─────────────────────────────────────────────────────────

describe("codingRegistries against the committed artifact (sc-13-1)", () => {
  it("compiles .bober/topology/coding.json with zero UnregisteredNodeImpl and zero OrphanNodeImpl", async () => {
    const root = await rootWithCommittedArtifact();
    const trace = await createTraceWriter(root, "run-sc-13-1");
    const spec = await committedSpec();

    let graph: CompiledGraph | null = null;
    let failure: TopologyCompileError | null = null;
    try {
      graph = await loadCompiledGraph(root, GRAPH_ID, codingRegistries(spec, compileOnlyBindings(root, trace)));
    } catch (error) {
      if (!(error instanceof TopologyCompileError)) throw error;
      failure = error;
    } finally {
      await trace.close();
    }

    if (failure !== null) {
      // A readable failure: name every node the artifact declares and the registries do
      // not implement, and every implementation the artifact does not declare.
      const unregistered = failure.diagnostics
        .filter((d) => d.code === "UnregisteredNodeImpl")
        .flatMap((d) => d.nodeIds);
      const orphans = failure.diagnostics
        .filter((d) => d.code === "OrphanNodeImpl")
        .flatMap((d) => d.nodeIds);
      const other = [
        ...new Set(
          failure.diagnostics
            .filter((d) => d.code !== "UnregisteredNodeImpl" && d.code !== "OrphanNodeImpl")
            .map((d) => `${d.code}: ${d.message}`),
        ),
      ];
      expect(
        { unregistered: unregistered.sort(), orphans: orphans.sort(), other },
        "The committed artifact did not compile against the production registries. " +
          "`unregistered` lists every node .bober/topology/coding.json declares that " +
          "src/pge/nodes/ does not implement; register them in codingNodeRegistry " +
          "(src/pge/registry/index.ts) — see the comment there. Do NOT edit the artifact.",
      ).toEqual({ unregistered: [], orphans: [], other: [] });
    }

    expect(failure).toBeNull();
    expect(graph).not.toBeNull();
    // Cross-check the two-way correspondence at the compiled OUTPUT, not just at the
    // absence of a throw: the artifact declares 44 nodes and the compiled graph holds a
    // CompiledNode for each of them.
    const compiled = graph as CompiledGraph;
    expect([...compiled.nodes.keys()].sort()).toEqual(spec.nodes.map((n) => n.id).sort());
    expect(compiled.nodes.size).toBe(spec.nodes.length);
  });

  it("registers NOTHING the artifact does not declare — zero OrphanNodeImpl", async () => {
    const root = await rootWithCommittedArtifact();
    const trace = await createTraceWriter(root, "run-orphans");
    const spec = await committedSpec();
    const declared = new Set(spec.nodes.map((n) => n.id));

    try {
      const registries = codingRegistries(spec, compileOnlyBindings(root, trace));
      // The direction `compile()` checks as `OrphanNodeImpl`, asserted directly against the
      // registry so it holds whether or not compilation as a whole succeeds: an
      // implementation that drifted out of the artifact would show up here.
      const undeclared = registries.nodes.ids().filter((id) => !declared.has(id));
      expect(undeclared).toEqual([]);
    } finally {
      await trace.close();
    }
  });

  it("builds ONE effect registry, with the graceful-failure effect registered exactly once", async () => {
    const root = await rootWithCommittedArtifact();
    const trace = await createTraceWriter(root, "run-effects");
    try {
      // The four per-region builders each register `gracefulFailureEffect`; folding them
      // together would throw DuplicateEffectError. Constructing the whole-graph registry
      // without throwing is the assertion.
      const registry = createCodingEffectRegistry(compileOnlyBindings(root, trace));
      const names = registry.list().map((entry) => entry.name);
      expect(new Set(names).size).toBe(names.length);
      // The effect every region's failure terminal invokes, registered once.
      expect(names).toContain(EFFECTS.gracefulFailure);
      // The union of all four regions' effect sets, and the ONE git-tagged effect.
      expect(names.length).toBeGreaterThanOrEqual(17);
      expect(
        registry.list().filter((entry) => entry.effects.includes("git")).map((e) => e.name),
      ).toEqual([EFFECTS.gitCommit]);
    } finally {
      await trace.close();
    }
  });

  it("registers each implementation exactly once — no DuplicateNodeImplError across regions", async () => {
    const root = await rootWithCommittedArtifact();
    const trace = await createTraceWriter(root, "run-nodes");
    try {
      const spec = await committedSpec();
      // `regionNodeRegistry` puts `supervisor` and `graceful_failure` into EVERY region, so
      // a composition that merged four region registries would throw here.
      const registries = codingRegistries(spec, compileOnlyBindings(root, trace));
      const ids = registries.nodes.ids();
      expect(new Set(ids).size).toBe(ids.length);
      expect(ids).toContain("supervisor");
      expect(ids).toContain("graceful_failure");
    } finally {
      await trace.close();
    }
  });

  it("resolves every schemaRef the artifact publishes through the artifact's own catalog", async () => {
    const spec = await committedSpec();
    const catalog = codingSchemaCatalog();
    const refs = spec.nodes.flatMap((node) => [
      ...node.inputPorts.map((p) => p.schemaRef),
      ...node.outputPorts.map((p) => p.schemaRef),
    ]);
    expect(refs.length).toBeGreaterThan(0);
    for (const ref of refs) {
      expect(catalog.has(ref), `schemaRef "${ref}" is not in the artifact's own ref list`).toBe(
        true,
      );
    }
  });
});
