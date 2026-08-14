import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { BoberConfigSchema } from "../../config/schema.js";
import type { BoberConfig } from "../../config/schema.js";
import { PgeEngine } from "../../pge/engine/pge-engine.js";
import { PIPELINE_ENGINE_NAMES } from "./engine.js";
import { resolveEngineName, selectPipelineEngine } from "./selector.js";
import { TsPipelineEngine } from "./ts-engine.js";

/**
 * sc-14-9 — the oracle is PROVABLY retained, not merely present.
 *
 * Sprint 13 compared the two real engines and reported `equivalent: false` with four
 * pinned divergences, so conformance did not converge and the plan's pre-authorised end
 * state applies: PGE stays opt-in, `pipeline.engine` keeps `"ts"` as its default and
 * `TsPipelineEngine` is retained permanently as the reference the graph engine is measured
 * against. That disposition is recorded in prose in `docs/pge-graph.md`; this file is the
 * part a future change cannot talk its way past.
 *
 * Three separable claims, asserted independently rather than through one another:
 *
 *  1. THE DEFAULT. `config.pipeline.engine` still parses to `"ts"` from an empty config,
 *     asserted against the schema rather than against any committed `bober.config.json` —
 *     a repository that had opted into `"pge"` locally must not be able to make this pass
 *     or fail.
 *  2. CONSTRUCTIBILITY. `new TsPipelineEngine()` still builds and still exposes the
 *     `PipelineEngine` surface, and the default config still SELECTS it. An engine that
 *     exists but is unreachable from selection is not an oracle.
 *  3. STILL EXERCISED. The conformance job still drives BOTH real engines. Removing
 *     `TsPipelineEngine` from `conformance.engines.test.ts`, or skipping that file, would
 *     leave the graph engine with nothing to be compared against while every other
 *     assertion here kept passing — so it is asserted directly, at the file.
 *
 * The engine run itself is NOT duplicated here. It is expensive and it is already pinned
 * in `conformance.engines.test.ts`; re-running it would buy a second copy of the same
 * evidence and a slower suite.
 */

const CONFORMANCE_TEST = fileURLToPath(
  new URL("./conformance.engines.test.ts", import.meta.url),
);
const PGE_ENGINE_SOURCE = fileURLToPath(
  new URL("../../pge/engine/pge-engine.ts", import.meta.url),
);

/**
 * The smallest config the schema accepts, with every optional key left out.
 *
 * Deliberately NOT the repository's own `bober.config.json`: a checkout that had opted
 * into `"pge"` locally must be unable to make these assertions pass or fail. What is under
 * test is the DEFAULT the schema installs when nobody chose.
 */
const MINIMAL_CONFIG = {
  project: { name: "oracle-retention", mode: "greenfield" },
  planner: {},
  generator: {},
  evaluator: { strategies: [] },
  sprint: {},
  pipeline: {},
  commands: {},
} as const;

function configWith(pipeline: Record<string, unknown>): BoberConfig {
  return BoberConfigSchema.parse({ ...MINIMAL_CONFIG, pipeline });
}

/** The minimal config, defaulted by the schema. Nothing on disk is consulted. */
function defaultedConfig(): BoberConfig {
  return configWith({});
}

// ── 1. The default ──────────────────────────────────────────────────

describe("sc-14-9: config.pipeline.engine still defaults to 'ts'", () => {
  it("defaults to 'ts' when the config says nothing at all", () => {
    expect(defaultedConfig().pipeline.engine).toBe("ts");
  });

  it("defaults to 'ts' when a pipeline section exists but names no engine", () => {
    expect(configWith({ maxSprintRetries: 2 }).pipeline.engine).toBe("ts");
  });

  it("still offers 'pge' as an explicit opt-in, so the default is a choice and not the only option", () => {
    expect([...PIPELINE_ENGINE_NAMES]).toContain("ts");
    expect([...PIPELINE_ENGINE_NAMES]).toContain("pge");
    expect(configWith({ engine: "pge" }).pipeline.engine).toBe("pge");
  });

  /**
   * NEGATIVE CONTROL for the assertion itself: it reads the schema's default rather than
   * accepting whatever it is handed. An explicit `"pge"` must NOT come back as `"ts"`, or
   * the three assertions above would pass on a schema whose default had moved.
   */
  it("does not report 'ts' for a config that asked for something else", () => {
    expect(configWith({ engine: "workflow" }).pipeline.engine).not.toBe("ts");
    expect(resolveEngineName(configWith({ engine: "pge" }))).toBe("pge");
  });
});

// ── 2. Constructibility, and reachability from selection ────────────

describe("sc-14-9: TsPipelineEngine is still constructible and still selected", () => {
  it("constructs and exposes the PipelineEngine surface", () => {
    const engine = new TsPipelineEngine();
    expect(engine).toBeInstanceOf(TsPipelineEngine);
    expect(typeof engine.run).toBe("function");
    expect(engine.name).toBe("ts");
  });

  it("is what the DEFAULT config selects", () => {
    // The seam, not the constructor: an oracle nothing routes to is not retained.
    expect(selectPipelineEngine(defaultedConfig())).toBeInstanceOf(TsPipelineEngine);
  });

  /** The opt-in really does reach the other engine, so the default is doing work. */
  it("is not what an explicit 'pge' config selects", () => {
    const engine = selectPipelineEngine(configWith({ engine: "pge" }));
    expect(engine).toBeInstanceOf(PgeEngine);
    expect(engine).not.toBeInstanceOf(TsPipelineEngine);
  });

  it("is the fallback the graph engine itself downgrades to", async () => {
    // PgeEngine.run catches a TopologyCompileError and re-dispatches the imperative
    // engine, so deleting TsPipelineEngine would also remove PGE's own safety net.
    const source = await readFile(PGE_ENGINE_SOURCE, "utf8");
    expect(source).toContain("TsPipelineEngine");
  });
});

// ── 3. Still exercised by the conformance job ───────────────────────

describe("sc-14-9: the oracle is still exercised by the conformance job", () => {
  it("conformance.engines.test.ts still constructs BOTH real engines", async () => {
    const source = await readFile(CONFORMANCE_TEST, "utf8");

    expect(source).toMatch(/new TsPipelineEngine\(\)/);
    expect(source).toMatch(/new PgeEngine\(/);
    expect(source).toContain("EngineConformanceHarness");
    // The comparison is between the two engines' outputs, so both runners are real.
    expect(source).toContain("assertEquivalent");
  });

  it("that file is not skipped, focused or emptied", async () => {
    const source = await readFile(CONFORMANCE_TEST, "utf8");

    // A skipped conformance file is a deleted conformance file with better optics.
    expect(source).not.toMatch(/\b(describe|it|test)\.skip\b/);
    expect(source).not.toMatch(/\b(describe|it|test)\.only\b/);
    expect(source).not.toMatch(/^\s*(describe|it|test)\.todo\b/m);
    expect([...source.matchAll(/^\s*it\(/gm)].length).toBeGreaterThanOrEqual(5);
  });

  it("still pins sprint 13's verdict, which is why the default has not moved", async () => {
    const source = await readFile(CONFORMANCE_TEST, "utf8");

    // The evidence the disposition in docs/pge-graph.md cites. If a future change makes
    // the engines equivalent, this assertion is the one that should be revisited FIRST —
    // deliberately, with the disposition — rather than the default quietly flipping.
    expect(source).toContain("report.equivalent");
    expect(source).toMatch(/expect\(report\.equivalent\)\.toBe\(false\)/);
    for (const field of ["history", "audits", "contracts", "pipelineResult"]) {
      expect(source, `the ${field} divergence is no longer pinned`).toContain(field);
    }
  });
});
