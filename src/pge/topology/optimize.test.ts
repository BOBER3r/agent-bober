import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { TopologySpecSchema } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { CODING_GRAPH } from "./coding.graph.js";
import { dumpTopology, topologyArtifactPath } from "./dump.js";
import {
  VARIANTS_DIR,
  VariantRecordSchema,
  buildVariantRecord,
  optimizeTopology,
  variantId,
  variantRecordPath,
  variantsDir,
  writeVariantRecord,
} from "./optimize.js";
import { validateTopology } from "./validate.js";

/**
 * sc-3-9 — the optimisation HOOK: mutate, re-seal, re-validate, record.
 *
 * Zero node executions is a property of the module graph (the ESLint boundary on
 * `src/pge/topology/**` makes an executor unreachable), so what these tests add is the
 * behavioural half: `optimizeTopology` is SYNCHRONOUS and touches no filesystem, and
 * the variant it produces never reaches the committed artifact that `dump --check`
 * guards.
 */

const FIXTURE_DIR = fileURLToPath(new URL("./__fixtures__/", import.meta.url));

let root = "";

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-optimize-"));
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

function reseal(spec: TopologySpec): TopologySpec {
  return { ...spec, checksum: checksumTopology(spec) };
}

/** The optional gate the sc-3-9 mutation drops. */
const OPTIONAL_GATE: NodeSpec = {
  id: "gate_optional",
  kind: "gate",
  title: "Optional plan gate",
  doc: "An optional gate between the drafter and the clarification router.",
  subgraph: null,
  role: "utility",
  inputPorts: [{ key: "in", schemaRef: "PlanSpec", required: true }],
  outputPorts: [{ key: "out", schemaRef: "PlanSpec", required: true }],
  reads: [],
  writes: [],
  effects: [],
  gate: { check: "plan-optional", onFail: "END" },
};

/**
 * The base graph: the well-formed fixture with one OPTIONAL gate spliced between
 * `plan_draft` and `plan_route`, so a mutation has something legitimate to drop.
 */
async function baseWithOptionalGate(): Promise<TopologySpec> {
  const raw = JSON.parse(await readFile(`${FIXTURE_DIR}valid.json`, "utf8")) as unknown;
  const spec = clone(TopologySpecSchema.parse(raw));
  spec.nodes.push(OPTIONAL_GATE);
  spec.edges = spec.edges.filter((edge) => edge.id !== "e2");
  spec.edges.push(
    {
      id: "e2a",
      from: "plan_draft",
      to: "gate_optional",
      kind: "normal",
      ports: { from: "out", to: "in" },
    },
    {
      id: "e2b",
      from: "gate_optional",
      to: "plan_route",
      kind: "normal",
      ports: { from: "out", to: "in" },
    },
  );
  return reseal(spec);
}

/** Swap one node's promptRef and drop the optional gate, reconnecting around it. */
function swapPromptAndDropGate(spec: TopologySpec): TopologySpec {
  const drafter = spec.nodes.find((node) => node.id === "plan_draft");
  if (!drafter) throw new Error("fixture drift: no plan_draft node");
  drafter.promptRef = "planner/draft-v2";

  spec.nodes = spec.nodes.filter((node) => node.id !== "gate_optional");
  spec.edges = spec.edges.filter((edge) => edge.id !== "e2a" && edge.id !== "e2b");
  spec.edges.push({
    id: "e2",
    from: "plan_draft",
    to: "plan_route",
    kind: "normal",
    ports: { from: "out", to: "in" },
  });
  return spec;
}

// ── sc-3-9: the hook ────────────────────────────────────────────────

describe("optimizeTopology", () => {
  it("the base graph is well-formed before any mutation", async () => {
    const report = validateTopology(await baseWithOptionalGate());
    expect(report.diagnostics).toEqual([]);
    expect(report.ok).toBe(true);
  });

  it("returns a spec that passes validateTopology with provenance optimizer", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, swapPromptAndDropGate);

    expect(result.report.ok).toBe(true);
    expect(result.report.diagnostics).toEqual([]);
    expect(result.spec.provenance).toBe("optimizer");
    expect(result.spec.nodes.some((n) => n.id === "gate_optional")).toBe(false);
    expect(result.spec.nodes.length).toBe(base.nodes.length - 1);
    const drafter = result.spec.nodes.find((n) => n.id === "plan_draft");
    expect(drafter?.promptRef).toBe("planner/draft-v2");
  });

  it("re-seals the checksum over the mutated canonical form", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, swapPromptAndDropGate);
    expect(result.spec.checksum).toBe(checksumTopology(result.spec));
    expect(result.spec.checksum).not.toBe(base.checksum);
  });

  it("does not mutate its input, even when the mutator edits in place", async () => {
    const base = await baseWithOptionalGate();
    const before = JSON.stringify(base);
    const result = optimizeTopology(base, swapPromptAndDropGate);

    expect(JSON.stringify(base)).toBe(before);
    expect(base.provenance).toBe("authored");
    expect(base.nodes.some((n) => n.id === "gate_optional")).toBe(true);
    expect(base.nodes.find((n) => n.id === "plan_draft")?.promptRef).toBe("planner/draft");
    expect(result.spec).not.toBe(base);
  });

  it("stamps provenance even when the mutator tries to keep it authored", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, (spec) => ({ ...spec, provenance: "authored" }));
    expect(result.spec.provenance).toBe("optimizer");
  });

  it("performs no filesystem write of its own", async () => {
    const base = await baseWithOptionalGate();
    optimizeTopology(base, swapPromptAndDropGate);
    // The hook is synchronous: it cannot await `node:fs/promises`, and nothing appeared.
    await expect(readdir(root)).resolves.toEqual([]);
  });

  it("reports a broken mutation as diagnostics instead of throwing", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, (spec) => {
      spec.nodes = spec.nodes.filter((node) => node.id !== "plan_route");
      return spec;
    });
    expect(result.report.ok).toBe(false);
    const codes = result.report.diagnostics.map((d) => d.code);
    expect(codes).toContain("DanglingEdge");
    expect(result.spec.provenance).toBe("optimizer");
  });

  it("throws TypeError when the base is not a topology", () => {
    const bad = { nodes: [] } as unknown as TopologySpec;
    expect(() => optimizeTopology(bad, (s) => s)).toThrow(TypeError);
    expect(() => optimizeTopology(bad, (s) => s)).toThrow(/base topology/);
  });

  it("is idempotent for an identity mutation apart from the provenance stamp", () => {
    const first = optimizeTopology(CODING_GRAPH, (spec) => spec);
    const second = optimizeTopology(first.spec, (spec) => spec);
    expect(second.spec.checksum).toBe(first.spec.checksum);
    expect(first.report.ok).toBe(true);
    expect(second.report.ok).toBe(true);
  });
});

// ── Variant records ─────────────────────────────────────────────────

describe("variant records", () => {
  it("derives a deterministic id from the variant checksum", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, swapPromptAndDropGate);
    const id = variantId(result.spec);
    expect(id).toBe(variantId(result.spec));
    expect(id.startsWith("fixture-")).toBe(true);
    expect(id).toBe(`fixture-${result.spec.checksum.slice("sha256:".length, "sha256:".length + 16)}`);
    expect(id).not.toBe(variantId(base));
  });

  it("builds a record that parses against VariantRecordSchema", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, swapPromptAndDropGate);
    const record = buildVariantRecord(base, result);

    expect(VariantRecordSchema.safeParse(record).success).toBe(true);
    expect(record.provenance).toBe("optimizer");
    expect(record.valid).toBe(true);
    expect(record.diagnosticCodes).toEqual([]);
    expect(record.baseChecksum).toBe(base.checksum);
    expect(record.variantChecksum).toBe(result.spec.checksum);
    expect(record.spec.provenance).toBe("optimizer");
    expect(record.graphId).toBe("fixture");
  });

  it("leaves score and scoredAt null — there is no golden dataset to score against yet", async () => {
    const base = await baseWithOptionalGate();
    const record = buildVariantRecord(base, optimizeTopology(base, swapPromptAndDropGate));
    expect(record.score).toBeNull();
    expect(record.scoredAt).toBeNull();
  });

  it("records the diagnostic codes of an invalid variant", async () => {
    const base = await baseWithOptionalGate();
    const result = optimizeTopology(base, (spec) => {
      spec.nodes = spec.nodes.filter((node) => node.id !== "plan_route");
      return spec;
    });
    const record = buildVariantRecord(base, result);
    expect(record.valid).toBe(false);
    expect(record.diagnosticCodes).toContain("DanglingEdge");
    expect(record.diagnosticCodes).toEqual([...record.diagnosticCodes].sort());
  });

  it("writes under .bober/topology/variants/<variantId>.json", async () => {
    const base = await baseWithOptionalGate();
    const record = buildVariantRecord(base, optimizeTopology(base, swapPromptAndDropGate));
    const written = await writeVariantRecord(root, record);

    expect(written.path).toBe(join(root, VARIANTS_DIR, `${record.variantId}.json`));
    expect(written.path).toBe(variantRecordPath(root, record.variantId));
    expect(variantsDir(root)).toBe(join(root, ".bober", "topology", "variants"));

    const text = await readFile(written.path, "utf8");
    expect(text).toBe(written.serialized);
    expect(text.endsWith("}\n")).toBe(true);
    expect(VariantRecordSchema.safeParse(JSON.parse(text)).success).toBe(true);
  });

  it("is byte-stable: writing the same variant twice produces identical bytes", async () => {
    const base = await baseWithOptionalGate();
    const record = buildVariantRecord(base, optimizeTopology(base, swapPromptAndDropGate));
    const first = await writeVariantRecord(root, record);
    const firstBytes = await readFile(first.path, "utf8");
    const second = await writeVariantRecord(root, record);
    expect(second.path).toBe(first.path);
    expect(await readFile(second.path, "utf8")).toBe(firstBytes);
  });

  /**
   * REGRESSION. `writeVariantRecord` used to serialize and write whatever it was handed,
   * never applying `VariantRecordSchema`. `optimizeTopology` does not reject a bad
   * mutation — it returns the mutated spec alongside a FAILING report — so a mutator
   * that strips a required field yields a `result.spec` that `TopologySpecSchema`
   * rejects, `buildVariantRecord` embeds it happily, and the record landed on disk where
   * no reader of this schema can load it.
   */
  it("refuses to write a record whose embedded spec is not a TopologySpec", async () => {
    const result = optimizeTopology(CODING_GRAPH, (spec) => {
      const broken = spec as unknown as Record<string, unknown>;
      delete broken.entry;
      return spec;
    });
    // The hook reports the breakage rather than throwing, which is how the record
    // got built in the first place.
    expect(result.report.ok).toBe(false);
    expect(TopologySpecSchema.safeParse(result.spec).success).toBe(false);

    const record = buildVariantRecord(CODING_GRAPH, result);
    expect(VariantRecordSchema.safeParse(record).success).toBe(false);

    await expect(writeVariantRecord(root, record)).rejects.toThrow(TypeError);
    await expect(writeVariantRecord(root, record)).rejects.toThrow(/VariantRecordSchema/);
    await expect(readdir(variantsDir(root))).rejects.toThrow(/ENOENT/);
  });

  it("names the offending path when it rejects a record", async () => {
    const base = await baseWithOptionalGate();
    const record = buildVariantRecord(base, optimizeTopology(base, swapPromptAndDropGate));
    const broken = { ...record, baseChecksum: "not-a-checksum" };
    await expect(writeVariantRecord(root, broken)).rejects.toThrow(/baseChecksum/);
  });

  it("never writes the committed artifact that dump --check guards", async () => {
    await dumpTopology(root, CODING_GRAPH);
    const artifact = topologyArtifactPath(root, "coding");
    const before = await readFile(artifact, "utf8");

    const base = await baseWithOptionalGate();
    const record = buildVariantRecord(base, optimizeTopology(base, swapPromptAndDropGate));
    const written = await writeVariantRecord(root, record);

    expect(await readFile(artifact, "utf8")).toBe(before);
    expect(written.path).not.toBe(artifact);
    // dump --check still passes: variants live in a subdirectory it never inspects.
    const check = await dumpTopology(root, CODING_GRAPH, { check: true });
    expect(check.drift).toBe("none");
    expect(await readdir(variantsDir(root))).toEqual([`${record.variantId}.json`]);
  });
});
