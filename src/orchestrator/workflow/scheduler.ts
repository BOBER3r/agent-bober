/**
 * Concurrency scheduler for the local-model workflow runtime.
 *
 * Mirrors the execution model of Claude Code's dynamic-workflow runtime:
 *   - `parallel(thunks)` — barrier; runs all thunks with bounded concurrency
 *     and awaits them all (order-preserving). Use for lens panels / N skeptics.
 *   - `pipeline(items, ...stages)` — per-item, NO barrier between stages; each
 *     item flows through every stage independently, so item A can be in stage 3
 *     while item B is still in stage 1. Total concurrent stage executions are
 *     bounded by the same cap.
 *
 * Concurrency is enforced by a hand-off semaphore (true bounded concurrency,
 * unlike chunk-batching which idles fast tasks waiting on a slow one). A live
 * agent counter caps total executions over the scheduler's lifetime (the
 * runaway guard — Claude Code uses 1000/run).
 */

import * as os from "node:os";

// ── Errors ──────────────────────────────────────────────────────────

/** Raised when a scheduler exceeds its lifetime agent-execution cap. */
export class AgentCapError extends Error {
  constructor(
    message: string,
    /** The cap that was hit. */
    readonly cap: number,
  ) {
    super(message);
    this.name = "AgentCapError";
  }
}

// ── Default concurrency ─────────────────────────────────────────────

/**
 * The default concurrency cap: `min(16, cores - 2)`, floored at 1. Matches the
 * Claude Code dynamic-workflow runtime. For local model servers the real bound
 * is usually the server's slot count (e.g. Ollama's OLLAMA_NUM_PARALLEL), so
 * callers should override `maxConcurrent` to match their backend.
 */
export function defaultConcurrency(): number {
  const cores = os.cpus().length;
  return Math.max(1, Math.min(16, cores - 2));
}

// ── Hand-off semaphore ──────────────────────────────────────────────

/**
 * A counting semaphore with FIFO hand-off: when a holder releases and a waiter
 * is queued, the slot transfers directly to that waiter (the active count never
 * dips), giving true peak-concurrency === cap regardless of task duration.
 */
export class Semaphore {
  private active = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(private readonly cap: number) {
    if (cap < 1) throw new Error(`Semaphore cap must be >= 1 (got ${String(cap)}).`);
  }

  async acquire(): Promise<void> {
    if (this.active < this.cap) {
      this.active += 1;
      return;
    }
    // Full: queue and wait. release() hands us the slot (active stays at cap),
    // so we do NOT increment when resumed.
    await new Promise<void>((resolve) => this.waiters.push(resolve));
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      next(); // hand the slot over; active unchanged
    } else {
      this.active -= 1;
    }
  }

  /** Number of currently-held slots (for tests / introspection). */
  get inFlight(): number {
    return this.active;
  }
}

// ── Scheduler ───────────────────────────────────────────────────────

export interface SchedulerOptions {
  /** Max concurrent task executions. Default {@link defaultConcurrency}. */
  maxConcurrent?: number;
  /** Hard ceiling on total executions over this scheduler's lifetime. Default 1000. */
  maxAgents?: number;
}

/** A pipeline stage: receives the previous stage's output, the original item, and its index. */
export type Stage<I> = (prev: unknown, item: I, index: number) => Promise<unknown>;

export class Scheduler {
  readonly maxConcurrent: number;
  readonly maxAgents: number;
  private readonly sem: Semaphore;
  private agentsStarted = 0;

  constructor(opts: SchedulerOptions = {}) {
    this.maxConcurrent = opts.maxConcurrent ?? defaultConcurrency();
    this.maxAgents = opts.maxAgents ?? 1000;
    this.sem = new Semaphore(Math.max(1, this.maxConcurrent));
  }

  /** Total task executions started over this scheduler's lifetime. */
  get agentsRun(): number {
    return this.agentsStarted;
  }

  /** Acquire a slot, run, release — counting the execution against the cap. */
  private async run<T>(thunk: () => Promise<T>): Promise<T> {
    if (this.agentsStarted >= this.maxAgents) {
      throw new AgentCapError(
        `Scheduler agent cap exceeded (${String(this.maxAgents)} executions).`,
        this.maxAgents,
      );
    }
    this.agentsStarted += 1;
    await this.sem.acquire();
    try {
      return await thunk();
    } finally {
      this.sem.release();
    }
  }

  /**
   * Run all thunks concurrently (bounded by the cap) and await them all.
   * Results are index-aligned with `thunks`. A thunk that throws rejects the
   * whole call (use try/catch inside the thunk for {@link Promise.allSettled}-style
   * tolerance).
   */
  async parallel<T>(thunks: ReadonlyArray<() => Promise<T>>): Promise<T[]> {
    return Promise.all(thunks.map((t) => this.run(t)));
  }

  /**
   * Run each item through every stage independently — no barrier between
   * stages. Returns an array index-aligned with `items`. A stage that throws
   * (other than {@link AgentCapError}) drops that item to `null` and skips its
   * remaining stages; the runaway-cap error propagates.
   */
  async pipeline<I>(items: ReadonlyArray<I>, ...stages: Array<Stage<I>>): Promise<unknown[]> {
    return Promise.all(
      items.map(async (item, index) => {
        let acc: unknown = item;
        for (const stage of stages) {
          try {
            acc = await this.run(() => stage(acc, item, index));
          } catch (e) {
            if (e instanceof AgentCapError) throw e;
            return null;
          }
        }
        return acc;
      }),
    );
  }
}

// ── mapBounded (drop-in for the legacy panel helper) ────────────────

/**
 * Map over `items` applying `fn` with at most `cap` concurrent calls, preserving
 * input order. Backed by a hand-off {@link Semaphore} (true bounded concurrency,
 * superseding the chunk-batching copies previously duplicated in the evaluator
 * and architect agents).
 */
export async function mapBounded<T, R>(
  items: ReadonlyArray<T>,
  cap: number,
  fn: (x: T) => Promise<R>,
): Promise<R[]> {
  const sem = new Semaphore(Math.max(1, cap));
  return Promise.all(
    items.map(async (item) => {
      await sem.acquire();
      try {
        return await fn(item);
      } finally {
        sem.release();
      }
    }),
  );
}
