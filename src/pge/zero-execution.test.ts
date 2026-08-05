import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * sc-2-6 — `dump`, `validate` and `hash` must execute ZERO node bodies.
 *
 * Sprint 1 proved this at the module-graph level: an ESLint `no-restricted-imports`
 * boundary makes an executor unreachable from `src/pge/topology/**`. This file adds
 * the complementary BEHAVIOURAL assertion for the whole `bober pge` command path,
 * which is one level above that boundary and therefore not covered by it.
 *
 * The spy stands in for every route by which a node body could be reached before a
 * `NodeRegistry` exists:
 *
 *  - the orchestrator entry points that run agents (`pipeline`, `agentic-loop`,
 *    every agent module the pipeline dispatches),
 *  - every provider adapter (an LLM node body's only way to reach a model),
 *  - `execa` (a tool node body's only way to reach a process),
 *  - `globalThis.fetch` (the only remaining network primitive).
 *
 * Each mock factory RECORDS its own resolution and returns members that throw. A
 * factory only runs when its module is actually imported, so an empty recorder is a
 * genuine "nothing was ever looked up" assertion rather than a tautology — and if
 * something were looked up AND called, the throwing member fails the test loudly too.
 *
 * This file lives one directory ABOVE `src/pge/topology/`, exactly like
 * `eslint-boundary.test.ts`, because it must import the CLI — which the boundary
 * forbids inside the guarded subtree.
 */

const probe = vi.hoisted(() => {
  const lookups: string[] = [];
  const invocations: string[] = [];
  const executorModule = (name: string, members: readonly string[]): Record<string, unknown> => {
    lookups.push(name);
    const shape: Record<string, unknown> = {};
    for (const member of members) {
      shape[member] = (..._args: unknown[]) => {
        invocations.push(`${name}.${member}`);
        throw new Error(`node executor ${name}.${member} was invoked during topology production`);
      };
    }
    return shape;
  };
  return { lookups, invocations, executorModule };
});

vi.mock("../orchestrator/pipeline.js", () =>
  probe.executorModule("orchestrator/pipeline", ["runPipeline"]),
);
vi.mock("../orchestrator/agentic-loop.js", () =>
  probe.executorModule("orchestrator/agentic-loop", ["runAgenticLoop"]),
);
vi.mock("../orchestrator/generator-agent.js", () =>
  probe.executorModule("orchestrator/generator-agent", ["runGenerator"]),
);
vi.mock("../orchestrator/planner-agent.js", () =>
  probe.executorModule("orchestrator/planner-agent", ["runPlanner"]),
);
vi.mock("../orchestrator/evaluator-agent.js", () =>
  probe.executorModule("orchestrator/evaluator-agent", ["runEvaluatorAgent"]),
);
vi.mock("../orchestrator/documenter-agent.js", () =>
  probe.executorModule("orchestrator/documenter-agent", ["runDocumenter"]),
);
vi.mock("../orchestrator/code-reviewer-agent.js", () =>
  probe.executorModule("orchestrator/code-reviewer-agent", ["runCodeReviewer"]),
);
vi.mock("../providers/anthropic.js", () =>
  probe.executorModule("providers/anthropic", ["AnthropicProvider"]),
);
vi.mock("../providers/openai.js", () =>
  probe.executorModule("providers/openai", ["OpenAIProvider"]),
);
vi.mock("../providers/google.js", () =>
  probe.executorModule("providers/google", ["GoogleProvider"]),
);
vi.mock("../providers/factory.js", () =>
  probe.executorModule("providers/factory", ["createProvider"]),
);
vi.mock("execa", () => probe.executorModule("execa", ["execa", "execaCommand", "$"]));

// The CLI verbs and the topology layer are imported AFTER the mocks are declared;
// vi.mock is hoisted above these imports by the transform.
import { CODING_GRAPH } from "./topology/coding.graph.js";
import { DOC_NODES_BEGIN, DOC_NODES_END } from "./topology/docs.js";
import { serializeTopology, topologyArtifactPath } from "./topology/dump.js";
import { DIAGNOSTIC_CODES } from "./topology/validate.js";
import {
  runPgeAuditState,
  runPgeDiff,
  runPgeDocs,
  runPgeDump,
  runPgeHash,
  runPgeOptimize,
  runPgeRender,
  runPgeValidate,
} from "../cli/commands/pge.js";
import type { PgeIo } from "../cli/commands/pge.js";

const FIXTURE_DIR = fileURLToPath(new URL("./topology/__fixtures__/", import.meta.url));

/**
 * What the probe had recorded by the time this module finished loading — captured
 * BEFORE any `beforeEach` can clear it.
 *
 * The per-test reset is necessary (the probe-is-live test deliberately imports a mocked
 * module), but on its own it hid the most important reading of all: the static import
 * of `../cli/commands/pge.js` above runs every mock factory for every executor module
 * that import graph touches, and those lookups are recorded at module-load time. A
 * `beforeEach` that clears the array wipes exactly that evidence, so `lookups` would
 * read empty inside every test even if importing the CLI pulled in a provider.
 */
const IMPORT_TIME_LOOKUPS = [...probe.lookups];

let root = "";
const sink: PgeIo = { out: () => undefined, err: () => undefined };

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-pge-zeroexec-"));
  probe.lookups.length = 0;
  probe.invocations.length = 0;
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

/** One prompt file per promptRef the shipped graph names, so full mode resolves. */
async function seedCodingPromptStore(): Promise<void> {
  for (const node of CODING_GRAPH.nodes) {
    if (node.promptRef === undefined) continue;
    const segments = node.promptRef.split("/");
    const file = join(root, ".bober", "prompts", ...segments.slice(0, -1), `${segments.at(-1)}.md`);
    await mkdir(join(root, ".bober", "prompts", ...segments.slice(0, -1)), { recursive: true });
    await writeFile(file, `prompt body for ${node.promptRef}\n`, "utf8");
  }
}

describe("topology production executes no node", () => {
  /**
   * The reading the `beforeEach` reset used to destroy: importing the `bober pge`
   * command module must not resolve a single executor module. Asserted against the
   * snapshot taken at load time, so no test-scoped clearing can make it vacuous.
   */
  it("resolves no executor while merely IMPORTING the pge command module", () => {
    expect(IMPORT_TIME_LOOKUPS).toEqual([]);
  });

  it("looks up no executor across dump, validate and hash", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error("network access during topology production");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    await seedCodingPromptStore();

    try {
      expect(await runPgeDump(root, {}, sink)).toBe(0);
      expect(await runPgeDump(root, { check: true }, sink)).toBe(0);
      expect(await runPgeValidate(root, {}, sink)).toBe(0);
      expect(await runPgeValidate(root, { mode: "full" }, sink)).toBe(0);
      expect(await runPgeHash(root, {}, sink)).toBe(0);
      expect(await runPgeHash(root, { file: topologyArtifactPath(root, "coding") }, sink)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(probe.lookups).toEqual([]);
    expect(probe.invocations).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("looks up no executor while validating every malformed fixture", async () => {
    // The full-mode fixtures need a prompt store that EXISTS: an absent one is a
    // documented skip, not a verdict, so `UnknownPromptRef` would never fire.
    await mkdir(join(root, ".bober", "prompts", "generator"), { recursive: true });
    await writeFile(
      join(root, ".bober", "prompts", "generator", "sprint.md"),
      "generator sprint prompt\n",
      "utf8",
    );

    for (const code of DIAGNOSTIC_CODES) {
      const file = join(FIXTURE_DIR, `${code}.json`);
      const mode =
        code === "UnknownPromptRef" || code === "UnknownSchemaRef"
          ? ("full" as const)
          : ("structural" as const);
      const exit = await runPgeValidate(root, { file, mode }, sink);
      expect(exit, `${code} must fail validation`).toBe(1);
    }
    expect(probe.lookups).toEqual([]);
    expect(probe.invocations).toEqual([]);
  });

  it("looks up no executor on the failure paths", async () => {
    expect(await runPgeDump(root, { graphId: "nope" }, sink)).toBe(2);
    expect(await runPgeValidate(root, { file: join(root, "absent.json") }, sink)).toBe(2);

    const bad = join(root, "bad.json");
    await writeFile(bad, "{ not json", "utf8");
    expect(await runPgeValidate(root, { file: bad }, sink)).toBe(2);
    expect(await runPgeHash(root, { file: bad }, sink)).toBe(2);

    expect(probe.lookups).toEqual([]);
    expect(probe.invocations).toEqual([]);
  });

  it("proves the probe is live: importing a mocked executor records a lookup", async () => {
    expect(probe.lookups).toEqual([]);
    const mocked = (await import("../orchestrator/pipeline.js")) as unknown as {
      runPipeline: () => unknown;
    };
    expect(probe.lookups).toEqual(["orchestrator/pipeline"]);
    expect(() => mocked.runPipeline()).toThrow(/was invoked during topology production/);
    expect(probe.invocations).toEqual(["orchestrator/pipeline.runPipeline"]);
  });

  /**
   * sc-3-9 and the sprint-3 stop condition — every DERIVATION (render, diff, docs,
   * state audit, optimise) must also execute zero nodes. They are one level above the
   * module-graph boundary, exactly like dump/validate/hash, so they need the same
   * behavioural assertion.
   */
  it("looks up no executor across render, diff, docs, audit-state and optimize", async () => {
    const originalFetch = globalThis.fetch;
    const fetchSpy = vi.fn(() => {
      throw new Error("network access during topology production");
    });
    globalThis.fetch = fetchSpy as unknown as typeof globalThis.fetch;

    try {
      expect(await runPgeDump(root, {}, sink)).toBe(0);

      expect(await runPgeRender(root, { format: "mermaid" }, sink)).toBe(0);
      expect(await runPgeRender(root, { format: "dot" }, sink)).toBe(0);

      const artifact = topologyArtifactPath(root, "coding");
      expect(await runPgeDiff(root, { a: artifact, b: artifact }, sink)).toBe(0);

      const doc = join(root, "pge-graph.md");
      await writeFile(
        doc,
        [
          DOC_NODES_BEGIN,
          ...CODING_GRAPH.nodes.map((node) => `- \`${node.id}\``),
          DOC_NODES_END,
          "",
        ].join("\n"),
        "utf8",
      );
      expect(await runPgeDocs(root, { doc }, sink)).toBe(0);

      expect(await runPgeAuditState(root, {}, sink)).toBe(0);
      expect(await runPgeAuditState(root, { check: true }, sink)).toBe(0);

      const variant = join(root, "variant.json");
      await writeFile(variant, serializeTopology(CODING_GRAPH), "utf8");
      expect(await runPgeOptimize(root, { variant }, sink)).toBe(0);
    } finally {
      globalThis.fetch = originalFetch;
    }

    expect(probe.lookups).toEqual([]);
    expect(probe.invocations).toEqual([]);
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("writes only under .bober/topology and reads only topology data", async () => {
    expect(await runPgeDump(root, {}, sink)).toBe(0);
    const artifact = await readFile(topologyArtifactPath(root, "coding"), "utf8");
    expect(JSON.parse(artifact)).toMatchObject({ graphId: "coding", provenance: "authored" });
    expect(artifact).toContain(CODING_GRAPH.checksum);
    expect(probe.lookups).toEqual([]);
  });
});
