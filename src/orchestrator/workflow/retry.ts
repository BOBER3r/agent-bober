/**
 * Exponential-backoff retry for transient provider failures.
 *
 * Today the agentic loop ends on the first `client.chat()` error
 * (agentic-loop.ts), which is fragile when hammering a single local model
 * server (Ollama/vLLM return 429/503 under load). `withRetry` wraps a call in
 * bounded exponential backoff with jitter, retrying only TRANSIENT failures
 * (rate limits, overload, timeouts, network resets) and surfacing everything
 * else immediately.
 *
 * The scheduler / interpreter wraps each provider call in this, so every
 * provider benefits without per-adapter changes. `sleep` and `jitter` are
 * injectable so tests are deterministic and instant.
 */

// ── Transient classification ────────────────────────────────────────

function asRecord(err: unknown): Record<string, unknown> | undefined {
  return typeof err === "object" && err !== null
    ? (err as Record<string, unknown>)
    : undefined;
}

function getStatus(err: unknown): number | undefined {
  const e = asRecord(err);
  if (!e) return undefined;
  const s = e["status"] ?? e["statusCode"];
  return typeof s === "number" ? s : undefined;
}

function getCode(err: unknown): string | undefined {
  const e = asRecord(err);
  const c = e?.["code"];
  return typeof c === "string" ? c : undefined;
}

function getMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  const e = asRecord(err);
  const m = e?.["message"];
  return typeof m === "string" ? m : String(err);
}

const TRANSIENT_CODES = new Set([
  "ETIMEDOUT",
  "ECONNRESET",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "EPIPE",
  "ECONNABORTED",
]);

const TRANSIENT_MESSAGE =
  /rate.?limit|too many requests|overloaded|overload|temporarily|try again|timed? ?out|service unavailable|ECONNRESET|ETIMEDOUT|\b(?:429|500|502|503|504|529)\b/i;

/**
 * Heuristic: is this error worth retrying? True for HTTP 408/429 and 5xx,
 * known transient network codes, and overload/rate-limit/timeout messages.
 */
export function classifyTransient(err: unknown): boolean {
  const status = getStatus(err);
  if (status !== undefined) {
    if (status === 408 || status === 429) return true;
    if (status >= 500 && status < 600) return true;
  }
  const code = getCode(err);
  if (code && TRANSIENT_CODES.has(code)) return true;
  return TRANSIENT_MESSAGE.test(getMessage(err));
}

// ── withRetry ───────────────────────────────────────────────────────

export interface RetryOptions {
  /** Max retries AFTER the first attempt. Default 3 (=> up to 4 calls). */
  maxRetries?: number;
  /** Base delay in ms for the first backoff. Default 500. */
  baseDelayMs?: number;
  /** Upper bound on a single backoff delay. Default 30_000. */
  maxDelayMs?: number;
  /** Exponential growth factor. Default 2. */
  factor?: number;
  /** Returns a value in [0, 1) for jitter. Default Math.random. Inject for tests. */
  jitter?: () => number;
  /** Sleeps for `ms`. Default setTimeout-backed. Inject for tests. */
  sleep?: (ms: number) => Promise<void>;
  /** Decides whether an error is retryable. Default {@link classifyTransient}. */
  isTransient?: (err: unknown) => boolean;
  /** Called before each backoff sleep (for logging / telemetry). */
  onRetry?: (info: { attempt: number; delayMs: number; error: unknown }) => void;
}

const defaultSleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Run `fn`, retrying TRANSIENT failures with exponential backoff + jitter.
 * Non-transient errors and the final exhausted error are rethrown.
 *
 * Backoff for retry `n` (0-based): `min(maxDelayMs, baseDelayMs * factor**n)`,
 * then jittered to 50–100% of that value (decorrelated, avoids thundering herd).
 */
export async function withRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const maxRetries = opts.maxRetries ?? 3;
  const baseDelayMs = opts.baseDelayMs ?? 500;
  const maxDelayMs = opts.maxDelayMs ?? 30_000;
  const factor = opts.factor ?? 2;
  const jitter = opts.jitter ?? Math.random;
  const sleep = opts.sleep ?? defaultSleep;
  const isTransient = opts.isTransient ?? classifyTransient;

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    try {
      return await fn();
    } catch (error) {
      if (attempt === maxRetries || !isTransient(error)) {
        throw error;
      }
      const raw = Math.min(maxDelayMs, baseDelayMs * Math.pow(factor, attempt));
      const delayMs = raw * (0.5 + 0.5 * jitter());
      opts.onRetry?.({ attempt: attempt + 1, delayMs, error });
      await sleep(delayMs);
    }
  }

  // Unreachable: the loop either returns or throws on the final attempt.
  throw new Error("withRetry: retry loop exited unexpectedly.");
}
