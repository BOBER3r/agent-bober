/**
 * tick — idempotent recurring research scheduler (Sprint 4).
 *
 * Clock discipline: `now` is always injected — never call new Date() or Date.now()
 * inside this module. The wall clock is read ONLY at the CLI .action() boundary
 * (mirrors src/research/runner.ts:18-19 and src/state/facts.ts:18-21).
 *
 * Idempotency: after a job runs, its nextDueAt is advanced to
 * computeNextDue(cadence, now) which is strictly > now, so a second tick at
 * the same now evaluates due === false for that job (sc-4-3).
 *
 * Concurrency: single-process, no lock needed (two-person personal use case;
 * contract assumption L50).
 */

import { computeNextDue } from "./cadence.js";
import type { ResearchJob } from "./types.js";

// ── Public types ──────────────────────────────────────────────────────

/**
 * Injected dependencies for tick.
 * All I/O and the clock are injected so unit tests can bypass real providers
 * and SQLite (mirrors RunDeps in src/research/runner.ts:46-61).
 */
export interface TickDeps {
  /** Injected ISO-8601 instant — stamped at the CLI boundary; never read the clock here. */
  now: string;
  /** Load all stored jobs. CLI binds to () => listJobs(projectRoot). */
  listJobs: () => Promise<ResearchJob[]>;
  /**
   * Persist an advanced job.
   * CLI binds to (j) => addJob(projectRoot, j) which is an in-place upsert by id
   * (briefing Finding B — jobId hashes only question|createdAt, so id is stable
   * even after nextDueAt/lastRunAt are set).
   */
  saveJob: (job: ResearchJob) => Promise<void>;
  /**
   * Execute one due job.
   * CLI binds runResearchJob with queryModel/findingSink/now/vaultRoot already
   * bound (Sprint 2 runner, invoked UNCHANGED).
   */
  runJob: (job: ResearchJob) => Promise<void>;
}

/** Summary of a tick invocation — which jobs ran and which were skipped. */
export interface TickResult {
  /** ids of jobs that were due and ran. */
  ran: string[];
  /** ids of jobs skipped because nextDueAt > now. */
  skipped: string[];
}

// ── tick ──────────────────────────────────────────────────────────────

/**
 * Run every due job once, advance its nextDueAt, record lastRunAt, and persist.
 *
 * Selection rule: a job is due when
 *   - nextDueAt is undefined (never scheduled → due on first tick), OR
 *   - Date.parse(nextDueAt) <= Date.parse(now)
 *
 * Order: run FIRST, then advance + persist. If runJob throws, the job is NOT
 * persisted so it remains due on the next tick.
 *
 * Idempotency: on a second tick at the same now, all previously-run jobs have
 * nextDueAt > now (computeNextDue always advances by >= 1 day), so they are skipped.
 */
export async function tick(deps: TickDeps): Promise<TickResult> {
  const { now, listJobs, saveJob, runJob } = deps;

  const jobs = await listJobs();
  const ran: string[] = [];
  const skipped: string[] = [];

  const nowMs = Date.parse(now);

  for (const job of jobs) {
    // A job with no nextDueAt is due immediately on first tick.
    const isDue =
      job.nextDueAt === undefined ||
      Date.parse(job.nextDueAt) <= nowMs;

    if (!isDue) {
      skipped.push(job.id);
      continue;
    }

    // Run first — if runJob throws, we do not advance or persist.
    await runJob(job);

    // Advance scheduling fields using the injected now (no wall clock).
    const advanced: ResearchJob = {
      ...job,
      lastRunAt: now,
      nextDueAt: computeNextDue(job.cadence, now),
    };

    // Persist via the injected saveJob (= addJob upsert; same id → same file).
    await saveJob(advanced);

    ran.push(job.id);
  }

  return { ran, skipped };
}
