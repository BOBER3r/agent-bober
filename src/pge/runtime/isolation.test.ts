import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import * as archiveModule from "./archive.js";
import * as cacheModule from "./cache.js";
import * as ledgerModule from "./ledger.js";
import * as sandboxModule from "./sandbox.js";
import * as scratchModule from "./scratch.js";
import * as traceModule from "./trace.js";
import { ARCHIVE_BRANCH_SEPARATOR, createArchiveWriter } from "./archive.js";
import { cacheKey, createSemanticCache } from "./cache.js";
import { createBudgetLedger } from "./ledger.js";
import { createSandboxPolicy, createSandboxRunner, sandboxEnvFromProcess } from "./sandbox.js";
import { createScratchStore } from "./scratch.js";
import { createTraceWriter } from "./trace.js";

/**
 * sc-6-10, sc-6-11 — the two cross-cutting guarantees of this directory.
 *
 * 1. NO SINGLETONS. `runInWorktree` substitutes `projectRoot` for a whole run
 *    (`src/orchestrator/worktree.ts`), so a store captured at module load would write a
 *    worktree run's artifacts into the original checkout — and the worktree is deleted on
 *    success, which is how that becomes data loss rather than a stray file. Every service
 *    therefore takes `projectRoot` as its first required argument, and no module here
 *    exports a live instance.
 *
 * 2. NOT VERSION-CONTROLLED. The directories these services create are ignored by git in
 *    the same change that creates them.
 */

const REPO_ROOT = fileURLToPath(new URL("../../../", import.meta.url));

let rootA = "";
let rootB = "";

beforeEach(async () => {
  rootA = await mkdtemp(join(tmpdir(), "bober-pge-rootA-"));
  rootB = await mkdtemp(join(tmpdir(), "bober-pge-rootB-"));
});

afterEach(async () => {
  await archiveModule.restoreWritableTree(rootA);
  await rm(rootA, { recursive: true, force: true });
  await rm(rootB, { recursive: true, force: true });
});

/** Every path under `dir`, relative and sorted. Missing directories read as empty. */
async function walk(dir: string, prefix = ""): Promise<string[]> {
  let names: string[];
  try {
    names = await readdir(dir, { withFileTypes: true }).then((entries) =>
      entries.map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)),
    );
  } catch {
    return [];
  }
  const found: string[] = [];
  for (const name of names.sort()) {
    const rel = prefix + name;
    found.push(rel);
    if (name.endsWith("/")) found.push(...(await walk(join(dir, name.slice(0, -1)), rel)));
  }
  return found;
}

describe("no module-level singletons (sc-6-11)", () => {
  const modules: Array<[string, Record<string, unknown>]> = [
    ["scratch", scratchModule as unknown as Record<string, unknown>],
    ["archive", archiveModule as unknown as Record<string, unknown>],
    ["cache", cacheModule as unknown as Record<string, unknown>],
    ["trace", traceModule as unknown as Record<string, unknown>],
    ["ledger", ledgerModule as unknown as Record<string, unknown>],
    ["sandbox", sandboxModule as unknown as Record<string, unknown>],
  ];

  it("exports no object carrying behaviour — only factories, classes and frozen data", () => {
    for (const [name, module] of modules) {
      for (const [exportName, value] of Object.entries(module)) {
        if (typeof value !== "object" || value === null) continue;
        if (Array.isArray(value)) continue;
        // Zod schemas are data descriptions, not instances with state.
        if ("_def" in (value as Record<string, unknown>)) continue;

        const methods = Object.entries(value as Record<string, unknown>)
          .filter(([, member]) => typeof member === "function")
          .map(([member]) => member);
        expect(methods, `${name}.${exportName} must not be a live instance`).toEqual([]);
      }
    }
  });

  it("names no export that looks like a constructed store", () => {
    const forbidden = /^(scratchStore|archiveWriter|semanticCache|traceWriter|budgetLedger|sandboxRunner|defaultStore|instance|singleton)$/i;
    for (const [name, module] of modules) {
      for (const exportName of Object.keys(module)) {
        expect(forbidden.test(exportName), `${name}.${exportName}`).toBe(false);
      }
    }
  });

  it("every filesystem service requires projectRoot as its first argument", () => {
    // Arity counts the parameters BEFORE the first defaulted one, so this is exactly
    // "how many arguments are mandatory".
    expect(createScratchStore.length).toBe(1);
    expect(createArchiveWriter.length).toBe(1);
    // projectRoot FIRST, then the run whose `scope: "run"` entries it namespaces — a
    // cache with no runId could only serve every run from one directory.
    expect(createSemanticCache.length).toBe(2);
    expect(createTraceWriter.length).toBe(2); // projectRoot, runId
    expect(createSandboxRunner.length).toBe(3); // projectRoot, runId, trace

    // The ledger writes no files and therefore takes no root — see `ledger.test.ts`,
    // which asserts it touches the filesystem not at all.
    expect(createBudgetLedger.length).toBe(0);
  });

  it("two stores built from two roots do not share state", async () => {
    const a = createScratchStore(rootA);
    const b = createScratchStore(rootB);
    expect(a.root()).not.toBe(b.root());
    expect(a.root()).toBe(join(rootA, ".bober", "scratch"));

    const ref = await a.put("run-1", "document", "only in A");
    await expect(b.get(ref)).rejects.toThrow();
    expect(await a.text(ref)).toBe("only in A");
  });
});

describe("a worktree-style run writes only under the root it was given (sc-6-11)", () => {
  it("leaves zero files under the root that was not passed", async () => {
    const before = await walk(rootB);
    expect(before).toEqual([]);

    // Everything a node execution touches, all constructed with rootA only.
    const scratch = createScratchStore(rootA);
    const archive = createArchiveWriter(rootA);
    const cache = createSemanticCache(rootA, "run-worktree");
    const trace = await createTraceWriter(rootA, "run-worktree");
    const ledger = createBudgetLedger();
    const runner = createSandboxRunner(rootA, "run-worktree", trace);

    const ref = await scratch.put("run-worktree", "diff", "--- a\n+++ b\n");
    const handle = await archive.open("run-worktree", "sprint_generate", "sprint-1");
    await handle.writeSnapshot({ ref });
    await handle.appendStdout("building\n");
    await handle.writeOutputs({ ok: true });
    await handle.seal();

    const parts = {
      systemPrompt: "s",
      userPrompt: "u",
      contextFilesHash: "h",
      model: "m",
      temperature: 0,
      toolsMask: "t",
    };
    await cache.put(cacheKey(parts), { cached: true }, 60, 0, parts);

    ledger.charge({ nodeId: "sprint_generate", attempt: 0, callIndex: 0 }, {
      calls: 1,
      tokensIn: 10,
      tokensOut: 5,
      costUsd: 0.5,
    });

    const outcome = await runner.run(
      process.execPath,
      ["-e", "process.stdout.write('worktree run')"],
      createSandboxPolicy({
        cwd: rootA,
        allowBinaries: ["node"],
        env: sandboxEnvFromProcess(),
      }),
      scratch,
    );
    expect(outcome.status).toBe("ok");
    await trace.close();

    // rootA received everything...
    const written = await walk(rootA);
    expect(written).toContain(".bober/");
    expect(written.some((p) => p.startsWith(".bober/scratch/run-worktree/"))).toBe(true);
    expect(written).toContain(
      `.bober/archive/run-worktree/sprint_generate${ARCHIVE_BRANCH_SEPARATOR}sprint-1/.sealed`,
    );
    expect(written).toContain(".bober/traces/run-worktree.jsonl");
    // The default `scope: "run"` namespace, under this run's id and no other.
    expect(written.some((p) => p.startsWith(".bober/cache/runs/run-worktree/"))).toBe(true);

    // ...and rootB is untouched. Not "mostly untouched": byte-for-byte the same listing.
    expect(await walk(rootB)).toEqual(before);
  });
});

describe("runtime directories are git-ignored (sc-6-10)", () => {
  it(".gitignore carries an entry for every directory these services create", async () => {
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf8");
    const lines = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));

    for (const entry of [
      ".bober/scratch/",
      ".bober/traces/",
      ".bober/cache/",
      ".bober/archive/",
      ".bober/logs/",
    ]) {
      expect(lines, `${entry} must be git-ignored`).toContain(entry);
    }
  });

  it("the ignored entries match the directories the services actually write", async () => {
    const scratch = createScratchStore(rootA);
    const archive = createArchiveWriter(rootA);
    const cache = createSemanticCache(rootA, "run-paths");
    const trace = await createTraceWriter(rootA, "run-paths");

    expect(scratch.root()).toBe(join(rootA, ".bober", "scratch"));
    expect(archive.root()).toBe(join(rootA, ".bober", "archive"));
    expect(cache.root()).toBe(join(rootA, ".bober", "cache"));
    expect(trace.path()).toBe(join(rootA, ".bober", "traces", "run-paths.jsonl"));
    await trace.close();

    // `.bober/topology/` is NOT in this list: it is the one PGE directory that is
    // version-controlled, and ignoring it would silently stop tracking the artifact the
    // whole CI gate compares against.
    const gitignore = await readFile(join(REPO_ROOT, ".gitignore"), "utf8");
    const patterns = gitignore
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.startsWith("#"));
    expect(patterns).not.toContain(".bober/topology/");
    expect(patterns).not.toContain(".bober/golden/");
  });
});
