import { readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isSettledContractStatus } from "../../contracts/sprint-contract.js";
import { listContracts } from "../../state/sprint-state.js";

/**
 * Pins the live bug this sprint fixes: `bober_sprint` and `bober_eval` both
 * built their `completedContracts` list with `c.status === "passed"`, and
 * this repo's own `.bober/contracts/` corpus holds zero contracts with that
 * exact status — every one of `runTsPipeline`'s successful sprints is
 * written "passed", but the graph engine writes "completed", and neither
 * tool ever saw a "passed" contract from a real run recorded elsewhere. The
 * settled list was silently empty for both MCP tools.
 *
 * `bober_sprint`'s handler (src/mcp/tools/sprint.ts:85-313) runs real
 * generator/evaluator agents end-to-end and cannot be invoked from a unit
 * test. The honest pin, instead, is to drive the exact function both tools
 * call — `listContracts` (src/state/sprint-state.ts:113, called at
 * sprint.ts:115 and eval.ts:80) — against the REAL committed corpus, and to
 * assert both tools' source literally filters with `isSettledContractStatus`
 * rather than the old `"passed"`-only literal (sprint.ts:147, eval.ts:139).
 * Together these two assertions prove the data-level bug is fixed AND that
 * both call sites were actually migrated, without needing to spin up a full
 * agent run.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

describe("bober_sprint / bober_eval settled-contract list against the real corpus", () => {
  it("listContracts(REPO_ROOT) reads a non-empty corpus (liveness: the walk actually happened)", async () => {
    const contracts = await listContracts(REPO_ROOT);
    expect(contracts.length).toBeGreaterThan(0);
  });

  it("the settled list — what both MCP tools now build — is non-empty against the real corpus", async () => {
    const contracts = await listContracts(REPO_ROOT);
    const settled = contracts.filter((c) => isSettledContractStatus(c.status));

    // This is the assertion that was false before this sprint: filtering on
    // the literal "passed" alone against this repo's corpus returns [].
    expect(settled.length).toBeGreaterThan(0);
  });

  it("isSettledContractStatus's result matches an independent passed-OR-completed computation on the real corpus", async () => {
    // Cross-checks the predicate against the real data with a second,
    // independently-written computation — not a hardcoded count, so this
    // does not need to change when sprint 2 migrates the four illegal
    // "pending" contracts and the corpus numbers shift.
    const contracts = await listContracts(REPO_ROOT);
    const viaPredicate = contracts.filter((c) => isSettledContractStatus(c.status)).length;
    const viaLiteral = contracts.filter(
      (c) => c.status === "passed" || c.status === "completed",
    ).length;
    expect(viaPredicate).toBe(viaLiteral);
    expect(viaPredicate).toBeGreaterThan(0);
  });

  it("confirms the corpus actually contains zero contracts whose status is the literal string 'passed'", async () => {
    // The specific fact that made the old `c.status === "passed"` filter
    // return [] for bober_sprint/bober_eval against this repo. If this ever
    // stops being true the bug this sprint fixes would no longer reproduce —
    // still fine, since the predicate-based fix does not depend on it, but
    // worth pinning as the documented root cause.
    const contracts = await listContracts(REPO_ROOT);
    const passedOnly = contracts.filter((c) => c.status === "passed");
    expect(passedOnly.length).toBe(0);
  });

  it("mcp/tools/sprint.ts's completedContracts filter uses isSettledContractStatus, not a bare 'passed' literal", async () => {
    const source = await readFile(join(REPO_ROOT, "src/mcp/tools/sprint.ts"), "utf-8");
    expect(source).toMatch(/isSettledContractStatus\(c\.status\)/);
    expect(source).not.toMatch(/c\.status === "passed"/);
  });

  it("mcp/tools/eval.ts's completedContracts filter uses isSettledContractStatus, not a bare 'passed' literal", async () => {
    const source = await readFile(join(REPO_ROOT, "src/mcp/tools/eval.ts"), "utf-8");
    expect(source).toMatch(/isSettledContractStatus\(c\.status\)/);
    expect(source).not.toMatch(/c\.status === "passed"/);
  });

  it("cli/commands/sprint.ts and cli/commands/eval.ts (the CLI equivalents) are migrated the same way", async () => {
    const sprintSource = await readFile(
      join(REPO_ROOT, "src/cli/commands/sprint.ts"),
      "utf-8",
    );
    const evalSource = await readFile(join(REPO_ROOT, "src/cli/commands/eval.ts"), "utf-8");
    expect(sprintSource).toMatch(/isSettledContractStatus\(c\.status\)/);
    expect(evalSource).toMatch(/isSettledContractStatus\(c\.status\)/);
  });
});
