import { z } from "zod";

import type { BoberConfig } from "../../config/schema.js";
import { VerificationMethodSchema } from "../../contracts/sprint-contract.js";
import type { SprintContract, VerificationMethod } from "../../contracts/sprint-contract.js";
import type { ScratchStore } from "../runtime/scratch.js";
import { createSandboxPolicy, sandboxEnvFromProcess } from "../runtime/sandbox.js";
import type { SandboxOutcome, SandboxPolicy, SandboxRunner } from "../runtime/sandbox.js";
import type { TraceWriter } from "../runtime/trace.js";

/**
 * How the sprint region executes anything, and how it decides what is worth executing.
 *
 * ── The sandbox is the ONLY execution path (nonGoal 5) ──
 *
 * No module under `src/pge/nodes/` imports `execa` or `node:child_process`. Everything a
 * generated test or a compiler could run goes through {@link SandboxRunner}
 * (`runtime/sandbox.ts:180`), whose allow/deny/cwd checks are decided BEFORE a process could
 * exist and whose three failure modes — denied, timeout, output-truncated — are ordinary
 * union members rather than exceptions, so a gate ROUTES on them.
 *
 * The shipped `src/orchestrator/tools/handlers.ts` runs `execa("sh", ["-c", command])` with
 * no guard at all. That path is untouched and unreachable from here.
 *
 * ── Why the runner is threaded through a factory instead of taken off NodeContext ──
 *
 * {@link NodeContext} carries scratch, archive, cache, trace, ledger, prompts and models —
 * and no sandbox (`registry/nodes.ts:170-191`). It also carries the NARROW `ScratchStore`
 * and `TraceWriter` interfaces, while `SandboxRunner.run` takes the RUNTIME ones
 * (`runtime/scratch.ts:281`, `runtime/trace.ts:205`), which are supersets — `ctx.scratch`
 * therefore does not typecheck where the sandbox wants a store. So a {@link SprintRuntime}
 * is supplied by the composition root, exactly as sprint 11 supplies its effect registry,
 * and the node bodies receive it as a closed-over argument rather than reaching for a
 * module-level singleton.
 *
 * ── Selective verification is a decision INSIDE a node, not a node that gets skipped ──
 *
 * The artifact declares no "expensive suite" node: `sprint_evaluate` (`coding.graph.ts:582`)
 * is the only node that runs the project's test command, and skipping it would skip the
 * evaluation as well. So {@link selectVerification} decides which COMMANDS reach the
 * sandbox, and the criterion is observed by counting sandbox invocations rather than by
 * asserting that a node did not run.
 */

// ── Runtime ─────────────────────────────────────────────────────────

/**
 * The execution collaborators a sprint node needs and {@link NodeContext} does not carry.
 *
 * `trace` is the RUNTIME writer, not the node-facing one, for a second reason beyond the
 * sandbox: `SpanEnd` carries `failClosed` (`runtime/trace.ts:131`) and the narrowed
 * `SpanHandle` on `NodeContext` does not (`registry/nodes.ts:86`). sc-12-6 requires
 * `failClosed: true` in the trace for an evaluator that throws, and the interpreter records
 * that flag only on the approval-block path (`interpreter.ts:1156,1170`), so the node has
 * to open its own child span.
 */
export interface SprintRuntime {
  readonly sandbox: SandboxRunner;
  readonly scratch: ScratchStore;
  readonly trace: TraceWriter;
}

// ── Commands ────────────────────────────────────────────────────────

/** A configured verification command, split for a runner that has no shell. */
export interface VerificationCommand {
  readonly method: VerificationMethod;
  readonly cmd: string;
  readonly args: readonly string[];
}

/**
 * Split a configured command string into a binary and an argument vector.
 *
 * Whitespace only, and deliberately: `execa(file, argv)` is called with an explicit array,
 * so an argument containing a space cannot be expressed at all — there is no shell to quote
 * for. A command that needs one is a command that needs a script, which the allowlist would
 * then name.
 */
export function parseCommand(text: string): { cmd: string; args: string[] } | null {
  const parts = text.trim().split(/\s+/).filter((part) => part.length > 0);
  if (parts.length === 0) return null;
  return { cmd: parts[0], args: parts.slice(1) };
}

/** Which `config.commands` entry backs each verification method. */
const METHOD_COMMAND_KEYS = {
  typecheck: "typecheck",
  lint: "lint",
  "unit-test": "test",
  build: "build",
} as const satisfies Partial<Record<VerificationMethod, keyof BoberConfig["commands"]>>;

/** The verification methods this layer can actually execute. */
export const EXECUTABLE_METHODS = Object.keys(METHOD_COMMAND_KEYS) as VerificationMethod[];

/**
 * The configured command for `method`, or `null` when the project declares none.
 *
 * `null` is a real answer, not a defect: a project with no `commands.lint` has nothing for
 * the syntax gate to run, and inventing `eslint .` would execute something the project
 * never asked for.
 */
export function commandFor(
  config: BoberConfig,
  method: VerificationMethod,
): VerificationCommand | null {
  const key = (METHOD_COMMAND_KEYS as Record<string, keyof BoberConfig["commands"]>)[method];
  if (key === undefined) return null;
  const text = config.commands[key];
  if (text === undefined || text.trim().length === 0) return null;
  const parsed = parseCommand(text);
  return parsed === null ? null : { method, cmd: parsed.cmd, args: parsed.args };
}

/** Every executable command the project declares, in a stable order. */
export function verificationCommands(config: BoberConfig): VerificationCommand[] {
  const commands: VerificationCommand[] = [];
  for (const method of EXECUTABLE_METHODS) {
    const command = commandFor(config, method);
    if (command !== null) commands.push(command);
  }
  return commands;
}

/**
 * The sandbox allowlist: exactly the binaries the project's own commands name.
 *
 * Derived rather than configured, which is what makes it an allowlist rather than a wish:
 * a project whose `commands.test` is `npm test` allows `npm` and nothing else, and a
 * generated test that tries to run anything else is denied before it spawns.
 */
export function sandboxAllowlist(config: BoberConfig): string[] {
  return [...new Set(verificationCommands(config).map((command) => command.cmd))].sort();
}

/** The sandbox policy the sprint region's process-exec nodes run under. */
export function sprintSandboxPolicy(
  config: BoberConfig,
  cwd: string,
  overrides: { timeoutMs?: number; allowBinaries?: readonly string[] } = {},
): SandboxPolicy {
  // `config.pge.sandboxTimeoutMs` is the project's declared budget for ONE command; the
  // sandbox's own 120s default applies when it is absent, so an existing config behaves
  // exactly as it did.
  const timeoutMs = overrides.timeoutMs ?? config.pge?.sandboxTimeoutMs;
  return createSandboxPolicy({
    cwd,
    allowBinaries: overrides.allowBinaries ?? sandboxAllowlist(config),
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
    env: sandboxEnvFromProcess(),
  });
}

// ── Outcome classification ──────────────────────────────────────────

/**
 * The correction source a non-`ok` sandbox outcome maps to, or `null` when it ran.
 *
 * The mapping is total over the union so a new outcome member cannot be silently treated as
 * a pass — which is the specific way sc-12-10 could be faked.
 */
export function sandboxCorrectionSource(
  outcome: SandboxOutcome,
): "sandbox-denied" | "sandbox-timeout" | null {
  switch (outcome.status) {
    case "denied":
      return "sandbox-denied";
    case "timeout":
      return "sandbox-timeout";
    default:
      // `output-truncated` produced output and a real exit; it is a run, not a refusal.
      return null;
  }
}

/** A human account of a sandbox outcome, for a correction's critique. */
export function describeSandboxOutcome(
  command: VerificationCommand,
  outcome: SandboxOutcome,
): string {
  const name = [command.cmd, ...command.args].join(" ");
  switch (outcome.status) {
    case "denied":
      return `the sandbox refused to run "${name}": binary "${outcome.binary}" is ${outcome.reason}`;
    case "timeout":
      return `"${name}" did not terminate and was killed after ${String(outcome.timeoutMs)}ms`;
    case "output-truncated":
      return `"${name}" produced ${String(outcome.bytes)} bytes of output, over the ${String(outcome.limit)}-byte limit`;
    default:
      return `"${name}" exited with code ${String(outcome.exitCode)}`;
  }
}

/** True when the command RAN and reported success. Every other outcome is a failure. */
export function verificationPassed(outcome: SandboxOutcome): boolean {
  return outcome.status === "ok" && outcome.exitCode === 0;
}

// ── Selective verification (sc-12-8) ────────────────────────────────

/**
 * The project paths a change to which always earns the expensive suite.
 *
 * `src/**` by default, which is deliberately the conservative answer: with no configuration
 * at all, every source change runs the full suite, exactly as the imperative pipeline does.
 * Selectivity is something a project opts INTO by narrowing this list.
 */
export const DEFAULT_HIGH_RISK_PATHS: readonly string[] = ["src/**"];

/** Below this, an iteration earns the expensive suite whatever it touched. */
export const DEFAULT_QUALITY_SCORE_THRESHOLD = 70;

/** Paths whose change cannot break a test, so a diff made only of them is cheap. */
const DOC_PATH = /(^|\/)(docs?|\.bober\/(research|specs|architecture))\//i;
const DOC_EXTENSION = /\.(md|mdx|txt|rst|adoc)$/i;

/** True when `path` is documentation rather than something a test can observe. */
export function isDocumentationPath(path: string): boolean {
  return DOC_PATH.test(path) || DOC_EXTENSION.test(path);
}

/**
 * Match `path` against one declared pattern.
 *
 * A deliberately small matcher: a `**` matches any remainder, a `*` matches within one
 * segment, everything else is literal. Anything richer would be a glob library, and a glob
 * library is a dependency this sprint may not add (nonGoal 1).
 */
export function matchesPathPattern(path: string, pattern: string): boolean {
  const escaped = pattern
    .split("**")
    .map((part) =>
      part
        .replace(/[.+^${}()|[\]\\]/g, "\\$&")
        .replace(/\*/g, "[^/]*"),
    )
    .join(".*");
  return new RegExp(`^${escaped}$`).test(path);
}

export const SELECTIVE_VERIFICATION_REASONS = [
  "no-changes",
  "docs-only",
  "high-risk-path",
  "low-quality-score",
  "low-risk-and-passing",
] as const;
export const SelectiveVerificationReasonSchema = z.enum(SELECTIVE_VERIFICATION_REASONS);
export type SelectiveVerificationReason = z.infer<typeof SelectiveVerificationReasonSchema>;

export interface SelectiveVerificationDecision {
  readonly runExpensive: boolean;
  readonly reason: SelectiveVerificationReason;
  /** The high-risk paths the diff actually touched, for the trace and the critique. */
  readonly triggeredBy: readonly string[];
}

export interface SelectiveVerificationInput {
  /** The files this iteration changed, as the generator reported them. */
  readonly changedFiles: readonly string[];
  /** The intermediate quality score, from the evaluator's own aggregate. */
  readonly qualityScore: number;
  readonly highRiskPaths?: readonly string[];
  readonly threshold?: number;
}

/**
 * Whether this iteration earns the expensive suite.
 *
 * The three branches are ORDERED, and the order is the specification:
 *
 *  1. a diff made only of documentation cannot break a test, so it skips — and skips even
 *    on a low score, because re-running a suite against a docs-only change re-measures the
 *    previous iteration rather than this one;
 *  2. a diff touching a declared high-risk path runs it, whatever the score says;
 *  3. a low-risk diff whose intermediate quality score is below threshold runs it anyway —
 *    the score is evidence that something is wrong that the path list did not predict.
 *
 * Everything else skips. With the default `src/**` high-risk list that is a narrow set,
 * which is intended: selectivity is opt-in (see {@link DEFAULT_HIGH_RISK_PATHS}).
 */
export function selectVerification(
  input: SelectiveVerificationInput,
): SelectiveVerificationDecision {
  const changed = input.changedFiles;
  if (changed.length === 0) {
    return { runExpensive: false, reason: "no-changes", triggeredBy: [] };
  }
  if (changed.every((path) => isDocumentationPath(path))) {
    return { runExpensive: false, reason: "docs-only", triggeredBy: [] };
  }

  const patterns = input.highRiskPaths ?? DEFAULT_HIGH_RISK_PATHS;
  const triggeredBy = changed
    .filter((path) => patterns.some((pattern) => matchesPathPattern(path, pattern)))
    .sort();
  if (triggeredBy.length > 0) {
    return { runExpensive: true, reason: "high-risk-path", triggeredBy };
  }

  const threshold = input.threshold ?? DEFAULT_QUALITY_SCORE_THRESHOLD;
  if (input.qualityScore < threshold) {
    return { runExpensive: true, reason: "low-quality-score", triggeredBy: [] };
  }
  return { runExpensive: false, reason: "low-risk-and-passing", triggeredBy: [] };
}

/** The selective-verification settings a project declares, with the shipped defaults. */
export function selectiveVerificationSettings(config: BoberConfig): {
  highRiskPaths: readonly string[];
  threshold: number;
} {
  const declared = config.pge?.selectiveVerification;
  return {
    highRiskPaths: declared?.highRiskPaths ?? DEFAULT_HIGH_RISK_PATHS,
    threshold: declared?.qualityScoreThreshold ?? DEFAULT_QUALITY_SCORE_THRESHOLD,
  };
}

// ── Contract vocabulary ─────────────────────────────────────────────

/**
 * The verification methods a contract's own criteria ask for.
 *
 * The contract's `verificationMethod` enum (`contracts/sprint-contract.ts:55-64`) is the
 * vocabulary assumption 1 of the sprint contract names, so it is READ rather than
 * paralleled: a criterion asking for `playwright` asks for something this layer cannot run,
 * and that shows up as an empty command rather than as a silent pass.
 */
export function requestedMethods(contract: SprintContract): VerificationMethod[] {
  const methods = new Set<VerificationMethod>();
  for (const criterion of contract.successCriteria) {
    methods.add(VerificationMethodSchema.parse(criterion.verificationMethod));
  }
  return [...methods].sort();
}
