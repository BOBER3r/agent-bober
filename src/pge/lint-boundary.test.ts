import { describe, expect, it } from "vitest";
import { ESLint } from "eslint";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Negative lint tests for the ADR-2 module-graph boundary (eslint.config.js).
 *
 * G1 — "zero execution during topology production" — is a property of the module
 * graph, enforced by `no-restricted-imports`/`no-restricted-syntax` scoped to
 * `src/pge/topology/**` and `src/contracts/topology.ts`. A config that silently
 * stops matching is indistinguishable from a clean repository: `npm run lint`
 * passing proves only that no CURRENT file violates the rule, never that the rule
 * would reject a violating one.
 *
 * These tests lint violating sources through the real ESLint API against the real
 * `eslint.config.js`, so the boundary is PROVEN to fire. `lintText` resolves the
 * flat config from `filePath` without the file needing to exist on disk, which is
 * why no fixture is written into `src/` (a crashed run would otherwise leave a file
 * behind that breaks `npm run lint` for everyone).
 *
 * Regression: sprint-2 review, blocking finding 1 — `import { execa } from "execa"`
 * inside `src/pge/topology/**` linted clean, as did `src/graph/**`,
 * `src/discovery/**` and every dynamic `import()`.
 */

// ── Harness ─────────────────────────────────────────────────────────

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

/** A path inside the guarded subtree. The file is never created; `lintText` only
 * uses it to select the matching flat-config block. */
const GUARDED = join(REPO_ROOT, "src/pge/topology/__boundary_probe__.ts");

/** A path OUTSIDE the guarded subtree, used to prove the rule is scoped rather
 * than repo-wide (otherwise the whole repository would fail to lint). */
const UNGUARDED = join(REPO_ROOT, "src/orchestrator/__boundary_probe__.ts");

const eslint = new ESLint({ cwd: REPO_ROOT });

async function lint(source: string, filePath: string): Promise<ESLint.LintResult> {
  const results = await eslint.lintText(source, { filePath, warnIgnored: false });
  const result = results[0];
  if (!result) throw new Error(`eslint returned no result for ${filePath}`);
  return result;
}

/** Rule ids of the ERROR-severity boundary messages, so an unrelated warning
 * (e.g. no-explicit-any) can never make a negative test pass. */
async function boundaryErrors(source: string, filePath = GUARDED): Promise<string[]> {
  const result = await lint(source, filePath);
  return result.messages
    .filter((m) => m.severity === 2)
    .map((m) => m.ruleId ?? "<fatal>")
    .filter((id) => id === "no-restricted-imports" || id === "no-restricted-syntax");
}

// ── The process-spawning sources the boundary must reject ───────────

/**
 * Each entry is a source the topology layer must not be able to author. `execa`
 * heads the list because it is the repository's actual process spawner
 * (package.json dependency) and was the hole: the boundary blocked
 * `node:child_process` while every real caller in this repo uses `execa`.
 */
const MUST_REJECT: Array<{ name: string; source: string }> = [
  { name: "execa (named)", source: `import { execa } from "execa";\nexport const x = execa;\n` },
  { name: "execa (default)", source: `import execa from "execa";\nexport const x = execa;\n` },
  {
    name: "execa subpath",
    source: `import { execaNode } from "execa/types";\nexport const x = execaNode;\n`,
  },
  {
    name: "node:child_process",
    source: `import { spawn } from "node:child_process";\nexport const x = spawn;\n`,
  },
  { name: "child_process", source: `import { spawn } from "child_process";\nexport const x = spawn;\n` },
  {
    name: "node:worker_threads",
    source: `import { Worker } from "node:worker_threads";\nexport const x = Worker;\n`,
  },
  { name: "node:vm", source: `import vm from "node:vm";\nexport const x = vm;\n` },
  { name: "node:cluster", source: `import cluster from "node:cluster";\nexport const x = cluster;\n` },
  { name: "cross-spawn", source: `import spawn from "cross-spawn";\nexport const x = spawn;\n` },
  {
    name: "node:module createRequire",
    source: `import { createRequire } from "node:module";\nexport const x = createRequire;\n`,
  },
  {
    name: "src/graph/** (spawns via execa)",
    source: `import { runGraphCommand } from "../../graph/cli.js";\nexport const x = runGraphCommand;\n`,
  },
  {
    name: "src/discovery/** (spawns via execa)",
    source: `import { scanRepository } from "../../discovery/scanner.js";\nexport const x = scanRepository;\n`,
  },
  {
    name: "orchestrator",
    source: `import { runPipeline } from "../../orchestrator/pipeline.js";\nexport const x = runPipeline;\n`,
  },
  {
    name: "providers",
    source: `import { createProvider } from "../../providers/factory.js";\nexport const x = createProvider;\n`,
  },
  { name: "cli", source: `import { runPge } from "../../cli/commands/pge.js";\nexport const x = runPge;\n` },
  { name: "root barrel", source: `import * as bober from "../../index.js";\nexport const x = bober;\n` },
  { name: "utils/git", source: `import { gitStatus } from "../../utils/git.js";\nexport const x = gitStatus;\n` },
  {
    name: "dynamic import of node:child_process",
    source: `export async function leak() {\n  return await import("node:child_process");\n}\n`,
  },
  {
    name: "dynamic import of execa",
    source: `export async function leak() {\n  return await import("execa");\n}\n`,
  },
  {
    name: "dynamic import of the orchestrator",
    source: `export async function leak() {\n  return await import("../../orchestrator/pipeline.js");\n}\n`,
  },
  {
    name: "dynamic import behind a computed specifier",
    source: `export async function leak(name: string) {\n  return await import(name);\n}\n`,
  },
];

describe("ADR-2 module-graph boundary — src/pge/topology/**", () => {
  it.each(MUST_REJECT)("rejects $name", async ({ source }) => {
    const errors = await boundaryErrors(source);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("rejects execa specifically, which the process-spawn group must name", async () => {
    const result = await lint(`import { execa } from "execa";\nexport const x = execa;\n`, GUARDED);
    const message = result.messages.find((m) => m.ruleId === "no-restricted-imports");
    expect(message?.severity).toBe(2);
    expect(message?.message).toContain("execa");
  });

  it("rejects dynamic import() via no-restricted-syntax, which no-restricted-imports cannot see", async () => {
    const source = `export async function leak() {\n  return await import("execa");\n}\n`;
    const errors = await boundaryErrors(source);
    expect(errors).toContain("no-restricted-syntax");
  });

  it("guards src/contracts/topology.ts, the layer's shared root, on the same terms", async () => {
    const contractsPath = join(REPO_ROOT, "src/contracts/topology.ts");
    const result = await lint(`import { execa } from "execa";\nexport const x = execa;\n`, contractsPath);
    const errors = result.messages.filter((m) => m.severity === 2 && m.ruleId === "no-restricted-imports");
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does NOT apply outside the guarded subtree, so the rule is scoped and not repo-wide", async () => {
    const errors = await boundaryErrors(`import { execa } from "execa";\nexport const x = execa;\n`, UNGUARDED);
    expect(errors).toEqual([]);
  });

  it("allows the imports the topology layer legitimately needs", async () => {
    const source = [
      `import type { TopologySpec } from "../../contracts/topology.js";`,
      `import { checksumTopology } from "./canonical.js";`,
      `import { readFile } from "node:fs/promises";`,
      `import { createHash } from "node:crypto";`,
      `import { join } from "node:path";`,
      `export const x = { checksumTopology, readFile, createHash, join };`,
      `export type Y = TopologySpec;`,
      ``,
    ].join("\n");
    const errors = await boundaryErrors(source);
    expect(errors).toEqual([]);
  });
});

/**
 * The spawner boundary on node BODIES — the enforcement behind the `sandbox-exec` tag.
 *
 * The topology's `sandbox-exec` effect asserts that a node's process execution goes
 * through `SandboxRunner`. Nothing in the type system ties the tag to the runner, so this
 * boundary is what makes the assertion true: with it, the only outbound execution route
 * from a production node body is `../runtime/sandbox.js`. Same reasoning as above — `npm
 * run lint` passing proves only that no current file violates the rule, so the rule is
 * proven to FIRE here rather than assumed.
 */

/** A production node body: inside the guarded fileset. */
const NODE_BODY = join(REPO_ROOT, "src/pge/nodes/__boundary_probe__.ts");
/** A node TEST: deliberately exempted, because tests spawn real children on purpose. */
const NODE_TEST = join(REPO_ROOT, "src/pge/nodes/__boundary_probe__.test.ts");

/**
 * The SPAWNER subset of {@link MUST_REJECT}.
 *
 * Deliberately narrower than the topology list: this boundary is about HOW a node body
 * reaches a process, not about which layers it may see. A node body legitimately imports
 * the orchestrator, a provider adapter and `../../utils/git.js` (the commit body does, and
 * its node declares the gated `git` effect for exactly that reason), so listing those here
 * would assert something false.
 */
const MUST_REJECT_SPAWNERS: Array<{ name: string; source: string }> = MUST_REJECT.filter(
  ({ name }) =>
    /execa|child_process|worker_threads|node:vm|node:cluster|cross-spawn|createRequire/.test(
      name,
    ) || name === "dynamic import behind a computed specifier",
);

describe("spawner boundary — src/pge/nodes/** (the sandbox-exec guarantee)", () => {
  it("covers every spawning source the topology list names", () => {
    // A filter that silently stopped matching would make the it.each below vacuous.
    expect(MUST_REJECT_SPAWNERS.length).toBeGreaterThanOrEqual(11);
  });

  it.each(MUST_REJECT_SPAWNERS)("rejects $name in a node body", async ({ source }) => {
    const errors = await boundaryErrors(source, NODE_BODY);
    expect(errors.length).toBeGreaterThan(0);
  });

  it("does NOT restrict the layers a node body legitimately depends on", async () => {
    // The commit node body imports utils/git; node bodies read orchestrator types. This
    // boundary is about the spawner, and over-reaching would break the layer it guards.
    const source = [
      `import { gitStatus } from "../../utils/git.js";`,
      `export const x = gitStatus;`,
      ``,
    ].join("\n");
    const errors = await boundaryErrors(source, NODE_BODY);
    expect(errors).toEqual([]);
  });

  it("rejects execa, this repo's actual spawner, with a message naming the sandbox", async () => {
    const result = await lint(
      `import { execa } from "execa";\nexport const x = execa;\n`,
      NODE_BODY,
    );
    const message = result.messages.find((m) => m.ruleId === "no-restricted-imports");
    expect(message?.severity).toBe(2);
    expect(message?.message).toContain("SandboxRunner");
  });

  it("rejects dynamic import(), which no-restricted-imports cannot see", async () => {
    const source = `export async function leak() {\n  return await import("execa");\n}\n`;
    const errors = await boundaryErrors(source, NODE_BODY);
    expect(errors).toContain("no-restricted-syntax");
  });

  it("exempts node tests, which legitimately spawn children and use dynamic import()", async () => {
    // Not a weakening: the effect tag is declared by the production body, so that is what
    // the boundary must bind. src/pge/nodes/research.test.ts imports node:child_process and
    // several node tests use dynamic import(); without this exemption `npm run lint` would
    // go red on files that are allowed to do exactly that.
    const errors = await boundaryErrors(
      `import { spawn } from "node:child_process";\nexport const x = spawn;\n`,
      NODE_TEST,
    );
    expect(errors).toEqual([]);
  });

  it("allows the sandbox runner itself, which is the sanctioned route", async () => {
    const source = [
      `import { createSandboxRunner } from "../runtime/sandbox.js";`,
      `import type { SandboxOutcome } from "../runtime/sandbox.js";`,
      `export const x = createSandboxRunner;`,
      `export type Y = SandboxOutcome;`,
      ``,
    ].join("\n");
    const errors = await boundaryErrors(source, NODE_BODY);
    expect(errors).toEqual([]);
  });
});
