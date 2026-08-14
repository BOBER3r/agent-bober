import { fileURLToPath } from "node:url";
import { execa } from "execa";
import { describe, expect, it } from "vitest";

/**
 * sc-1-9 — the module-graph boundary must be REAL, not aspirational.
 *
 * Each case is fed to the project's own ESLint binary with the project's own flat
 * config, under a virtual file path inside `src/pge/topology/`. `--stdin` means
 * nothing is written to the source tree, but the config resolution, the rule set and
 * the exit code are exactly the ones `npm run lint` produces for a real file at that
 * path.
 *
 * This file deliberately lives one directory ABOVE the boundary it guards: spawning a
 * process is exactly what `src/pge/topology/**` must never do, so keeping the `execa`
 * import out of that subtree leaves its import graph reachable only to `zod`,
 * `node:crypto`, `src/contracts/topology.ts` and its own siblings.
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const ESLINT_BIN = fileURLToPath(new URL("../../node_modules/eslint/bin/eslint.js", import.meta.url));

const PROBE_PATH = "src/pge/topology/__boundary_probe__.test.ts";
const OUTSIDE_PATH = "src/pge/__outside_probe__.test.ts";
/** The layer's shared root: imported by every file in the guarded subtree. */
const SHARED_ROOT_PATH = "src/contracts/topology.ts";

interface LintOutcome {
  exitCode: number;
  messages: Array<{ ruleId: string | null; message: string }>;
}

async function lint(source: string, filePath: string): Promise<LintOutcome> {
  const result = await execa(
    process.execPath,
    [ESLINT_BIN, "--stdin", "--stdin-filename", filePath, "--format", "json"],
    { cwd: REPO_ROOT, input: source, reject: false },
  );
  const parsed = JSON.parse(String(result.stdout).trim()) as Array<{
    messages: Array<{ ruleId: string | null; message: string }>;
  }>;
  return {
    exitCode: result.exitCode ?? -1,
    messages: parsed.flatMap((r) => r.messages),
  };
}

function restrictedImportMessages(outcome: LintOutcome): string[] {
  return outcome.messages
    .filter((m) => m.ruleId === "no-restricted-imports")
    .map((m) => m.message);
}

const forbidden: Array<{ label: string; specifier: string }> = [
  { label: "src/pge/runtime/", specifier: "../runtime/interpreter.js" },
  { label: "src/pge/nodes/", specifier: "../nodes/llm.js" },
  { label: "src/pge/registry/", specifier: "../registry/nodes.js" },
  { label: "src/pge/engine/", specifier: "../engine/pge-engine.js" },
  { label: "src/pge/compile/", specifier: "../compile/compiler.js" },
  { label: "src/orchestrator/", specifier: "../../orchestrator/pipeline.js" },
  { label: "src/providers/", specifier: "../../providers/anthropic.js" },
  // Bypass vectors found in review: the root barrel re-exports the orchestrator
  // pipeline and every provider adapter, and node:child_process would let the layer
  // spawn an executor without importing one.
  { label: "the root barrel (src/index.ts)", specifier: "../../index.js" },
  { label: "node:child_process", specifier: "node:child_process" },
  { label: "child_process (bare)", specifier: "child_process" },
  { label: "node:worker_threads", specifier: "node:worker_threads" },
  { label: "src/utils/git.js", specifier: "../../utils/git.js" },
  { label: "src/fleet/", specifier: "../../fleet/manifest.js" },
  { label: "src/mcp/", specifier: "../../mcp/server.js" },
  { label: "src/cli/", specifier: "../../cli/index.js" },
];

/** The same boundary must hold for the layer's shared root, not only the subtree. */
const forbiddenAtSharedRoot: Array<{ label: string; specifier: string }> = [
  { label: "src/orchestrator/", specifier: "../orchestrator/pipeline.js" },
  { label: "src/providers/", specifier: "../providers/anthropic.js" },
  { label: "the root barrel (src/index.ts)", specifier: "../index.js" },
  { label: "node:child_process", specifier: "node:child_process" },
];

describe("src/pge/topology ESLint boundary", () => {
  it.each(forbidden)(
    "makes lint exit non-zero for a test file importing $label",
    async ({ specifier }) => {
      const source = `import { thing } from "${specifier}";\nexport const used = thing;\n`;
      const outcome = await lint(source, PROBE_PATH);
      expect(outcome.exitCode).toBe(1);
      const restricted = restrictedImportMessages(outcome);
      expect(restricted).toHaveLength(1);
      expect(restricted[0]).toContain(specifier);
      expect(restricted[0]).toContain("module-graph boundary");
    },
    120_000,
  );

  it.each(forbiddenAtSharedRoot)(
    "makes lint exit non-zero for src/contracts/topology.ts importing $label",
    async ({ specifier }) => {
      const source = `import { thing } from "${specifier}";\nexport const used = thing;\n`;
      const outcome = await lint(source, SHARED_ROOT_PATH);
      expect(outcome.exitCode).toBe(1);
      const restricted = restrictedImportMessages(outcome);
      expect(restricted).toHaveLength(1);
      expect(restricted[0]).toContain(specifier);
      expect(restricted[0]).toContain("module-graph boundary");
    },
    120_000,
  );

  it(
    "leaves the shared root's legitimate imports clean",
    async () => {
      const source = 'import { z } from "zod";\nexport const used = z;\n';
      const outcome = await lint(source, SHARED_ROOT_PATH);
      expect(restrictedImportMessages(outcome)).toEqual([]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );

  it(
    "allows the imports the topology layer legitimately needs",
    async () => {
      const source = [
        'import { createHash } from "node:crypto";',
        'import { z } from "zod";',
        'import { TopologySpecSchema } from "../../contracts/topology.js";',
        'import { canonicalize } from "./canonical.js";',
        "export const used = [createHash, z, TopologySpecSchema, canonicalize];",
      ].join("\n");
      const outcome = await lint(source, PROBE_PATH);
      expect(restrictedImportMessages(outcome)).toEqual([]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );

  it(
    "scopes the restriction to src/pge/topology and does not leak to sibling directories",
    async () => {
      const source = 'import { thing } from "../orchestrator/pipeline.js";\nexport const used = thing;\n';
      const outcome = await lint(source, OUTSIDE_PATH);
      expect(restrictedImportMessages(outcome)).toEqual([]);
      expect(outcome.exitCode).toBe(0);
    },
    120_000,
  );
});
