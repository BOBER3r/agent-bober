import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";

/**
 * sc-14-3 / sc-14-4 — the blocking PGE graph gate in `.github/workflows/ci.yml`.
 *
 * THIS TEST READS THE REAL WORKFLOW FILE. Not a fixture, not a string literal copy: a
 * test that asserts against its own copy of the YAML proves only that the copy is
 * correct, which is precisely the decorative-gate failure mode this sprint exists to
 * prevent. `CI_YAML` is resolved from `import.meta.url`, so the file the CI runner
 * executes is the file under assertion.
 *
 * ── Why a hand-rolled reader and not a YAML parser ──────────────────
 *
 * `yaml` / `js-yaml` are not dependencies of this project (`js-yaml` exists in
 * `node_modules` only transitively, under `markdownlint-cli`, so importing it would be a
 * phantom dependency that breaks the moment that tree moves). The two facts this test
 * needs — which job a line belongs to, and what each step runs — are recoverable from
 * indentation alone, which is the same call `src/discovery/scanners/ci-checks.ts` made
 * ("No yaml dependency -- pure string parsing").
 *
 * ── Why every assertion is routed through `auditWorkflow` ───────────
 *
 * A gate that cannot fail is worse than no gate. Each assertion below is therefore made
 * twice: once against the committed file, where it must report NOTHING, and once against
 * an in-memory MUTATION that breaks the precondition, where it must report exactly the
 * violation it claims to guard. `hasContinueOnError` is additionally proven against real
 * data — the shipped `kpi-gate` job really does set the key, so the detector returning
 * `false` for `pge-graph-gate` is a measurement rather than a coincidence.
 */

const CI_YAML = fileURLToPath(new URL("../../../.github/workflows/ci.yml", import.meta.url));

/** The blocking job this sprint adds. */
const GATE_JOB = "pge-graph-gate";
/** The job it must run after, so it runs on a built tree. */
const BUILD_JOB = "build-and-test";

// ── A minimal indentation reader ────────────────────────────────────

/**
 * Full-line comments removed.
 *
 * A commented-out `continue-on-error: true` is not active YAML, and the gate job's own
 * header comment mentions the key in prose. Stripping comments before any structural
 * question is asked is what keeps both from being read as configuration.
 */
function withoutComments(text: string): string {
  return text
    .split("\n")
    .filter((line) => !/^\s*#/.test(line))
    .join("\n");
}

function indentOf(line: string): number {
  return line.length - line.trimStart().length;
}

/** The body of a top-level block (`on:`, `jobs:`), excluding its header line. */
function topLevelBlock(text: string, key: string): string {
  const lines = withoutComments(text).split("\n");
  const start = lines.findIndex((line) => new RegExp(`^${key}:\\s*$`).test(line));
  if (start === -1) return "";
  const body: string[] = [];
  for (const line of lines.slice(start + 1)) {
    if (line.trim().length > 0 && indentOf(line) === 0) break;
    body.push(line);
  }
  return body.join("\n");
}

/** Workflow-level trigger event names, in file order. */
export function triggers(text: string): string[] {
  return topLevelBlock(text, "on")
    .split("\n")
    .map((line) => /^ {2}([A-Za-z_]+):/.exec(line)?.[1])
    .filter((name): name is string => name !== undefined);
}

/** Every job in `jobs:`, keyed by id, each value being the job's body lines. */
export function parseJobs(text: string): Map<string, string> {
  const jobs = new Map<string, string>();
  let current: string | undefined;
  let body: string[] = [];
  const flush = (): void => {
    if (current !== undefined) jobs.set(current, body.join("\n"));
  };
  for (const line of topLevelBlock(text, "jobs").split("\n")) {
    const header = /^ {2}([A-Za-z0-9_.-]+):\s*$/.exec(line);
    if (header) {
      flush();
      current = header[1];
      body = [];
      continue;
    }
    if (current !== undefined) body.push(line);
  }
  flush();
  return jobs;
}

/**
 * The shell commands a job's steps run: inline `run: …` plus block scalars
 * (`run: |`), each block returned as one command with its lines joined.
 */
export function runCommands(jobBody: string): string[] {
  const lines = jobBody.split("\n");
  const commands: string[] = [];
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const match = /^\s*(?:-\s+)?run:\s*(.*)$/.exec(line);
    if (!match) continue;
    const value = match[1].trim();
    if (value !== "|" && value !== ">" && value !== "|-" && value !== ">-") {
      if (value.length > 0) commands.push(value);
      continue;
    }
    // Block scalar: everything indented deeper than the `run:` token itself.
    const runColumn = line.indexOf("run:");
    const block: string[] = [];
    let j = i + 1;
    for (; j < lines.length; j += 1) {
      const next = lines[j];
      if (next.trim().length === 0) continue;
      if (indentOf(next) <= runColumn) break;
      block.push(next.trim());
    }
    i = j - 1;
    if (block.length > 0) commands.push(block.join("\n"));
  }
  return commands;
}

/**
 * True when the job sets `continue-on-error: true` at ANY depth — job level or step
 * level. Both make the job informational, and nonGoal 1 forbids both.
 */
export function hasContinueOnError(jobBody: string): boolean {
  return /^\s*(?:-\s+)?continue-on-error:\s*true\s*$/m.test(withoutComments(jobBody));
}

// ── The audit ───────────────────────────────────────────────────────

interface RequiredCheck {
  label: string;
  matches: (command: string) => boolean;
  /**
   * The negative control: the smallest edit to the workflow TEXT that stops this check
   * being invoked. Each one is asserted to actually change the file, so a `kill` that
   * silently stopped matching could not pass itself off as a mutation.
   */
  kill: (source: string) => string;
}

/**
 * The five artifact checks plus the regression runner, each recognised by the SUBSTANCE
 * of the command rather than by a step name, so renaming a step cannot make a check
 * disappear silently.
 */
const REQUIRED_CHECKS: readonly RequiredCheck[] = [
  {
    label: "pge dump --check",
    matches: (c) => /\bpge dump\b/.test(c) && /--check\b/.test(c),
    // Dropping `--check` is the realistic regression: `pge dump` alone REWRITES the
    // artifact and exits 0, so the gate would pass on a stale committed file.
    // Targets the `run:` line, not the step NAME, which also spells the command out.
    kill: (source) => source.replace("index.js pge dump --check", "index.js pge dump"),
  },
  {
    label: "pge validate --mode full",
    matches: (c) => /\bpge validate\b/.test(c) && /--mode\s+full\b/.test(c),
    kill: (source) => source.replace("index.js pge validate --mode full", "index.js pge validate"),
  },
  {
    label: "pge docs --check",
    matches: (c) => /\bpge docs\b/.test(c) && /--check\b/.test(c),
    kill: (source) => source.replace("index.js pge docs --check", "index.js pge docs"),
  },
  {
    label: "pge diff --require-version-bump",
    matches: (c) => /\bpge diff\b/.test(c) && /--require-version-bump\b/.test(c),
    kill: (source) => source.replace("coding.json --require-version-bump", "coding.json"),
  },
  {
    // Same step, in this order: `audit-state` REWRITES the audit, and it is the
    // subsequent diff that turns a stale committed audit red. Split across steps the
    // pairing still works, but "followed by" is the contract's wording and the tighter
    // reading is the one worth pinning.
    //
    // The diff is STAGED (`git add -A` then `git diff --cached --exit-code`) rather than
    // a bare `git diff --exit-code`. A bare worktree diff cannot see an UNTRACKED file,
    // so a pull request that DELETED the committed audit would regenerate it here as an
    // untracked file and merge green — the one shape of audit rot the gate exists to
    // catch. Staging first is also exactly the pair `audit-git-gate.test.ts` drives, so
    // the negative control proves the command CI actually runs.
    label: "pge audit-state followed by git diff --cached --exit-code",
    matches: (c) => /\bpge audit-state\b/.test(c) && /\bgit diff --cached --exit-code\b/.test(c),
    // `audit-state` on its own always exits 0 and silently rewrites the audit; the
    // diff is the entire verdict, so removing it is the way this check rots.
    kill: (source) => source.replace("          git diff --cached --exit-code\n", ""),
  },
  {
    label: "the golden graph regression runner",
    matches: (c) => /run-golden-regression\.mjs\b/.test(c),
    kill: (source) => source.replace("scripts/run-golden-regression.mjs", "--version"),
  },
];

/**
 * Everything wrong with the workflow, as a list of human-readable violations. Empty is
 * the only passing value.
 */
export function auditWorkflow(text: string): string[] {
  const violations: string[] = [];

  if (!triggers(text).includes("pull_request")) {
    violations.push("the workflow does not trigger on pull_request");
  }

  const jobs = parseJobs(text);
  const job = jobs.get(GATE_JOB);
  if (job === undefined) {
    violations.push(`there is no "${GATE_JOB}" job`);
    return violations;
  }

  if (hasContinueOnError(job)) {
    violations.push(`"${GATE_JOB}" sets continue-on-error: true, so it is not blocking`);
  }
  // A job-level `if:` would let the gate skip itself, which is `continue-on-error` by
  // another name. Step-level `if:` (indent 8) is not what this matches.
  if (/^ {4}if:/m.test(withoutComments(job))) {
    violations.push(`"${GATE_JOB}" carries a job-level if:, so it can skip itself`);
  }
  if (!new RegExp(`^\\s*needs:\\s*${BUILD_JOB}\\s*$`, "m").test(job)) {
    violations.push(`"${GATE_JOB}" does not declare needs: ${BUILD_JOB}`);
  }
  // Anchored to a YAML key line: the step that reports a missing base ref MENTIONS
  // `fetch-depth: 0` in its error message, and prose must not satisfy a config check.
  if (!/^\s*fetch-depth:\s*0\s*$/m.test(job)) {
    violations.push(
      `"${GATE_JOB}" does not check out with fetch-depth: 0, so \`git show <base>\` cannot resolve the base artifact`,
    );
  }

  const commands = runCommands(job);
  for (const check of REQUIRED_CHECKS) {
    if (!commands.some((command) => check.matches(command))) {
      violations.push(`"${GATE_JOB}" does not invoke ${check.label}`);
    }
  }

  const diffCommand = commands.find((c) => /\bpge diff\b/.test(c)) ?? "";
  if (!/git show\b/.test(diffCommand)) {
    violations.push(
      `"${GATE_JOB}" does not fetch the base artifact with \`git show\`, so the gate would not work on a fork or offline`,
    );
  }

  return violations;
}

// ── The committed file ──────────────────────────────────────────────

let text = "";

beforeAll(async () => {
  text = await readFile(CI_YAML, "utf8");
});

describe("the committed .github/workflows/ci.yml", () => {
  it("triggers on pull_request", () => {
    expect(triggers(text)).toContain("pull_request");
  });

  it(`declares a ${GATE_JOB} job that needs ${BUILD_JOB}`, () => {
    const jobs = parseJobs(text);
    expect([...jobs.keys()]).toContain(GATE_JOB);
    expect(jobs.get(GATE_JOB)).toMatch(new RegExp(`^\\s*needs:\\s*${BUILD_JOB}\\s*$`, "m"));
  });

  it("leaves the pre-existing jobs in place", () => {
    // Scope discipline, asserted rather than promised: this sprint ADDS a job.
    expect([...parseJobs(text).keys()]).toEqual(
      expect.arrayContaining([BUILD_JOB, "kpi-gate", GATE_JOB]),
    );
  });

  it(`runs all five artifact checks plus the regression runner in ${GATE_JOB}`, () => {
    const job = parseJobs(text).get(GATE_JOB) ?? "";
    const commands = runCommands(job);
    for (const check of REQUIRED_CHECKS) {
      expect(
        commands.some((command) => check.matches(command)),
        `${GATE_JOB} must invoke ${check.label}; it runs:\n${commands.join("\n---\n")}`,
      ).toBe(true);
    }
  });

  it("references a regression runner script that exists and delegates to a TESTED module", async () => {
    const job = parseJobs(text).get(GATE_JOB) ?? "";
    const command = runCommands(job).find((c) => /run-golden-regression\.mjs\b/.test(c)) ?? "";
    const script = /(scripts\/[\w.-]+\.mjs)/.exec(command)?.[1];
    expect(script, `no scripts/*.mjs path in: ${command}`).toBeDefined();
    // A step that invokes a phantom script fails the job for the wrong reason and reads
    // as a gate that ran. Resolve it against the repository root and open it.
    const resolved = fileURLToPath(new URL(`../../../${script ?? ""}`, import.meta.url));
    const scriptText = await readFile(resolved, "utf8");

    // The chain is followed rather than assumed. A `.mjs` script is invisible to tsc, to
    // ESLint and to Vitest, so gate logic living inside it is logic no negative control
    // can reach: the script must therefore delegate to a compiled module, and that
    // module must have a real TypeScript source that reaches the regression runner.
    // Asserting a substring on the script alone would pass on a script that merely
    // SPELLS the name in a comment.
    const distModules = [...scriptText.matchAll(/dist\/(pge\/golden\/[\w.-]+)\.js/g)].map(
      (match) => match[1],
    );
    expect(distModules, `${script} names no dist/pge/golden module`).not.toHaveLength(0);

    const sources = await Promise.all(
      distModules.map(async (module) => {
        const path = fileURLToPath(new URL(`../../../src/${module}.ts`, import.meta.url));
        return readFile(path, "utf8").catch(() => "");
      }),
    );
    const entry = sources.find((source) => source.includes("export async function runGoldenGate"));
    expect(
      entry,
      `none of ${distModules.join(", ")} has a src/*.ts exporting runGoldenGate`,
    ).toBeDefined();
    expect(entry ?? "").toContain("runGoldenRegressionFromDir");
    expect(scriptText).toContain("runGoldenGate");

    // ── The RUNTIME half must be wired, not merely available ──
    //
    // The defect this guards against is specific and it shipped once: the gate ran the
    // pass-rate comparison only when an executor was INJECTED, and the script looked for
    // one in a module nobody had written — so the job enforced dataset shape alone while
    // its name claimed a regression pass rate. Asserting that the gate NAMES the executor
    // factory, and that the executor really drives the engine, is what makes that
    // regression fail here instead of going unnoticed for another sprint.
    expect(
      entry ?? "",
      "the gate no longer builds a GoldenExecutor: the pass-rate half is unwired again",
    ).toContain("createGoldenExecutor");

    const executorSource = await readFile(
      fileURLToPath(new URL("../golden/executor.ts", import.meta.url)),
      "utf8",
    );
    expect(executorSource, "the golden executor does not construct a real engine").toContain(
      "new PgeEngine(",
    );
    expect(
      executorSource,
      "the golden executor does not answer from the case's pinned responses",
    ).toContain("createReplayEffectRegistry(");
  });

  it("fetches the base artifact with git show rather than over the network", () => {
    const job = parseJobs(text).get(GATE_JOB) ?? "";
    const diff = runCommands(job).find((c) => /\bpge diff\b/.test(c)) ?? "";
    expect(diff).toMatch(/git show\b/);
    expect(job).not.toMatch(/curl|wget|api\.github\.com/);
  });

  it(`sets no continue-on-error anywhere in ${GATE_JOB}`, () => {
    const job = parseJobs(text).get(GATE_JOB) ?? "";
    expect(hasContinueOnError(job)).toBe(false);
    expect(job).not.toMatch(/^\s*(?:-\s+)?continue-on-error:/m);
  });

  it("reports no violations at all", () => {
    expect(auditWorkflow(text)).toEqual([]);
  });
});

// ── Negative controls: every assertion above is shown to be capable of failing ──

describe("the audit bites", () => {
  /** Inject a line immediately after the gate job's header. */
  function injectIntoGateJob(source: string, line: string): string {
    const header = `  ${GATE_JOB}:\n`;
    const at = source.indexOf(header);
    expect(at, `${GATE_JOB} header not found`).toBeGreaterThan(-1);
    return `${source.slice(0, at + header.length)}${line}\n${source.slice(at + header.length)}`;
  }

  /**
   * REAL DATA, not a mutation: the shipped `kpi-gate` job sets the key. If
   * `hasContinueOnError` could not see it there, its `false` for `pge-graph-gate` would
   * be meaningless.
   */
  it("detects continue-on-error on the real kpi-gate job", () => {
    const kpi = parseJobs(text).get("kpi-gate");
    expect(kpi).toBeDefined();
    expect(hasContinueOnError(kpi ?? "")).toBe(true);
  });

  it("fails when continue-on-error: true is added to the gate job", () => {
    const mutated = injectIntoGateJob(text, "    continue-on-error: true");
    expect(hasContinueOnError(parseJobs(mutated).get(GATE_JOB) ?? "")).toBe(true);
    expect(auditWorkflow(mutated)).toContain(
      `"${GATE_JOB}" sets continue-on-error: true, so it is not blocking`,
    );
  });

  it("fails when a STEP inside the gate job sets continue-on-error: true", () => {
    const mutated = text.replace(
      "      - run: npm ci\n      - run: npm run build\n      - name: pge dump --check",
      "      - run: npm ci\n        continue-on-error: true\n      - run: npm run build\n      - name: pge dump --check",
    );
    expect(mutated).not.toBe(text);
    expect(auditWorkflow(mutated)).toContain(
      `"${GATE_JOB}" sets continue-on-error: true, so it is not blocking`,
    );
  });

  it("fails when the gate job is made conditional at job level", () => {
    const mutated = injectIntoGateJob(text, "    if: github.event_name == 'schedule'");
    expect(auditWorkflow(mutated)).toContain(
      `"${GATE_JOB}" carries a job-level if:, so it can skip itself`,
    );
  });

  it("fails when the workflow stops triggering on pull_request", () => {
    const mutated = text.replace("  pull_request:\n    branches: [main]\n", "");
    expect(mutated).not.toBe(text);
    expect(triggers(mutated)).not.toContain("pull_request");
    expect(auditWorkflow(mutated)).toContain("the workflow does not trigger on pull_request");
  });

  it("fails when the gate job stops needing build-and-test", () => {
    const mutated = text.replace(`    needs: ${BUILD_JOB}\n    steps:`, "    steps:");
    expect(mutated).not.toBe(text);
    expect(auditWorkflow(mutated)).toContain(`"${GATE_JOB}" does not declare needs: ${BUILD_JOB}`);
  });

  it("fails when the checkout stops fetching full history", () => {
    const mutated = text.replace("          fetch-depth: 0\n", "");
    expect(mutated).not.toBe(text);
    expect(auditWorkflow(mutated).join("\n")).toContain("fetch-depth: 0");
  });

  it("fails once for EACH of the six checks when its command is broken", () => {
    for (const check of REQUIRED_CHECKS) {
      const mutated = check.kill(text);
      expect(mutated, `${check.label}: the mutation was a no-op`).not.toBe(text);
      // Exactly the one violation, so a `kill` that broke something else by accident
      // cannot be mistaken for a working negative control.
      expect(auditWorkflow(mutated)).toContain(`"${GATE_JOB}" does not invoke ${check.label}`);
    }
  });

  it("fails when the whole gate job is deleted", () => {
    const header = `  ${GATE_JOB}:\n`;
    const start = text.indexOf(header);
    expect(start).toBeGreaterThan(-1);
    const nextJob = /\n {2}[A-Za-z0-9_.-]+:\n/.exec(text.slice(start + header.length));
    expect(nextJob, "the gate job is last in the file; this control needs a following job").not
      .toBeNull();
    const mutated =
      text.slice(0, start) + text.slice(start + header.length + (nextJob?.index ?? 0) + 1);
    expect(mutated).not.toBe(text);
    expect(parseJobs(mutated).has(GATE_JOB)).toBe(false);
    expect(auditWorkflow(mutated)).toContain(`there is no "${GATE_JOB}" job`);
  });
});
