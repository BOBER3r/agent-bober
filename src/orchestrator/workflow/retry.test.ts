/**
 * Unit tests for the exponential-backoff retry wrapper.
 *
 * Uses an injected `sleep` (records delays, never waits) and a fixed `jitter`
 * so every test is deterministic and instant.
 */

import { describe, it, expect, vi } from "vitest";

import { withRetry, classifyTransient } from "./retry.js";

/** A no-wait sleep that records the delays it was asked to wait. */
function recordingSleep() {
  const delays: number[] = [];
  return {
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      return Promise.resolve();
    },
  };
}

// ── classifyTransient ────────────────────────────────────────────────

describe("classifyTransient", () => {
  it("treats HTTP 429 and 5xx as transient", () => {
    expect(classifyTransient({ status: 429 })).toBe(true);
    expect(classifyTransient({ status: 503 })).toBe(true);
    expect(classifyTransient({ statusCode: 500 })).toBe(true);
    expect(classifyTransient({ status: 408 })).toBe(true);
  });

  it("treats 4xx (non-408/429) as non-transient", () => {
    expect(classifyTransient({ status: 400 })).toBe(false);
    expect(classifyTransient({ status: 401 })).toBe(false);
    expect(classifyTransient({ status: 404 })).toBe(false);
  });

  it("treats known network error codes as transient", () => {
    expect(classifyTransient({ code: "ECONNRESET" })).toBe(true);
    expect(classifyTransient({ code: "ETIMEDOUT" })).toBe(true);
    expect(classifyTransient({ code: "ENOTFOUND" })).toBe(true);
  });

  it("matches overload / rate-limit / timeout messages", () => {
    expect(classifyTransient(new Error("Rate limit exceeded"))).toBe(true);
    expect(classifyTransient(new Error("Overloaded, please retry"))).toBe(true);
    expect(classifyTransient(new Error("529 server overloaded"))).toBe(true);
    expect(classifyTransient(new Error("request timed out"))).toBe(true);
  });

  it("treats an ordinary error as non-transient", () => {
    expect(classifyTransient(new Error("invalid argument"))).toBe(false);
    expect(classifyTransient("nope")).toBe(false);
  });
});

// ── withRetry ────────────────────────────────────────────────────────

describe("withRetry", () => {
  it("returns immediately on first success (no sleep)", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.resolve("ok"));
    const out = await withRetry(fn, { sleep });
    expect(out).toBe("ok");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("retries transient failures then succeeds", async () => {
    const { delays, sleep } = recordingSleep();
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 3) return Promise.reject({ status: 429 });
      return Promise.resolve("recovered");
    });

    const out = await withRetry(fn, { sleep, jitter: () => 0, baseDelayMs: 100, factor: 2 });
    expect(out).toBe("recovered");
    expect(fn).toHaveBeenCalledTimes(3);
    // jitter()=0 => 50% of raw delay; raw = 100 * 2^attempt for attempts 0,1
    expect(delays).toEqual([50, 100]);
  });

  it("does NOT retry a non-transient error", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject(new Error("bad request")));
    await expect(withRetry(fn, { sleep })).rejects.toThrow("bad request");
    expect(fn).toHaveBeenCalledTimes(1);
    expect(delays).toHaveLength(0);
  });

  it("rethrows the last error after exhausting retries", async () => {
    const { sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject({ status: 503, message: "unavailable" }));
    await expect(
      withRetry(fn, { sleep, jitter: () => 0, maxRetries: 2 }),
    ).rejects.toMatchObject({ status: 503 });
    // 1 initial + 2 retries
    expect(fn).toHaveBeenCalledTimes(3);
  });

  it("caps the backoff delay at maxDelayMs", async () => {
    const { delays, sleep } = recordingSleep();
    const fn = vi.fn(() => Promise.reject({ status: 500 }));
    await expect(
      withRetry(fn, {
        sleep,
        jitter: () => 1, // full delay (100% of raw)
        maxRetries: 5,
        baseDelayMs: 1000,
        factor: 10,
        maxDelayMs: 5000,
      }),
    ).rejects.toBeDefined();
    // raw: 1000, 10000->cap 5000, 100000->cap 5000, ... ; jitter=1 => full
    expect(delays[0]).toBe(1000);
    expect(Math.max(...delays)).toBeLessThanOrEqual(5000);
  });

  it("invokes onRetry before each backoff", async () => {
    const { sleep } = recordingSleep();
    const onRetry = vi.fn();
    let calls = 0;
    const fn = vi.fn(() => {
      calls += 1;
      if (calls < 2) return Promise.reject({ status: 429 });
      return Promise.resolve("ok");
    });
    await withRetry(fn, { sleep, jitter: () => 0, onRetry });
    expect(onRetry).toHaveBeenCalledTimes(1);
    expect(onRetry.mock.calls[0]?.[0]).toMatchObject({ attempt: 1 });
  });
});
