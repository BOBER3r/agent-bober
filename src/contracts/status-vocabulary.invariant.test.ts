import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, it, expect } from "vitest";

/**
 * sc-1-4: no production module outside `isSettledContractStatus` /
 * `isTerminalContractStatus` (src/contracts/sprint-contract.ts) compares a
 * `SprintContract.status` to a `"passed"` / `"completed"` / `"failed"`
 * literal for a terminal check, so a sixth ad-hoc reader cannot silently
 * reintroduce the bug this sprint fixes (both MCP sprint tools returning an
 * empty settled list against a real corpus).
 *
 * ── Why this is a scan, not a type ──
 * `ContractStatus` is a plain string union; nothing in the type system
 * distinguishes "a SprintContract.status compared for terminality" from any
 * other string comparison. A text scan is the only tool available, and a
 * text scan cannot see through the receiver's TYPE — `RunState.status`,
 * `FlatTest.status` (a Playwright test result), `ChildOutcome.status`, and
 * Jest's `assertionResults[].status` all spell the identical `.status ===
 * "completed"` / `"failed"` idiom by coincidence. Those sites are catalogued
 * in ALLOWLIST below, each with the type that makes it NOT a contract check
 * (verified by reading the site — see sprint-spec-20260812-terminal-vocabulary-1
 * briefing §2).
 *
 * ── Deliberately allowlisted contract-terminal reads (§3) ──
 * Beyond the non-contract sites, this scan also finds real
 * `SprintContract.status` terminal-shaped comparisons that are outside this
 * sprint's five named readers (src/mcp/tools/sprint.ts,
 * src/mcp/tools/eval.ts, src/cli/commands/sprint.ts,
 * src/cli/commands/eval.ts, src/state/history.ts's "Passed" row) and
 * outside its `estimatedFiles`: three PGE NODE-body files (originally six
 * entries total across two sprints — orchestrator/pipeline.ts:1052, migrated
 * by sprint 5 of spec-20260812-terminal-vocabulary, and PGE RUNTIME's own
 * interpreter.ts:728 / commit.ts:539, migrated by sprint 7 of
 * spec-20260814-pge-full-convergence — each alongside the write or split it
 * was reading, in the same step — see the "eight migrated readers" test
 * below). What remains, sprint-curate.ts / sprint-generate.ts /
 * documenter.ts, are PGE NODE bodies outside every migrating sprint's
 * `estimatedFiles` so far. They are allowlisted WITH A REASON per entry, not
 * silently skipped — see ALLOWLIST.
 *
 * ── Two sites this scan's PATTERN cannot see, by design ──
 * `src/orchestrator/workflow/flusher.ts:76` (`contractStatus === "passed"`)
 * reads a LOCAL variable the same function just computed two lines above
 * from a WRITE, not a `.status` member access — writer-adjacent, and
 * excluded because OFFENDER_PATTERN is keyed on the `.status` accessor
 * spelling every genuine reader in this repo uses.
 * `src/pge/nodes/sprint-review.ts:290`
 * (`status: outcome.settled === "succeeded" ? "completed" : "failed"`) is a
 * WRITER assigning a new object's `status` field — nonGoal 1 forbids
 * touching writers this sprint — and its only `===` comparison is against
 * `"succeeded"`, not a terminal-status literal, so the pattern correctly
 * does not fire on it either.
 * `src/fleet/aggregator.ts:8-9` (`s === "completed"`) compares a bare
 * parameter with no `.status` accessor at all — also outside this
 * pattern's reach, and also not a contract check (RunState["status"]).
 */

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const SRC_ROOT = join(REPO_ROOT, "src");

// ── Scan mechanics ──────────────────────────────────────────────────

/**
 * Matches `<expr>.status === "X"` or the reversed literal-first form, for X
 * in the three words this sprint's predicate partitions. Keyed on the
 * `.status` MEMBER ACCESS spelling — see header for why.
 */
const OFFENDER_PATTERN =
  /\.status\s*===\s*["'](passed|completed|failed)["']|["'](passed|completed|failed)["']\s*===\s*\S*\.status\b/;

function isCommentLine(line: string): boolean {
  const t = line.trimStart();
  return t.startsWith("//") || t.startsWith("*") || t.startsWith("/*");
}

interface SourceFile {
  /** repo-relative, forward slashes */
  path: string;
  content: string;
}

/**
 * Pure — takes in-memory files, never touches disk. This is what the
 * mutation-control tests below drive directly with synthetic content, so
 * "the scan bites" is proven without ever writing a scratch file under src/
 * (a crashed run would otherwise leave one behind — see
 * src/pge/lint-boundary.test.ts's identical rationale for its ESLint
 * `lintText` approach).
 */
function findOffenders(files: SourceFile[]): string[] {
  const offenders: string[] = [];
  for (const file of files) {
    const lines = file.content.split("\n");
    lines.forEach((line, i) => {
      if (isCommentLine(line)) return;
      if (OFFENDER_PATTERN.test(line)) {
        offenders.push(`${file.path}:${i + 1}: ${line.trim()}`);
      }
    });
  }
  return offenders;
}

async function collectProductionTsFiles(dir: string, acc: string[] = []): Promise<string[]> {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "__fixtures__") continue;
      await collectProductionTsFiles(full, acc);
    } else if (entry.name.endsWith(".ts") && !entry.name.endsWith(".test.ts")) {
      acc.push(full);
    }
  }
  return acc;
}

function relative(path: string): string {
  return path.slice(REPO_ROOT.length).split("\\").join("/");
}

async function realSourceFiles(): Promise<SourceFile[]> {
  const files = await collectProductionTsFiles(SRC_ROOT);
  const out: SourceFile[] = [];
  for (const file of files) {
    out.push({ path: relative(file), content: await readFile(file, "utf-8") });
  }
  return out;
}

// ── Allowlist ────────────────────────────────────────────────────────

interface AllowedOffender {
  /** "path:line", matching the prefix findOffenders() reports. */
  location: string;
  reason: string;
}

const ALLOWLIST: AllowedOffender[] = [
  // ── §2: NOT a contract-terminal check — a different type shares the `.status` spelling ──
  {
    location: "src/mcp/tools/status.ts:69",
    reason:
      "RunState.status ('running'|'completed'|'failed'|'aborted'|'input-required'|'paused', src/mcp/run-manager.ts) — a run's state, not a SprintContract.",
  },
  {
    location: "src/evaluators/builtin/playwright.ts:530",
    reason:
      "FlatTest.status — a Playwright test result ('passed'|'failed'|'timedOut'|'skipped'|'interrupted'), not a SprintContract.",
  },
  {
    location: "src/evaluators/builtin/playwright.ts:532",
    reason: "Same FlatTest.status test-result field as :530.",
  },
  {
    location: "src/evaluators/builtin/playwright.ts:542",
    reason: "Same FlatTest.status test-result field as :530.",
  },
  {
    location: "src/evaluators/builtin/unit-test.ts:285",
    reason:
      "Jest JSON reporter's assertionResults[].status ('passed'|'failed'|'pending'), not a SprintContract.",
  },
  {
    location: "src/fleet/reporter.ts:46",
    reason: "ChildOutcome.status ('completed'|'failed'|'other', src/fleet/types.ts) — a fleet child run's outcome, not a SprintContract.",
  },
  {
    location: "src/fleet/reporter.ts:48",
    reason: "Same ChildOutcome.status field as :46.",
  },
  {
    location: "src/do-bridge/reconcile.ts:70",
    reason: "RunState.status via readState(ref.runId) — a run's state, not a SprintContract.",
  },
  {
    location: "src/do-bridge/reconcile.ts:74",
    reason: "Same RunState.status field as :70.",
  },

  // ── A genuine SprintContract.status check, deliberately kept literal ──
  {
    location: "src/state/history.ts:319",
    reason:
      "SprintContract.status, but intentionally the SEPARATE 'Failed' row in .bober/progress.md (see :314-317's comment right above :318's now-migrated 'Passed' row) — folding it into isSettledContractStatus/isTerminalContractStatus would double-count every failed sprint. Line shifted from :199 by the history-redaction layer (redactHistoryString/redactHistoryEntry), added earlier in this file.",
  },

  // ── §3: genuine contract-terminal-shaped reads, outside the five named readers ──
  // and outside estimatedFiles. Three PGE NODE bodies remain here — the two PGE RUNTIME
  // sites that used to sit in this section are gone: sprint 7 of
  // spec-20260814-pge-full-convergence migrated both `src/pge/runtime/interpreter.ts:728`
  // (`verdictFrom`'s settled-contract counter) and `src/pge/runtime/commit.ts:539` (the
  // completed/failed split) to `isSettledContractStatus`, in the same step, so neither
  // entry matches OFFENDER_PATTERN anymore. Both joined the "migrated readers" test below.
  //
  // The three that remain (src/pge/nodes/sprint-curate.ts, sprint-generate.ts,
  // documenter.ts) are PGE NODE bodies, not runtime — outside sprint 7's estimatedFiles —
  // and stay deferred for the same reason pipeline.ts:1052 used to be here before sprint 5
  // of spec-20260812-terminal-vocabulary migrated it: flagged by file:line for whichever
  // future sprint migrates them, not missed.
  {
    location: "src/pge/nodes/sprint-curate.ts:271",
    reason:
      "PGE curator's own successful-history filter ('completed'); same semantics as the five named readers but a PGE node body outside estimatedFiles — deferred alongside sprint-generate.ts/documenter.ts for the same reason as pipeline.ts:1052. Line shifted from :254 by sprint 4 of spec-20260814-pge-full-convergence's history-event emitters, added earlier in this file.",
  },
  {
    location: "src/pge/nodes/sprint-generate.ts:141",
    reason:
      "Same PGE-node successful-history filter pattern as sprint-curate.ts:271. Line shifted from :133 by sprint 4 of spec-20260814-pge-full-convergence's history-event emitters, added earlier in this file.",
  },
  {
    location: "src/pge/nodes/documenter.ts:84",
    reason:
      "documentedContracts()'s fallback for branch-status-less contracts; same PGE-node successful-history pattern as sprint-curate.ts:271. Line shifted from :83 by sprint 4 of spec-20260814-pge-full-convergence's history-event emitter doc comment, added earlier in this file.",
  },
];

const ALLOWED_LOCATIONS = new Set(ALLOWLIST.map((a) => a.location));

function locationOf(offender: string): string {
  // offenders are "path:line: text" — strip the trailing ": text".
  const secondColon = offender.indexOf(":", offender.indexOf(":") + 1);
  return offender.slice(0, secondColon);
}

// ── Tests ────────────────────────────────────────────────────────────

describe("no production module outside the predicate compares a contract status to a terminal literal (sc-1-4)", () => {
  it("the walk actually happens against the real tree", async () => {
    const files = await realSourceFiles();
    expect(files.length).toBeGreaterThan(200);
  });

  it("every ALLOWLIST entry has a non-trivial, specific reason", () => {
    // A bare allowlist with no reason is not acceptable — enforce it structurally so a
    // future entry cannot be added without one.
    for (const { location, reason } of ALLOWLIST) {
      expect(reason.length, `${location} needs a real reason`).toBeGreaterThan(20);
    }
    // No duplicate locations — a repeated entry would silently shadow a second, different
    // reason for the same line.
    expect(ALLOWED_LOCATIONS.size).toBe(ALLOWLIST.length);
  });

  it("every ALLOWLIST entry corresponds to a REAL, currently-matching offender", async () => {
    // The other direction of the same rule: a stale allowlist entry for code that changed
    // or was removed would silently stop being checked. If this fails, either the code
    // moved (update the line number) or the code was migrated (delete the entry).
    const files = await realSourceFiles();
    const rawOffenders = findOffenders(files);
    const rawLocations = new Set(rawOffenders.map(locationOf));
    for (const { location } of ALLOWLIST) {
      expect(rawLocations.has(location), `stale allowlist entry: ${location} no longer matches`).toBe(
        true,
      );
    }
  });

  it("no un-allowlisted offender exists in the real tree", async () => {
    const files = await realSourceFiles();
    const rawOffenders = findOffenders(files);
    const unexplained = rawOffenders.filter((o) => !ALLOWED_LOCATIONS.has(locationOf(o)));
    expect(unexplained).toEqual([]);
  });

  it("the eight migrated readers no longer contain the literal comparison", async () => {
    // Positive evidence the migration happened, beyond "the scan found nothing new" —
    // these eight specific lines used to match OFFENDER_PATTERN and now must not. The
    // sixth, src/orchestrator/pipeline.ts, joined the list at sprint 5 of
    // spec-20260812-terminal-vocabulary, when its :1052 split (`result.contract.status
    // === "passed"`) was migrated to `isSettledContractStatus` in the same step as the
    // write it reads (:589) flipped from "passed" to "completed". The seventh and eighth,
    // src/pge/runtime/interpreter.ts and src/pge/runtime/commit.ts, joined at sprint 7 of
    // spec-20260814-pge-full-convergence, migrating verdictFrom's settled-contract counter
    // (:728, formerly allowlisted) and the completed/failed split (:539, formerly
    // allowlisted) in the same step.
    const migrated = [
      "src/mcp/tools/sprint.ts",
      "src/mcp/tools/eval.ts",
      "src/cli/commands/sprint.ts",
      "src/cli/commands/eval.ts",
      "src/orchestrator/workflow/resume-cursor.ts",
      "src/orchestrator/pipeline.ts",
      "src/pge/runtime/interpreter.ts",
      "src/pge/runtime/commit.ts",
    ];
    for (const rel of migrated) {
      const content = await readFile(join(REPO_ROOT, rel), "utf-8");
      const offenders = findOffenders([{ path: rel, content }]);
      expect(offenders, `${rel} should no longer match OFFENDER_PATTERN`).toEqual([]);
      expect(content).toContain("isSettledContractStatus");
    }
  });

  // ── Mutation control: proves the scan actually fires ──────────────

  it("bites: a synthetic 'passed' comparison outside the allowlist is reported", () => {
    const files: SourceFile[] = [
      {
        path: "src/hypothetical/sixth-reader.ts",
        content: [
          "export function isDone(c: { status: string }): boolean {",
          '  return c.status === "passed";',
          "}",
          "",
        ].join("\n"),
      },
    ];
    const offenders = findOffenders(files);
    expect(offenders).toEqual(['src/hypothetical/sixth-reader.ts:2: return c.status === "passed";']);
    // And it is NOT silently allowlisted just because it exists.
    expect(offenders.every((o) => !ALLOWED_LOCATIONS.has(locationOf(o)))).toBe(true);
  });

  it("bites: the reversed literal-first form is also reported", () => {
    const files: SourceFile[] = [
      {
        path: "src/hypothetical/reversed.ts",
        content: 'export const done = "completed" === contract.status;\n',
      },
    ];
    expect(findOffenders(files)).toEqual([
      'src/hypothetical/reversed.ts:1: export const done = "completed" === contract.status;',
    ]);
  });

  it("does not bite on a comment line (the same conservative heuristic repo-invariants.test.ts uses)", () => {
    const files: SourceFile[] = [
      {
        path: "src/hypothetical/commented.ts",
        content: '// return c.status === "passed"; -- explanatory prose only\n',
      },
    ];
    expect(findOffenders(files)).toEqual([]);
  });

  it("does not bite on non-terminal status literals (e.g. 'in-progress', 'proposed')", () => {
    const files: SourceFile[] = [
      {
        path: "src/hypothetical/non-terminal.ts",
        content: 'export const active = c.status === "in-progress";\n',
      },
    ];
    expect(findOffenders(files)).toEqual([]);
  });

  it("does not bite on a bare local-variable comparison with no `.status` accessor (flusher.ts:76's shape)", () => {
    // Documents, by direct example, why flusher.ts:76 is not in ALLOWLIST: this pattern
    // cannot see it at all, by design (see file header).
    const files: SourceFile[] = [
      {
        path: "src/hypothetical/local-var.ts",
        content: 'export const contractStatus = "passed";\nif (contractStatus === "passed") { /* ... */ }\n',
      },
    ];
    expect(findOffenders(files)).toEqual([]);
  });
});
