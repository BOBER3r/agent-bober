import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { GRAPH_VERSION_PATTERN, TopologySpecSchema } from "../../contracts/topology.js";
import type { NodeSpec, TopologySpec } from "../../contracts/topology.js";
import { StateAuditSchema, stateAuditPath } from "../../pge/topology/audit.js";
import { checksumTopology } from "../../pge/topology/canonical.js";
import { CODING_GRAPH } from "../../pge/topology/coding.graph.js";
import type { TopologyDiff } from "../../pge/topology/diff.js";
import { DOC_NODES_BEGIN, DOC_NODES_END } from "../../pge/topology/docs.js";
import { serializeTopology, topologyArtifactPath } from "../../pge/topology/dump.js";
import { VariantRecordSchema, variantsDir } from "../../pge/topology/optimize.js";
import { renderTopology } from "../../pge/topology/render.js";
import { DIAGNOSTIC_CODES } from "../../pge/topology/validate.js";
import { loadConfig } from "../../config/loader.js";
import { resolveProviderModel } from "../../orchestrator/model-resolver.js";
import {
  EXIT_FAILED,
  EXIT_OK,
  EXIT_USAGE,
  codingSchemaCatalog,
  registerPgeCommand,
  runPgeAuditState,
  runPgeDiff,
  runPgeDocs,
  runPgeDump,
  runPgeHash,
  runPgeOptimize,
  runPgeRender,
  runPgeValidate,
} from "./pge.js";
import type { PgeIo } from "./pge.js";

/**
 * `bober pge dump | validate | hash`.
 *
 * Every verb is exercised through the exported function rather than the process, so
 * the exit code is a return value and stdout/stderr are captured through the injected
 * IO seam. The Commander wiring itself is asserted separately.
 */

const FIXTURE_DIR = fileURLToPath(new URL("../../pge/topology/__fixtures__/", import.meta.url));

/** Fixtures whose rule only fires once refs are resolved (mode: "full"). */
const FULL_MODE_CODES = new Set(["UnknownPromptRef", "UnknownSchemaRef"]);

let root = "";
let out: string[] = [];
let err: string[] = [];
let io: PgeIo;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-cli-"));
  out = [];
  err = [];
  io = { out: (line) => out.push(line), err: (line) => err.push(line) };
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

async function seedPromptStore(): Promise<void> {
  await mkdir(join(root, ".bober", "prompts", "planner"), { recursive: true });
  await mkdir(join(root, ".bober", "prompts", "generator"), { recursive: true });
  await writeFile(
    join(root, ".bober", "prompts", "planner", "draft.md"),
    "You are the planner. Draft a spec.\n",
    "utf8",
  );
  await writeFile(
    join(root, ".bober", "prompts", "generator", "sprint.md"),
    "You are the generator. Implement the contract.\n",
    "utf8",
  );
  await writeFile(
    join(root, ".bober", "prompts", "generator", "tests.md"),
    "You are the generator. Write the tests.\n",
    "utf8",
  );
}

function clone(spec: TopologySpec): TopologySpec {
  return TopologySpecSchema.parse(JSON.parse(JSON.stringify(spec)) as unknown);
}

// ── sc-2-3: dump writes the committed artifact ──────────────────────

describe("bober pge dump", () => {
  it("writes .bober/topology/coding.json with the full topology", async () => {
    const code = await runPgeDump(root, {}, io);
    expect(code).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out[0]).toContain("wrote");
    expect(out[0]).toContain(CODING_GRAPH.checksum);

    const path = topologyArtifactPath(root, "coding");
    const raw = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;

    expect(raw.graphId).toBe("coding");
    expect(String(raw.graphVersion)).toMatch(GRAPH_VERSION_PATTERN);
    expect(raw.provenance).toBe("authored");
    expect(raw.formatVersion).toBe(1);
    expect(raw.checksum).toBe(CODING_GRAPH.checksum);

    const parsed = TopologySpecSchema.safeParse(raw);
    expect(parsed.success).toBe(true);
    if (!parsed.success) return;

    expect(parsed.data.nodes.map((n) => n.id).sort()).toEqual(
      CODING_GRAPH.nodes.map((n) => n.id).sort(),
    );
    expect(new Set(parsed.data.nodes.map((n) => n.kind))).toEqual(
      new Set(["llm", "tool", "gate", "router", "subgraph"]),
    );
    for (const node of CODING_GRAPH.nodes) {
      const written = parsed.data.nodes.find((n) => n.id === node.id);
      expect(written?.kind, `node ${node.id} kind`).toBe(node.kind);
    }
    expect(parsed.data.edges.map((e) => e.id).sort()).toEqual(
      CODING_GRAPH.edges.map((e) => e.id).sort(),
    );
    expect(parsed.data.edges).toHaveLength(CODING_GRAPH.edges.length);
    expect(parsed.data.subgraphs.map((s) => s.id).sort()).toEqual(["research", "sprint"]);
  });

  it("reports 'unchanged' and rewrites nothing on a second dump", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    const code = await runPgeDump(root, {}, io);
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain("unchanged");
  });

  it("rejects an unknown graph id with the usage exit code", async () => {
    const code = await runPgeDump(root, { graphId: "nope" }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain('Unknown authored graph "nope"');
  });

  it("rejects a prototype-chain graph id", async () => {
    expect(await runPgeDump(root, { graphId: "toString" }, io)).toBe(EXIT_USAGE);
  });
});

// ── sc-2-4: dump --check ────────────────────────────────────────────

describe("bober pge dump --check", () => {
  it("exits 0 when the committed artifact matches the literal", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    const code = await runPgeDump(root, { check: true }, io);
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toContain("ok");
    expect(err).toEqual([]);
  });

  it("exits non-zero after a single-character mutation and does not repair the file", async () => {
    const path = topologyArtifactPath(root, "coding");
    await runPgeDump(root, {}, io);
    const original = await readFile(path, "utf8");

    const marker = '"graphId": "coding"';
    const at = original.indexOf(marker);
    expect(at).toBeGreaterThan(-1);
    const target = at + marker.length - 2;
    const mutated = `${original.slice(0, target)}G${original.slice(target + 1)}`;

    // Exactly one character differs.
    expect(mutated).toHaveLength(original.length);
    expect([...mutated].filter((c, i) => c !== original[i])).toHaveLength(1);

    await writeFile(path, mutated, "utf8");
    out = [];
    err = [];
    const code = await runPgeDump(root, { check: true }, io);
    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("out of date");
    // The drifted bytes survive: --check must never silently rewrite.
    expect(await readFile(path, "utf8")).toBe(mutated);
  });

  it("exits non-zero and writes nothing when the artifact is absent", async () => {
    const code = await runPgeDump(root, { check: true }, io);
    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("missing");
    await expect(readFile(topologyArtifactPath(root, "coding"), "utf8")).rejects.toThrow();
  });

  /**
   * Regression: an artifact that exists but cannot be read used to surface as
   * "Topology artifact missing: … Run `bober pge dump`", which is advice that cannot
   * work. It is now its own message and its own exit code.
   */
  it("reports an unreadable artifact as unreadable, not as missing", async () => {
    await mkdir(topologyArtifactPath(root, "coding"), { recursive: true });

    expect(await runPgeDump(root, { check: true }, io)).toBe(EXIT_USAGE);
    const text = err.join("\n");
    expect(text).toContain("could not be opened");
    expect(text).toContain("EISDIR");
    expect(text).not.toContain("Topology artifact missing");
    expect(text).not.toContain("Run `bober pge dump`");
  });
});

// ── sc-2-5: validate over every malformed fixture ───────────────────

describe("bober pge validate", () => {
  it("exits 0 for the committed artifact", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    const code = await runPgeValidate(root, {}, io);
    expect(code).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("ok");
    expect(err).toEqual([]);
  });

  it("exits 0 for the well-formed fixture", async () => {
    const code = await runPgeValidate(root, { file: join(FIXTURE_DIR, "valid.json") }, io);
    expect(code).toBe(EXIT_OK);
  });

  it("covers all 32 diagnostic codes with a fixture", () => {
    expect(DIAGNOSTIC_CODES).toHaveLength(32);
  });

  /**
   * The CLI's printed error lines, reduced to the set of diagnostic codes they name.
   *
   * Format is `error <Code>[ at <path>]: <message>` (`reportDiagnostics`); the trailing
   * `N error diagnostics (mode …)` summary carries no code and is excluded.
   */
  function printedErrorCodes(lines: string[]): string[] {
    const codes = lines
      .map((line) => /^error ([A-Za-z]+)(?: at [^:]*)?:/.exec(line))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => match[1]);
    return [...new Set(codes)].sort();
  }

  it.each(DIAGNOSTIC_CODES.map((code) => ({ code })))(
    "exits non-zero and prints EXACTLY that code for the $code fixture",
    async ({ code }) => {
      await seedPromptStore();
      const file = join(FIXTURE_DIR, `${code}.json`);
      const mode = FULL_MODE_CODES.has(code) ? ("full" as const) : ("structural" as const);
      const exit = await runPgeValidate(root, { file, mode }, io);
      expect(exit).toBe(EXIT_FAILED);
      // The EXACT set, not `toContain(code)`: a fixture that also tripped four unrelated
      // rules, or one whose code merely appeared inside another code's name, used to
      // pass this assertion.
      expect(printedErrorCodes(err)).toEqual([code]);
      expect(err.join("\n")).toContain("error diagnostic");
    },
  );

  it("the exact-set assertion rejects a run that names an extra code", async () => {
    // Guard on the guard: `printedErrorCodes` must not silently return [] (which would
    // make every `toEqual([code])` above fail) nor swallow a second code.
    expect(
      printedErrorCodes([
        "error DanglingEdge at edges.3.to: whatever",
        "error UnboundedCycle: whatever",
        "/tmp/x.json: 2 error diagnostics (mode structural).",
      ]),
    ).toEqual(["DanglingEdge", "UnboundedCycle"]);
  });

  it("does not fire the full-mode codes in structural mode", async () => {
    for (const code of FULL_MODE_CODES) {
      out = [];
      err = [];
      const exit = await runPgeValidate(root, { file: join(FIXTURE_DIR, `${code}.json`) }, io);
      expect(exit, `${code} in structural mode`).toBe(EXIT_OK);
    }
  });

  /**
   * The prompt-store contract, in three states. Previously the first state produced one
   * `UnknownPromptRef` per ref, which made `--mode full` red against any workspace that
   * simply has no prompt store — including this repository — and said nothing true: an
   * absent store is not evidence that a ref is wrong.
   */
  it("treats an ABSENT prompt store as a distinct non-error outcome, not as unknown refs", async () => {
    const file = join(FIXTURE_DIR, "UnknownPromptRef.json");
    const exit = await runPgeValidate(root, { file, mode: "full" }, io);

    expect(exit).toBe(EXIT_OK);
    expect(err.filter((line) => line.startsWith("error UnknownPromptRef"))).toEqual([]);
    // Silence would be worse than the false errors: the skip is stated.
    expect(out.join("\n")).toContain("PromptResolutionSkipped");
    expect(out.join("\n")).toContain(join(".bober", "prompts"));
    expect(out.join("\n")).toContain("prompt resolution skipped");
  });

  it("keeps UnknownPromptRef at full strength once the store EXISTS but is empty", async () => {
    const file = join(FIXTURE_DIR, "UnknownPromptRef.json");
    await mkdir(join(root, ".bober", "prompts"), { recursive: true });

    const exit = await runPgeValidate(root, { file, mode: "full" }, io);
    expect(exit).toBe(EXIT_FAILED);
    // An empty store resolves nothing, so BOTH refs are genuinely unknown.
    expect(err.filter((line) => line.startsWith("error UnknownPromptRef"))).toHaveLength(2);
    expect(err.join("\n")).toContain("planner/absent");
    expect(err.join("\n")).toContain("generator/sprint");
    expect(out.join("\n")).not.toContain("PromptResolutionSkipped");
  });

  it("resolves promptRefs against a populated on-disk prompt store in full mode", async () => {
    const file = join(FIXTURE_DIR, "UnknownPromptRef.json");
    await seedPromptStore();
    const withStore = await runPgeValidate(root, { file, mode: "full" }, io);
    expect(withStore).toBe(EXIT_FAILED);
    // Only the ref with no file behind it survives.
    expect(err.filter((line) => line.startsWith("error UnknownPromptRef"))).toHaveLength(1);
    expect(err.join("\n")).toContain("planner/absent");
    expect(err.join("\n")).not.toContain('"generator/sprint"');
  });

  it("returns the usage exit code for a missing file", async () => {
    const code = await runPgeValidate(root, { file: join(root, "nope.json") }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("Cannot read topology artifact");
  });

  it("returns the usage exit code for a file that is not JSON", async () => {
    const file = join(root, "bad.json");
    await writeFile(file, "{ nope", "utf8");
    const code = await runPgeValidate(root, { file }, io);
    expect(code).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("not valid JSON");
  });

  it("returns the usage exit code when the committed artifact has not been dumped", async () => {
    expect(await runPgeValidate(root, {}, io)).toBe(EXIT_USAGE);
  });

  it("returns the usage exit code for JSON that is not a topology at all", async () => {
    const file = join(root, "other.json");
    await writeFile(file, JSON.stringify({ hello: "world" }), "utf8");
    expect(await runPgeValidate(root, { file }, io)).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("not a topology artifact");
  });

  it("consults the prompt store for the shipped graph's own refs in full mode", async () => {
    const shippedRefs = CODING_GRAPH.nodes
      .map((n) => n.promptRef)
      .filter((r): r is string => r !== undefined);

    await runPgeDump(root, {}, io);
    out = [];
    err = [];

    // Store present but empty: every ref the shipped topology names is genuinely unknown.
    await mkdir(join(root, ".bober", "prompts"), { recursive: true });
    expect(await runPgeValidate(root, { mode: "full" }, io)).toBe(EXIT_FAILED);
    expect(err.filter((line) => line.startsWith("error UnknownPromptRef"))).toHaveLength(
      shippedRefs.length,
    );
    expect(err.join("\n")).toContain("planner/draft");

    // Store populated with exactly those refs: full mode is clean.
    out = [];
    err = [];
    for (const ref of shippedRefs) {
      const segments = ref.split("/");
      const dir = join(root, ".bober", "prompts", ...segments.slice(0, -1));
      await mkdir(dir, { recursive: true });
      await writeFile(join(dir, `${segments.at(-1) as string}.md`), `body for ${ref}\n`, "utf8");
    }
    expect(await runPgeValidate(root, { mode: "full" }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out.join("\n")).not.toContain("PromptResolutionSkipped");
  });

  /**
   * Regression for the shape guard: a document that is not topology-shaped used to
   * return before `TopologySpecSchema` ever saw it, so the verb printed a bare sentence
   * and not one diagnostic code. The schema now always runs.
   */
  it("still runs the schema on JSON that is not topology-shaped", async () => {
    const file = join(root, "shapeless.json");
    await writeFile(file, JSON.stringify({ graphId: "coding", edges: [] }), "utf8");

    expect(await runPgeValidate(root, { file }, io)).toBe(EXIT_USAGE);
    const text = err.join("\n");
    expect(text).toContain("not a topology artifact");
    // …and the real schema verdict is reported, not swallowed.
    expect(err.some((line) => line.startsWith("error "))).toBe(true);
    expect(text).toContain("nodes");
  });
});

// ── The full-mode schema catalog ────────────────────────────────────

describe("codingSchemaCatalog", () => {
  it("resolves every ref the shipped topology and the fixtures name", () => {
    const catalog = codingSchemaCatalog();
    for (const ref of ["GraphMessage", "Counters", "PlanSpec", "BranchStatus", "FeatureRequest"]) {
      expect(catalog.has(ref), ref).toBe(true);
    }
    expect(catalog.has("NoSuchSchema")).toBe(false);
    expect(catalog.isAssignable("PlanSpec", "PlanSpec")).toBe(true);
    expect(catalog.isAssignable("PlanSpec", "FeatureRequest")).toBe(false);
  });
});

// ── sc-2-7 + sc-2-9: hash ───────────────────────────────────────────

describe("bober pge hash", () => {
  it("prints the authored literal's checksum", async () => {
    const code = await runPgeHash(root, {}, io);
    expect(code).toBe(EXIT_OK);
    expect(out).toEqual([CODING_GRAPH.checksum]);
  });

  it("is unchanged by a prompt body edited under the prompt store", async () => {
    await seedPromptStore();
    expect(await runPgeHash(root, {}, io)).toBe(EXIT_OK);
    const before = out[0];

    const promptFile = join(root, ".bober", "prompts", "planner", "draft.md");
    await writeFile(
      promptFile,
      "COMPLETELY DIFFERENT PLANNER PROMPT — three paragraphs of new instructions.\n",
      "utf8",
    );
    expect(await readFile(promptFile, "utf8")).toContain("COMPLETELY DIFFERENT");

    out = [];
    expect(await runPgeHash(root, {}, io)).toBe(EXIT_OK);
    expect(out[0]).toBe(before);
    expect(out[0]).toBe(CODING_GRAPH.checksum);
  });

  it("changes when one edge is added to the literal", async () => {
    const mutated = clone(CODING_GRAPH);
    mutated.edges.push({
      id: "e-extra",
      from: "context_compact",
      to: "graceful_failure",
      kind: "normal",
    });
    mutated.checksum = checksumTopology(mutated);

    const file = join(root, "mutated.json");
    await writeFile(file, serializeTopology(mutated), "utf8");

    const code = await runPgeHash(root, { file }, io);
    expect(code).toBe(EXIT_OK);
    expect(out[0]).not.toBe(CODING_GRAPH.checksum);
    expect(out[0]).toBe(mutated.checksum);
  });

  it("reports ChecksumStale rather than silently passing a stale artifact", async () => {
    const stale = clone(CODING_GRAPH);
    stale.edges.push({
      id: "e-extra",
      from: "context_compact",
      to: "graceful_failure",
      kind: "normal",
    });
    // Deliberately NOT resealed: the stored checksum is now the pre-edit one.
    const file = join(root, "stale.json");
    await writeFile(file, serializeTopology(stale), "utf8");

    const code = await runPgeHash(root, { file }, io);
    expect(code).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("ChecksumStale");
    expect(out[0]).not.toBe(CODING_GRAPH.checksum);

    // …and `validate` names the same code for the same file.
    out = [];
    err = [];
    expect(await runPgeValidate(root, { file }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("ChecksumStale");
  });

  it("recomputes the committed artifact's checksum to the stored value", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    const code = await runPgeHash(root, { file: topologyArtifactPath(root, "coding") }, io);
    expect(code).toBe(EXIT_OK);
    expect(out[0]).toBe(CODING_GRAPH.checksum);
  });

  it("returns the usage exit code for an unknown graph and for a non-topology file", async () => {
    expect(await runPgeHash(root, { graphId: "nope" }, io)).toBe(EXIT_USAGE);
    const file = join(root, "not-a-topology.json");
    await writeFile(file, JSON.stringify({ hello: "world" }), "utf8");
    expect(await runPgeHash(root, { file }, io)).toBe(EXIT_USAGE);
    expect(await runPgeHash(root, { file: join(root, "absent.json") }, io)).toBe(EXIT_USAGE);
  });
});

// ── sc-2-8: a model-profile swap is not a structural change ─────────

describe("model profile swaps do not move the topology checksum", () => {
  /**
   * Two genuinely different model configurations for the same three roles, written as
   * the SHORTHANDS a user puts in bober.config.json. Nothing here names a resolved
   * model id: `resolveProviderModel` owns that table, and pinning `claude-opus-5` in a
   * topology test only guarantees this file breaks the next time the shorthand moves.
   */
  const PROFILE_A = { planner: "opus", generator: "sonnet", evaluator: "haiku" };
  const PROFILE_B = { planner: "gpt-4.1", generator: "gemini-pro", evaluator: "deepseek" };
  const ROLES = ["planner", "generator", "evaluator"] as const;

  /**
   * Write a config that the REAL loader accepts. The previous version of this test
   * wrote `project.mode: "cli"`, which `ProjectModeSchema` rejects — proof that nothing
   * ever loaded it, which is what made the config half of sc-2-8 inert.
   */
  async function writeConfig(profile: Record<string, string>): Promise<void> {
    await writeFile(
      join(root, "bober.config.json"),
      `${JSON.stringify(
        {
          project: { name: "pge-fixture", mode: "greenfield", stack: {} },
          planner: { model: profile.planner },
          generator: { model: profile.generator },
          evaluator: { model: profile.evaluator, strategies: [] },
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
  }

  /** The model each role actually binds to, taken through the real loader + resolver. */
  async function boundModels(): Promise<Record<string, string>> {
    const config = await loadConfig(root);
    return {
      planner: resolveProviderModel(config.planner.model).modelId,
      generator: resolveProviderModel(config.generator.model).modelId,
      evaluator: resolveProviderModel(config.evaluator.model).modelId,
    };
  }

  it("produces identical bytes and identical checksums under two model configurations", async () => {
    await writeConfig(PROFILE_A);
    expect(await runPgeDump(root, {}, io)).toBe(EXIT_OK);
    const underA = await readFile(topologyArtifactPath(root, "coding"), "utf8");
    const checksumA = out[0].split(" ").pop();
    // The swap is exercised, not merely written: the config on disk is loaded through
    // the real loader and its models resolved through the real resolver.
    const boundA = await boundModels();

    out = [];
    await writeConfig(PROFILE_B);
    expect(await runPgeDump(root, {}, io)).toBe(EXIT_OK);
    const underB = await readFile(topologyArtifactPath(root, "coding"), "utf8");
    const checksumB = out[0].split(" ").pop();
    const boundB = await boundModels();

    // Every role really did bind to a different model across the two dumps…
    for (const role of ROLES) {
      expect(boundA[role], `${role} resolved model`).not.toBe(boundB[role]);
    }
    // …and the topology did not move by one byte.
    expect(underB).toBe(underA);
    expect(checksumB).toBe(checksumA);
    expect(checksumA).toBe(CODING_GRAPH.checksum);
  });

  it("resolves genuinely different model ids for the two profiles", () => {
    for (const role of ROLES) {
      const a = resolveProviderModel(PROFILE_A[role]);
      const b = resolveProviderModel(PROFILE_B[role]);
      expect(a.modelId, `${role} profile A`).not.toBe(b.modelId);
      expect(a.provider === b.provider && a.modelId === b.modelId).toBe(false);
    }
  });

  it("records model TIERS, never resolved model ids, in the artifact", () => {
    const text = serializeTopology(CODING_GRAPH);
    // The forbidden strings are DERIVED from the resolver, so a new or renamed model id
    // is covered here the day it lands rather than the day someone remembers this list.
    const resolvedIds = [...Object.values(PROFILE_A), ...Object.values(PROFILE_B)].map(
      (shorthand) => resolveProviderModel(shorthand).modelId,
    );
    expect(new Set(resolvedIds).size).toBe(resolvedIds.length);
    for (const modelId of resolvedIds) {
      expect(text, `artifact leaks model id ${modelId}`).not.toContain(modelId);
    }
    const tiers = new Set(
      CODING_GRAPH.nodes.map((n) => n.modelTier).filter((t): t is string => t !== undefined),
    );
    expect(tiers).toEqual(new Set(["light", "frontier"]));
  });
});

// ── Sprint-3 derivations through the CLI ────────────────────────────

const FIXTURE_MERMAID = join(
  fileURLToPath(new URL("../../pge/topology/__fixtures__/", import.meta.url)),
  "coding.mermaid",
);

/** Write a topology to `<root>/<name>.json` and return its path. */
async function writeArtifact(name: string, spec: TopologySpec): Promise<string> {
  const path = join(root, `${name}.json`);
  await writeFile(path, serializeTopology(spec), "utf8");
  return path;
}

function reseal(spec: TopologySpec): TopologySpec {
  return { ...spec, checksum: checksumTopology(spec) };
}

/**
 * A version strictly ahead of the shipped graph's, DERIVED rather than written out: a
 * literal "1.1.0" silently stops testing a bump the moment the shipped graph reaches
 * that version.
 */
function bumpedVersion(from: string = CODING_GRAPH.graphVersion): string {
  const [major, minor] = from.split(".").map((part) => Number.parseInt(part, 10));
  return `${major}.${minor + 1}.0`;
}

function extraGate(id: string): NodeSpec {
  return {
    id,
    kind: "gate",
    title: `Gate ${id}`,
    doc: `A gate added by a CLI fixture: ${id}.`,
    subgraph: null,
    role: "utility",
    inputPorts: [],
    outputPorts: [],
    reads: [],
    writes: [],
    effects: [],
    gate: { check: "extra", onFail: "END" },
  };
}

/** A doc whose `pge:nodes` block documents exactly `ids`. */
function docFor(ids: readonly string[]): string {
  return [
    "# PGE graph",
    "",
    DOC_NODES_BEGIN,
    ...ids.map((id) => `- \`${id}\``),
    DOC_NODES_END,
    "",
  ].join("\n");
}

describe("bober pge render", () => {
  it("renders the COMMITTED artifact, byte-identical to the golden", async () => {
    expect(await runPgeDump(root, {}, io)).toBe(EXIT_OK);
    out = [];
    expect(await runPgeRender(root, { format: "mermaid" }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(`${out.join("\n")}\n`).toBe(await readFile(FIXTURE_MERMAID, "utf8"));
  });

  it("defaults to mermaid", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    expect(await runPgeRender(root, {}, io)).toBe(EXIT_OK);
    expect(out[0].startsWith("flowchart TD\n")).toBe(true);
  });

  it("renders dot with one node statement per node and one edge per edge", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    expect(await runPgeRender(root, { format: "dot" }, io)).toBe(EXIT_OK);
    const text = out[0];
    const nodes = text.split("\n").filter((line) => /^ {2}"[^"]+" \[/.test(line));
    const edges = text.split("\n").filter((line) => / -> /.test(line));
    expect(nodes).toHaveLength(CODING_GRAPH.nodes.length);
    expect(edges).toHaveLength(CODING_GRAPH.edges.length);
  });

  it("rejects an unknown format without reading anything", async () => {
    expect(await runPgeRender(root, { format: "svg" }, io)).toBe(EXIT_USAGE);
    expect(err[0]).toContain('Unknown render format "svg"');
    expect(out).toEqual([]);
  });

  it("reports a missing artifact as a usage error", async () => {
    expect(await runPgeRender(root, {}, io)).toBe(EXIT_USAGE);
    expect(err[0]).toContain("Cannot read topology artifact");
  });

  it("renders a named file instead of the committed artifact", async () => {
    const path = await writeArtifact("other", CODING_GRAPH);
    expect(await runPgeRender(root, { file: path, format: "mermaid" }, io)).toBe(EXIT_OK);
    expect(`${out[0]}\n`).toBe(renderTopology(CODING_GRAPH, "mermaid"));
  });
});

describe("bober pge diff", () => {
  it("emits empty:true and exit 0 for a file against itself", async () => {
    const path = await writeArtifact("a", CODING_GRAPH);
    expect(await runPgeDiff(root, { a: path, b: path }, io)).toBe(EXIT_OK);
    const diff = JSON.parse(out[0]) as TopologyDiff;
    expect(diff.empty).toBe(true);
    expect(err).toEqual([]);
  });

  it("emits empty:true for two files that differ only in key ordering", async () => {
    const a = await writeArtifact("ordered", CODING_GRAPH);
    // Reverse every top-level key AND every array — the same graph, written differently.
    const reordered = clone(CODING_GRAPH);
    reordered.nodes.reverse();
    reordered.edges.reverse();
    reordered.channels.reverse();
    const permuted: Record<string, unknown> = {};
    const source = reordered as unknown as Record<string, unknown>;
    for (const key of Object.keys(source).reverse()) permuted[key] = source[key];
    const b = join(root, "permuted.json");
    await writeFile(b, `${JSON.stringify(permuted, null, 2)}\n`, "utf8");

    expect(await readFile(a, "utf8")).not.toBe(await readFile(b, "utf8"));
    expect(await runPgeDiff(root, { a, b }, io)).toBe(EXIT_OK);
    expect((JSON.parse(out[0]) as TopologyDiff).empty).toBe(true);
  });

  it("reports exactly one added node and one added edge as structured JSON", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.nodes.push(extraGate("extra_gate"));
    head.edges.push({ id: "e-extra", from: "supervisor", to: "extra_gate", kind: "normal" });
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b }, io)).toBe(EXIT_OK);
    const diff = JSON.parse(out[0]) as TopologyDiff;
    expect(diff.empty).toBe(false);
    expect(diff.nodesAdded).toEqual(["extra_gate"]);
    expect(diff.edgesAdded).toEqual(["e-extra"]);
    expect(diff.nodesRemoved).toEqual([]);
    expect(diff.edgesRemoved).toEqual([]);
  });

  /**
   * REGRESSION. `empty` once consulted only nodes, edges, channels and router labels, so
   * a graph whose only change was WHICH NODE IT STARTS AT diffed empty and the CI gate
   * exited 0 on it. Re-pointing `entry` touches no node, edge or channel.
   */
  it("fails under --require-version-bump when the only change is the graph entry", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.entry = head.nodes.map((n) => n.id).find((id) => id !== CODING_GRAPH.entry) as string;
    expect(head.entry).not.toBe(CODING_GRAPH.entry);
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b, requireVersionBump: true }, io)).toBe(EXIT_FAILED);
    const diff = JSON.parse(out[0]) as TopologyDiff;
    expect(diff.empty).toBe(false);
    expect(diff.graphFieldsChanged).toEqual(["entry"]);
    expect(diff.nodesAdded).toEqual([]);
    expect(diff.edgesAdded).toEqual([]);
    expect(err.join("\n")).toContain("graphVersion did not move forward");
  });

  it("fails under --require-version-bump when the only change is defaults.supervisorNodeId", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.defaults = {
      ...head.defaults,
      supervisorNodeId: head.nodes
        .map((n) => n.id)
        .find((id) => id !== CODING_GRAPH.defaults.supervisorNodeId) as string,
    };
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b, requireVersionBump: true }, io)).toBe(EXIT_FAILED);
    expect((JSON.parse(out[0]) as TopologyDiff).graphFieldsChanged).toEqual(["defaults"]);
  });

  it("passes --require-version-bump when a graph-level change moved the version forward", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.entry = head.nodes.map((n) => n.id).find((id) => id !== CODING_GRAPH.entry) as string;
    head.graphVersion = bumpedVersion();
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b, requireVersionBump: true }, io)).toBe(EXIT_OK);
    const diff = JSON.parse(out[0]) as TopologyDiff;
    expect(diff.graphFieldsChanged).toEqual(["entry"]);
    expect(diff.graphVersion.bumped).toBe(true);
  });

  it("fails under --require-version-bump when the version did not move", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.nodes.push(extraGate("extra_gate"));
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b, requireVersionBump: true }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("graphVersion did not move forward");
  });

  it("passes under --require-version-bump when the version moved forward", async () => {
    const a = await writeArtifact("base", CODING_GRAPH);
    const head = clone(CODING_GRAPH);
    head.nodes.push(extraGate("extra_gate"));
    head.graphVersion = bumpedVersion();
    const b = await writeArtifact("head", reseal(head));

    expect(await runPgeDiff(root, { a, b, requireVersionBump: true }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
  });

  it("passes under --require-version-bump when nothing changed at all", async () => {
    const path = await writeArtifact("same", CODING_GRAPH);
    expect(await runPgeDiff(root, { a: path, b: path, requireVersionBump: true }, io)).toBe(
      EXIT_OK,
    );
  });

  it("reports an unreadable side as a usage error", async () => {
    const path = await writeArtifact("a", CODING_GRAPH);
    expect(await runPgeDiff(root, { a: path, b: join(root, "absent.json") }, io)).toBe(EXIT_USAGE);
    expect(err[0]).toContain("Cannot read topology artifact");
  });
});

describe("bober pge docs", () => {
  it("passes when the document names exactly the declared nodes", async () => {
    await runPgeDump(root, {}, io);
    const doc = join(root, "pge-graph.md");
    await writeFile(doc, docFor(CODING_GRAPH.nodes.map((n) => n.id)), "utf8");

    out = [];
    err = [];
    expect(await runPgeDocs(root, { doc }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
    expect(out[0]).toContain("ok");
  });

  it("fails and names an undocumented node", async () => {
    await runPgeDump(root, {}, io);
    const doc = join(root, "pge-graph.md");
    await writeFile(
      doc,
      docFor(CODING_GRAPH.nodes.map((n) => n.id).filter((id) => id !== "supervisor")),
      "utf8",
    );

    expect(await runPgeDocs(root, { doc }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain('node "supervisor" is declared in the topology');
  });

  it("fails and names a documented node that no longer exists", async () => {
    await runPgeDump(root, {}, io);
    const doc = join(root, "pge-graph.md");
    await writeFile(doc, docFor([...CODING_GRAPH.nodes.map((n) => n.id), "ghost_node"]), "utf8");

    expect(await runPgeDocs(root, { doc }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain('"ghost_node" is documented');
  });

  it("reports a missing document as a usage error", async () => {
    await runPgeDump(root, {}, io);
    expect(await runPgeDocs(root, { doc: join(root, "absent.md") }, io)).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("Cannot read documentation file");
  });
});

describe("bober pge audit-state", () => {
  it("writes .bober/topology/state-audit.json with a writer for every channel", async () => {
    await runPgeDump(root, {}, io);
    out = [];
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    expect(out[0]).toContain("wrote");

    const parsed = StateAuditSchema.parse(
      JSON.parse(await readFile(stateAuditPath(root), "utf8")) as unknown,
    );
    expect(parsed.generatedFrom.checksum).toBe(CODING_GRAPH.checksum);
    expect(parsed.keys).toHaveLength(CODING_GRAPH.channels.length);

    const declared = new Set(CODING_GRAPH.nodes.map((n) => n.id));
    for (const row of parsed.keys) {
      expect(row.writers.length, `channel "${row.key}" has no writer`).toBeGreaterThan(0);
      for (const id of [...row.writers, ...row.readers]) {
        expect(declared.has(id), `"${id}" is not a declared node`).toBe(true);
      }
    }
  });

  it("produces byte-identical output when run twice", async () => {
    await runPgeDump(root, {}, io);
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    const first = await readFile(stateAuditPath(root), "utf8");
    out = [];
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    expect(await readFile(stateAuditPath(root), "utf8")).toBe(first);
    expect(out[0]).toContain("unchanged");
  });

  /**
   * REGRESSION. The write path never applied `StateAuditSchema`, so an artifact with an
   * empty `reducerRef` — legal under `ChannelDeclSchema`, illegal under
   * `StateAuditKeySchema` — produced a committed `state-audit.json` that this very test
   * file's `StateAuditSchema.parse` throws on.
   */
  it("exits non-zero and writes nothing when the artifact audits to an invalid state audit", async () => {
    const spec = clone(CODING_GRAPH);
    const channel = spec.channels[0];
    if (!channel) throw new Error("fixture drift: no channels");
    channel.reducerRef = "";
    const path = await writeArtifact("empty-reducer", reseal(spec));

    expect(await runPgeAuditState(root, { file: path }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("StateAuditInvalid");
    expect(err.join("\n")).toContain(channel.id);
    expect(err.join("\n")).toContain("Refusing to write");
    await expect(readFile(stateAuditPath(root), "utf8")).rejects.toThrow(/ENOENT/);
  });

  it("--check fails when the audit is missing and passes once it is written", async () => {
    await runPgeDump(root, {}, io);
    expect(await runPgeAuditState(root, { check: true }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("State audit missing");

    err = [];
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    expect(await runPgeAuditState(root, { check: true }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
  });

  it("--check fails on a tampered audit and does not repair it", async () => {
    await runPgeDump(root, {}, io);
    await runPgeAuditState(root, {}, io);
    await writeFile(stateAuditPath(root), '{\n  "keys": []\n}\n', "utf8");

    expect(await runPgeAuditState(root, { check: true }, io)).toBe(EXIT_FAILED);
    expect(err.join("\n")).toContain("State audit out of date");
    expect(await readFile(stateAuditPath(root), "utf8")).toBe('{\n  "keys": []\n}\n');
  });

  it("reports a missing artifact as a usage error", async () => {
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_USAGE);
    expect(err[0]).toContain("Cannot read topology artifact");
  });
});

describe("bober pge optimize", () => {
  /** A candidate variant: the shipped graph with one gate removed and rewired. */
  function candidate(): TopologySpec {
    const spec = clone(CODING_GRAPH);
    spec.graphVersion = bumpedVersion();
    const node = spec.nodes.find((n) => n.id === "plan_draft");
    if (!node) throw new Error("fixture drift: no plan_draft node");
    node.promptRef = "planner/draft-v2";
    return reseal(spec);
  }

  it("records the variant under .bober/topology/variants/ and leaves the artifact alone", async () => {
    await runPgeDump(root, {}, io);
    const artifact = await readFile(topologyArtifactPath(root, "coding"), "utf8");
    const variantPath = await writeArtifact("candidate", candidate());

    out = [];
    expect(await runPgeOptimize(root, { variant: variantPath }, io)).toBe(EXIT_OK);
    expect(out.join("\n")).toContain("provenance=optimizer");
    expect(out.join("\n")).toContain("valid=true");
    expect(out.join("\n")).toContain("score=null");

    const files = await readdir(variantsDir(root));
    expect(files).toHaveLength(1);
    const record = VariantRecordSchema.parse(
      JSON.parse(await readFile(join(variantsDir(root), files[0]), "utf8")) as unknown,
    );
    expect(record.provenance).toBe("optimizer");
    expect(record.spec.provenance).toBe("optimizer");
    expect(record.baseChecksum).toBe(CODING_GRAPH.checksum);
    expect(record.score).toBeNull();
    expect(files[0]).toBe(`${record.variantId}.json`);

    // The committed artifact is untouched, so `dump --check` still passes.
    expect(await readFile(topologyArtifactPath(root, "coding"), "utf8")).toBe(artifact);
    err = [];
    expect(await runPgeDump(root, { check: true }, io)).toBe(EXIT_OK);
    expect(err).toEqual([]);
  });

  it("--no-write validates without recording anything", async () => {
    await runPgeDump(root, {}, io);
    const variantPath = await writeArtifact("candidate", candidate());

    expect(await runPgeOptimize(root, { variant: variantPath, write: false }, io)).toBe(EXIT_OK);
    await expect(readdir(variantsDir(root))).rejects.toThrow(/ENOENT/);
  });

  it("fails when the candidate does not validate, and still names the variant", async () => {
    await runPgeDump(root, {}, io);
    const broken = clone(CODING_GRAPH);
    broken.edges.push({ id: "e-dangling", from: "supervisor", to: "no_such_node", kind: "normal" });
    const variantPath = await writeArtifact("broken", reseal(broken));

    out = [];
    err = [];
    expect(await runPgeOptimize(root, { variant: variantPath }, io)).toBe(EXIT_FAILED);
    expect(out.join("\n")).toContain("valid=false");
    expect(err.join("\n")).toContain("DanglingEdge");
  });

  it("reports a missing candidate as a usage error", async () => {
    await runPgeDump(root, {}, io);
    expect(await runPgeOptimize(root, { variant: join(root, "absent.json") }, io)).toBe(EXIT_USAGE);
    expect(err.join("\n")).toContain("Cannot read topology artifact");
  });
});

// ── Commander wiring ────────────────────────────────────────────────

describe("registerPgeCommand", () => {
  function pgeCommand(): Command {
    const program = new Command();
    registerPgeCommand(program);
    const pge = program.commands.find((c) => c.name() === "pge");
    if (!pge) throw new Error("pge command was not registered");
    return pge;
  }

  it("registers exactly the shipped verbs", () => {
    expect(pgeCommand().commands.map((c) => c.name()).sort()).toEqual([
      "audit-state",
      "diff",
      "docs",
      "dump",
      "hash",
      "optimize",
      "render",
      "validate",
    ]);
  });

  it("registers every sprint-3 derivation, so all five are reachable from the CLI", () => {
    const names = new Set(pgeCommand().commands.map((c) => c.name()));
    for (const verb of ["render", "diff", "docs", "audit-state", "optimize"]) {
      expect(names.has(verb), `${verb} must be registered`).toBe(true);
    }
  });

  it("exposes the sprint-3 options each verb needs", () => {
    const commands = pgeCommand().commands;
    const render = commands.find((c) => c.name() === "render");
    const diff = commands.find((c) => c.name() === "diff");
    const auditState = commands.find((c) => c.name() === "audit-state");
    expect(render?.options.map((o) => o.long).sort()).toEqual(["--format", "--graph"]);
    expect(diff?.options.map((o) => o.long)).toEqual(["--require-version-bump"]);
    expect(auditState?.options.map((o) => o.long).sort()).toEqual([
      "--check",
      "--file",
      "--graph",
    ]);
  });

  it("does not collide with the code-graph `graph` namespace", () => {
    const program = new Command();
    registerPgeCommand(program);
    expect(program.commands.map((c) => c.name())).toEqual(["pge"]);
  });

  it("exposes --check on dump and --mode on validate", () => {
    const commands = pgeCommand().commands;
    const dump = commands.find((c) => c.name() === "dump");
    const validate = commands.find((c) => c.name() === "validate");
    expect(dump?.options.map((o) => o.long).sort()).toEqual(["--check", "--graph"]);
    expect(validate?.options.map((o) => o.long).sort()).toEqual(["--graph", "--mode"]);
  });
});
