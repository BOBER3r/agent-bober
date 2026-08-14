import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { execa } from "execa";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { EXIT_OK, runPgeAuditState, runPgeDump } from "../cli/commands/pge.js";
import type { PgeIo } from "../cli/commands/pge.js";
import { stateAuditPath } from "./topology/audit.js";

/**
 * The sixth CI check, driven END TO END: `pge audit-state` followed by
 * `git diff --exit-code`.
 *
 * `audit-state` without `--check` always exits 0 — it REWRITES the audit rather than
 * complaining about it. The whole verdict of that CI step therefore lives in the
 * `git diff --exit-code` that follows: a stale committed audit becomes a red build only
 * because the rewrite leaves the working tree dirty. `pge.test.ts` pins the `--check`
 * form's exit codes; nothing pinned the PAIRING, and a pairing nobody drives is a pairing
 * that can rot into two steps that each pass while the property they jointly assert does
 * not hold.
 *
 * It lives one directory ABOVE `src/pge/topology/` — like `zero-execution.test.ts` — because
 * it spawns `git` through `execa`, which the ADR-2 module-graph boundary forbids inside the
 * guarded subtree (`eslint.config.js`).
 *
 * So this file builds a real git repository in a temp directory, commits a DRIFTED audit,
 * and asserts that the pair reports it. The repository under test is never touched: every
 * artifact here is written into `mkdtemp`.
 */

let root = "";
let io: PgeIo;
const out: string[] = [];
const err: string[] = [];

/** Committer identity supplied per-invocation, so a machine with no global git identity works. */
const GIT_IDENTITY = [
  "-c",
  "user.email=gate@example.invalid",
  "-c",
  "user.name=Gate",
  "-c",
  "commit.gpgsign=false",
];

async function git(args: string[]): Promise<{ exitCode: number; stdout: string }> {
  const result = await execa("git", [...GIT_IDENTITY, ...args], { cwd: root, reject: false });
  return { exitCode: result.exitCode ?? 1, stdout: result.stdout };
}

/** `git diff --exit-code`, exactly as the workflow step runs it. */
async function gitDiffExitCode(): Promise<number> {
  return (await git(["diff", "--exit-code"])).exitCode;
}

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "bober-audit-git-"));
  out.length = 0;
  err.length = 0;
  io = { out: (line) => out.push(line), err: (line) => err.push(line) };

  await git(["init"]);
  // Produce the artifact and its audit, then commit both — the shipped state.
  expect(await runPgeDump(root, {}, io)).toBe(EXIT_OK);
  expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
  await git(["add", "-A"]);
  await git(["commit", "-m", "topology and state audit"]);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("pge audit-state followed by git diff --exit-code", () => {
  it("leaves a clean tree when the committed audit is current", async () => {
    expect(await gitDiffExitCode()).toBe(0);

    // The rewrite is byte-identical, so the pair passes.
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    expect(await gitDiffExitCode()).toBe(0);
  });

  /**
   * NEGATIVE CONTROL — a committed audit that has drifted. `audit-state` still exits 0;
   * the `git diff` is what turns it red, which is precisely why the workflow step runs
   * both and why removing the second half is the way this check rots.
   */
  it("exits non-zero once a drifted audit is committed", async () => {
    const path = stateAuditPath(root);
    const audit = JSON.parse(await readFile(path, "utf-8")) as { keys: unknown[] };
    expect(audit.keys.length).toBeGreaterThan(0);
    audit.keys = audit.keys.slice(1);
    await writeFile(path, `${JSON.stringify(audit, null, 2)}\n`, "utf-8");
    await git(["add", "-A"]);
    await git(["commit", "-m", "drift the audit"]);
    expect(await gitDiffExitCode()).toBe(0); // the drift is now the committed state

    // `audit-state` is happy: it writes, it does not judge.
    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);

    // …and the pair is not.
    expect(await gitDiffExitCode()).not.toBe(0);
    const diff = await git(["diff", "--name-only"]);
    expect(diff.stdout).toContain("state-audit.json");
  });

  /**
   * NEGATIVE CONTROL — a DELETED audit. `audit-state` recreates it, and an untracked or
   * removed file must not slip past the pair either.
   */
  it("exits non-zero once the committed audit is deleted", async () => {
    await rm(stateAuditPath(root));
    await git(["add", "-A"]);
    await git(["commit", "-m", "drop the audit"]);
    expect(await gitDiffExitCode()).toBe(0);

    expect(await runPgeAuditState(root, {}, io)).toBe(EXIT_OK);
    // The regenerated file is untracked, and a bare `git diff` cannot see an untracked
    // file — so this exact scenario, a pull request that DELETED the committed audit,
    // would have merged green under a bare `git diff --exit-code`. The workflow step
    // therefore stages before diffing, and this control drives that same pair rather
    // than a stronger command than CI runs.
    await git(["add", "-A"]);
    expect((await git(["diff", "--cached", "--exit-code"])).exitCode).not.toBe(0);
  });
});
