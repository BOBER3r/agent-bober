/**
 * Token / agent budget tracking for a workflow run.
 *
 * Bounds the cost of a fan-out so a runaway script (parallel × retries × N
 * sprints) can't spend without limit. Mirrors the intent of Claude Code's
 * per-run budget: a hard ceiling on agents and an optional token ceiling.
 *
 * The {@link Scheduler} owns the live agent-count runaway guard for a single
 * fan-out; `Budget` is the run-level accountant the interpreter (Sprint 3)
 * charges as agents complete, surfacing `spent`/`remaining` for dynamic
 * loops (`while (budget.remainingTokens() > 50_000) { ... }`).
 */

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
}

export interface BudgetOptions {
  /** Max total (input+output) tokens. `null`/omitted = unlimited. */
  maxTokens?: number | null;
  /** Max agent executions charged to this budget. `null`/omitted = unlimited. */
  maxAgents?: number | null;
  /** Max total USD cost charged to this budget. `null`/omitted = unlimited. */
  maxUsd?: number | null;
}

/** Raised by {@link Budget.assertWithinBudget} when a ceiling is exceeded. */
export class BudgetExceededError extends Error {
  constructor(
    message: string,
    /** Which ceiling was hit. */
    readonly kind: "tokens" | "agents" | "usd",
  ) {
    super(message);
    this.name = "BudgetExceededError";
  }
}

export class Budget {
  private inputTokens = 0;
  private outputTokens = 0;
  private agents = 0;
  private usd = 0;

  constructor(private readonly opts: BudgetOptions = {}) {}

  /** Record an agent's token usage. */
  chargeTokens(usage: TokenUsage): void {
    this.inputTokens += usage.inputTokens;
    this.outputTokens += usage.outputTokens;
  }

  /** Record `n` agent executions (default 1). */
  chargeAgents(n = 1): void {
    this.agents += n;
  }

  /**
   * Record a USD charge. Non-finite (`NaN`, `Infinity`, `-Infinity`) or
   * negative values are treated as 0 (no-op) rather than corrupting the
   * running total — a malformed/absent `costUsd` must never crash or
   * silently under/over-charge the budget.
   */
  chargeUsd(usd: number): void {
    if (!Number.isFinite(usd) || usd < 0) return;
    this.usd += usd;
  }

  /** Total tokens spent (input + output). */
  get tokensSpent(): number {
    return this.inputTokens + this.outputTokens;
  }

  /** Agent executions charged so far. */
  get agentsSpent(): number {
    return this.agents;
  }

  /** Total USD charged so far. */
  get usdSpent(): number {
    return this.usd;
  }

  /** Remaining token headroom, or `Infinity` when uncapped. */
  remainingTokens(): number {
    const max = this.opts.maxTokens;
    if (max === null || max === undefined) return Infinity;
    return Math.max(0, max - this.tokensSpent);
  }

  /** Remaining agent headroom, or `Infinity` when uncapped. */
  remainingAgents(): number {
    const max = this.opts.maxAgents;
    if (max === null || max === undefined) return Infinity;
    return Math.max(0, max - this.agents);
  }

  /** Remaining USD headroom, or `Infinity` when uncapped. */
  remainingUsd(): number {
    const max = this.opts.maxUsd;
    if (max === null || max === undefined) return Infinity;
    return Math.max(0, max - this.usd);
  }

  /** True once any configured ceiling has been reached or passed. */
  exceeded(): boolean {
    return (
      this.remainingTokens() === 0 ||
      this.remainingAgents() === 0 ||
      this.remainingUsd() === 0
    );
  }

  /**
   * Throw {@link BudgetExceededError} if a ceiling has been reached. Call before
   * dispatching the next agent to fail fast on the offending dimension.
   */
  assertWithinBudget(): void {
    if (this.remainingTokens() === 0) {
      throw new BudgetExceededError(
        `Token budget exhausted (${String(this.opts.maxTokens ?? 0)} tokens).`,
        "tokens",
      );
    }
    if (this.remainingAgents() === 0) {
      throw new BudgetExceededError(
        `Agent budget exhausted (${String(this.opts.maxAgents ?? 0)} agents).`,
        "agents",
      );
    }
    if (this.remainingUsd() === 0) {
      throw new BudgetExceededError(
        `USD budget exhausted ($${String(this.opts.maxUsd ?? 0)}).`,
        "usd",
      );
    }
  }
}
