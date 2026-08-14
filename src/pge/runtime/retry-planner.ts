import { classifyTransient, withRetry } from "../../orchestrator/workflow/retry.js";
import type { RetryOptions } from "../../orchestrator/workflow/retry.js";

/**
 * The retry POLICY, and nothing else.
 *
 * ── Why there is no backoff arithmetic in this file ──
 *
 * `src/orchestrator/workflow/retry.ts` already implements bounded exponential backoff
 * decorrelated to 50–100% of `min(maxDelayMs, baseDelayMs * factor**n)`, with `sleep`,
 * `jitter` and `isTransient` injectable, and it is green. ADR-8 retains that module
 * permanently and says this layer is what finally gives it a caller. So this planner owns
 * three decisions the shared helper deliberately does not make —
 *
 *   1. how many ATTEMPTS a task gets (not how many retries; see the mapping below),
 *   2. what a task that has spent them all does to the run, and
 *   3. what was retried, so a failed branch can be described without reading the trace —
 *
 * and delegates the schedule itself. There is no `Math.pow`, no `Math.random`, no
 * `Date.now()` and no `setTimeout` anywhere below: every one of those is
 * {@link withRetry}'s job or the injected clock's, and a second implementation of them is
 * an explicit non-goal of the sprint that introduced this file.
 *
 * ── attempts vs retries ──
 *
 * `RetryOptions.maxRetries` counts retries AFTER the first call, so `maxRetries: 3` is
 * FOUR invocations. {@link RetryPolicy.maxAttempts} counts INVOCATIONS, because that is
 * the number a caller reasons about ("a permanently failing node is called three times"),
 * and the two are one off. The mapping lives here, once, so no call site has to remember
 * it.
 *
 * ── Scope ──
 *
 * A policy retries the thunk it is handed. The interpreter hands it ONE node execution of
 * ONE branch, so "retry the failed branch only, never the superstep and never the fan-out
 * batch" is true by construction rather than by discipline.
 */

/** Total invocations one task gets, including the first. */
export const DEFAULT_MAX_ATTEMPTS = 3;

/** Which task an attempt belongs to. `taskKey` is what {@link RetryPolicy.attemptsFor} keys on. */
export interface RetryTarget {
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly taskKey: string;
}

/** One recorded retry: which task, which retry index, and how long the policy waited. */
export interface RetryAttempt extends RetryTarget {
  /** 1-based RETRY index — the first retry is 1, so `attempt` never counts the first call. */
  readonly attempt: number;
  readonly delayMs: number;
  readonly errorClass: string;
}

/** What a task that has spent every attempt does to the run. */
export type ExhaustedPolicy = "graceful" | "drop";

export interface RetryPolicy {
  /** Total invocations one task gets, including the first. Never below 1. */
  readonly maxAttempts: number;
  /**
   * `"graceful"` routes the run to the graceful-failure terminal declared by the
   * artifact; `"drop"` records the failure, releases the branch and does nothing else —
   * which is the behaviour every superstep-loop test written before this policy existed
   * was written against.
   */
  readonly onExhausted: ExhaustedPolicy;
  /** Run `fn` under the shared backoff, recording each retry against `target`. */
  run<T>(fn: () => Promise<T>, target: RetryTarget): Promise<T>;
  /** Invocations actually spent on `taskKey`, or 0 for a task this policy never ran. */
  attemptsFor(taskKey: string): number;
  /** Every retry this policy performed, in the order it performed them. */
  history(): readonly RetryAttempt[];
}

export interface RetryPlannerOptions extends Omit<RetryOptions, "maxRetries" | "onRetry"> {
  /** Total invocations per task, including the first. Default {@link DEFAULT_MAX_ATTEMPTS}. */
  maxAttempts?: number;
  /** Default `"graceful"`. */
  onExhausted?: ExhaustedPolicy;
}

/** `Error.name`, or the typeof for a thrown non-Error. Mirrors the interpreter's own rule. */
function errorClassOf(reason: unknown): string {
  return reason instanceof Error ? reason.name : typeof reason;
}

/** The backoff knobs, forwarded verbatim; the policy adds nothing to them. */
function backoffOf(options: RetryPlannerOptions): RetryOptions {
  const backoff: RetryOptions = {};
  if (options.baseDelayMs !== undefined) backoff.baseDelayMs = options.baseDelayMs;
  if (options.maxDelayMs !== undefined) backoff.maxDelayMs = options.maxDelayMs;
  if (options.factor !== undefined) backoff.factor = options.factor;
  if (options.jitter !== undefined) backoff.jitter = options.jitter;
  if (options.sleep !== undefined) backoff.sleep = options.sleep;
  return backoff;
}

/**
 * A policy that retries TRANSIENT failures only.
 *
 * `isTransient` defaults to {@link classifyTransient} — the shared classifier, not a
 * second heuristic — so an `UndeclaredRouteLabelError`, a schema violation or any other
 * deterministic node bug is raised on the first attempt instead of burning the budget on
 * something that cannot succeed.
 */
export function createRetryPlanner(options: RetryPlannerOptions = {}): RetryPolicy {
  const maxAttempts = Math.max(1, Math.trunc(options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS));
  const onExhausted: ExhaustedPolicy = options.onExhausted ?? "graceful";
  const isTransient = options.isTransient ?? classifyTransient;
  const backoff = backoffOf(options);

  const spent = new Map<string, number>();
  const log: RetryAttempt[] = [];

  return {
    maxAttempts,
    onExhausted,
    run<T>(fn: () => Promise<T>, target: RetryTarget): Promise<T> {
      // Set BEFORE the first call, so a task that throws on attempt 1 and is never
      // retried still reports one spent attempt rather than none.
      spent.set(target.taskKey, 1);
      return withRetry(fn, {
        ...backoff,
        maxRetries: maxAttempts - 1,
        isTransient,
        onRetry: (info) => {
          spent.set(target.taskKey, info.attempt + 1);
          log.push({
            nodeId: target.nodeId,
            branchKey: target.branchKey,
            taskKey: target.taskKey,
            attempt: info.attempt,
            delayMs: info.delayMs,
            errorClass: errorClassOf(info.error),
          });
        },
      });
    },
    attemptsFor(taskKey: string): number {
      return spent.get(taskKey) ?? 0;
    },
    history(): readonly RetryAttempt[] {
      return log;
    },
  };
}

/**
 * One attempt, no routing: exactly what the interpreter does when no policy is supplied.
 *
 * Kept as a named constructor rather than left implicit so a caller can say "no retry"
 * without the reader having to work out what an absent policy means.
 */
export function noRetryPlanner(): RetryPolicy {
  return createRetryPlanner({ maxAttempts: 1, onExhausted: "drop" });
}
