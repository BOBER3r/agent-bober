/**
 * Unit tests for the bober_contracts tool's unreadable-file reporting.
 *
 * `bober_contracts` is the one tool whose entire job is to tell a caller what
 * contracts exist, so it is the tool a silent skip misleads most directly:
 * before this change it answered "you have N contracts" while N was smaller
 * than the number of files in `.bober/contracts/`, with nothing to say so.
 *
 * The handler reads `cwd()`, which under vitest is this repository root — so
 * these run against the REAL committed corpus, no chdir and no fixture.
 */

import { cwd } from "node:process";

import { beforeEach, describe, expect, it } from "vitest";

import { listContractsWithSkips } from "../../state/sprint-state.js";
import { registerContractsTool } from "./contracts.js";
import { getTool } from "./registry.js";

interface ListResponse {
  contracts: { contractId: string }[];
  unreadable?: { count: number; note: string; files: string[] };
}

beforeEach(() => {
  registerContractsTool();
});

describe("bober_contracts reports the files it could not read", () => {
  it("names every skipped file, and the count matches the state layer", async () => {
    const tool = getTool("bober_contracts");
    expect(tool).toBeDefined();

    const response = JSON.parse(await tool!.handler({})) as ListResponse;
    const { contracts, skipped } = await listContractsWithSkips(cwd());

    // Liveness: this repository currently has unreadable contract files, so
    // the branch under test is actually exercised.
    expect(skipped.length).toBeGreaterThan(0);

    expect(response.unreadable).toBeDefined();
    expect(response.unreadable!.count).toBe(skipped.length);
    expect(response.unreadable!.files).toEqual(skipped.map((s) => s.file));

    // The listed contracts are still only the parseable ones — reporting the
    // gap must not smuggle unparseable entries into the list.
    expect(response.contracts).toHaveLength(contracts.length);
  });

  it("tells the caller the files are on disk but do not satisfy the schema", async () => {
    const tool = getTool("bober_contracts");
    const response = JSON.parse(await tool!.handler({})) as ListResponse;

    // The note has to be actionable, not just a number: a caller seeing a
    // count with no explanation cannot tell a missing file from a stale one.
    expect(response.unreadable!.note).toContain("did not parse");
    expect(response.unreadable!.note).toContain("SprintContractSchema");
  });

  // SOURCE-LEVEL, and deliberately so: the handler reads `cwd()` and takes no
  // projectPath argument, so a healthy corpus cannot be handed to it without
  // chdir'ing the worker. The BEHAVIOUR this stands in for — an all-valid
  // directory yielding an empty `skipped` array — is covered directly in
  // src/state/sprint-state.corpus.test.ts.
  it("guards the unreadable key behind a skip count (source check)", async () => {
    const source = await import("node:fs/promises").then((fs) =>
      fs.readFile(new URL("./contracts.ts", import.meta.url), "utf-8"),
    );
    // Conditional, not always-present-with-zero, which would add noise to
    // every healthy project's tool output.
    expect(source).toContain("skipped.length > 0");
  });
});
