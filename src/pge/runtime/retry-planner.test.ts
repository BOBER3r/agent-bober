import { describe, expect, it } from "vitest";

import { classifyTransient } from "../../orchestrator/workflow/retry.js";
import { OverallStateSchema } from "../state/overall.js";
import {
  DEFAULT_MAX_ATTEMPTS,
  createRetryPlanner,
  noRetryPlanner,
} from "./retry-planner.js";

/**
 * sc-9-2 (the jitter envelope), sc-9-3 (the attempt budget) and sc-9-8 (what is retried).
 *
 * ── The clock is injected, always ──
 *
 * Nothing here waits. `sleep` is a recorder that advances a VIRTUAL now and resolves
 * immediately, so the intervals asserted below are the intervals the policy asked for
 * rather than the intervals a loaded CI box happened to deliver. The suite asserts that
 * too: several hundred milliseconds of scheduled backoff pass while the wall clock barely
 * moves, which is only possible if no real timer ran.
 *
 * ── The envelope, not the value ──
 *
 * `withRetry` jitters each delay to 50–100% of `min(maxDelayMs, baseDelayMs * factor**n)`.
 * Pinning an exact number would pin the jitter source, so every timing assertion here is
 * membership in `[0.5 * raw, raw]` and is run against two very different jitter sequences.
 *
 * ── Mutation-proven ──
 *
 * Run against four deliberate breakages, and failed on each:
 *  - `maxRetries: maxAttempts` instead of `maxAttempts - 1` (four invocations, not three);
 *  - `isTransient: () => true`, which retries the schema-violation and HTTP-4xx rows;
 *  - `raw = min(maxDelayMs, baseDelayMs)`, a FLAT backoff, which falls below the envelope
 *    floor from the second retry onward;
 *  - `delayMs = raw * (1 + 0.5 * jitter())`, which overshoots the envelope ceiling.
 *
 * Deliberately NOT proven against `delayMs = raw` — that value is inside the envelope, and
 * a test that rejected it would be pinning the jitter source, which the criterion forbids.
 */

const TARGET = {
  nodeId: "sprint_generate",
  branchKey: "sprint-golden-2",
  taskKey: "task-key-branch-2",
} as const;

/** A recording clock: advances a virtual `now`, resolves at once, never schedules a timer. */
function virtualClock(jitters: readonly number[] = [0.5]) {
  const stamps: number[] = [];
  const delays: number[] = [];
  let now = 0;
  let cursor = 0;
  return {
    stamps,
    delays,
    sleep: (ms: number): Promise<void> => {
      delays.push(ms);
      now += ms;
      stamps.push(now);
      return Promise.resolve();
    },
    jitter: (): number => {
      const value = jitters[Math.min(cursor, jitters.length - 1)];
      cursor += 1;
      return value;
    },
  };
}

function http(status: number): Error {
  // A neutral message on purpose: the message regex must not be what decides these rows,
  // or the table would prove nothing about status classification.
  return Object.assign(new Error("provider said no"), { status });
}

function netCode(code: string): Error {
  return Object.assign(new Error("provider said no"), { code });
}

/** A REAL schema violation, produced by parsing, not a hand-made stand-in. */
function realSchemaViolation(): unknown {
  try {
    OverallStateSchema.parse({});
    throw new Error("OverallStateSchema.parse({}) was expected to throw");
  } catch (error) {
    return error;
  }
}

// ── sc-9-3: the attempt budget ───────────────────────────────────────

describe("the retry planner spends ATTEMPTS, not retries (sc-9-3)", () => {
  it("defaults to three invocations and rethrows the last error", async () => {
    const clock = virtualClock();
    const planner = createRetryPlanner({ baseDelayMs: 100, sleep: clock.sleep, jitter: clock.jitter });
    const boom = http(503);
    let calls = 0;

    await expect(
      planner.run(async () => {
        calls += 1;
        return Promise.reject(boom);
      }, TARGET),
    ).rejects.toBe(boom);

    // The trap this pins: `withRetry`'s `maxRetries` counts retries AFTER the first call,
    // so passing the attempt budget straight through would produce FOUR invocations.
    expect(DEFAULT_MAX_ATTEMPTS).toBe(3);
    expect(calls).toBe(3);
    expect(planner.attemptsFor(TARGET.taskKey)).toBe(3);
    expect(planner.history()).toHaveLength(2);
    expect(planner.history().map((a) => a.attempt)).toEqual([1, 2]);
    expect(planner.history().every((a) => a.branchKey === TARGET.branchKey)).toBe(true);
    expect(planner.history().every((a) => a.errorClass === "Error")).toBe(true);
  });

  it("honours a configured budget exactly, at 1 and at 5", async () => {
    for (const maxAttempts of [1, 2, 5]) {
      const clock = virtualClock();
      const planner = createRetryPlanner({
        maxAttempts,
        baseDelayMs: 10,
        sleep: clock.sleep,
        jitter: clock.jitter,
      });
      let calls = 0;
      await expect(
        planner.run(async () => {
          calls += 1;
          return Promise.reject(http(429));
        }, TARGET),
      ).rejects.toBeInstanceOf(Error);
      expect(calls, `budget ${String(maxAttempts)}`).toBe(maxAttempts);
      expect(planner.attemptsFor(TARGET.taskKey)).toBe(maxAttempts);
    }
  });

  it("stops at the first success and reports the attempts it actually spent", async () => {
    const clock = virtualClock();
    const planner = createRetryPlanner({ baseDelayMs: 10, sleep: clock.sleep, jitter: clock.jitter });
    let calls = 0;
    const value = await planner.run(async () => {
      calls += 1;
      if (calls < 2) return Promise.reject(http(503));
      return "done";
    }, TARGET);

    expect(value).toBe("done");
    expect(calls).toBe(2);
    expect(planner.attemptsFor(TARGET.taskKey)).toBe(2);
    expect(planner.attemptsFor("a-task-this-policy-never-ran")).toBe(0);
  });

  it("noRetryPlanner is one attempt and no routing — today's semantics, named", async () => {
    const planner = noRetryPlanner();
    expect(planner.maxAttempts).toBe(1);
    expect(planner.onExhausted).toBe("drop");

    let calls = 0;
    await expect(
      planner.run(async () => {
        calls += 1;
        return Promise.reject(http(503));
      }, TARGET),
    ).rejects.toBeInstanceOf(Error);
    expect(calls).toBe(1);
    expect(planner.history()).toEqual([]);
  });
});

// ── sc-9-8: what is retried, and what is not ─────────────────────────

describe("only failures classifyTransient accepts are retried (sc-9-8)", () => {
  const RETRIED = [
    { name: "HTTP 408", error: http(408) },
    { name: "HTTP 429", error: http(429) },
    { name: "HTTP 500", error: http(500) },
    { name: "HTTP 502", error: http(502) },
    { name: "HTTP 503", error: http(503) },
    { name: "HTTP 504", error: http(504) },
    { name: "HTTP 529", error: http(529) },
    { name: "ECONNRESET", error: netCode("ECONNRESET") },
    { name: "ETIMEDOUT", error: netCode("ETIMEDOUT") },
    { name: "rate limit message", error: new Error("rate limit exceeded, try again") },
  ] as const;

  const NOT_RETRIED = [
    { name: "HTTP 400", error: http(400) },
    { name: "HTTP 401", error: http(401) },
    { name: "HTTP 404", error: http(404) },
    { name: "schema violation", error: realSchemaViolation() },
    { name: "programming error", error: new TypeError("cannot read property of undefined") },
  ] as const;

  it.each(RETRIED)("retries $name to the full budget", async ({ error }) => {
    expect(classifyTransient(error)).toBe(true);
    const clock = virtualClock();
    const planner = createRetryPlanner({ baseDelayMs: 5, sleep: clock.sleep, jitter: clock.jitter });
    let calls = 0;
    await expect(
      planner.run(async () => {
        calls += 1;
        return Promise.reject(error);
      }, TARGET),
    ).rejects.toBe(error);
    expect(calls).toBe(3);
    expect(clock.delays).toHaveLength(2);
  });

  it.each(NOT_RETRIED)("raises $name on the first attempt", async ({ error }) => {
    expect(classifyTransient(error)).toBe(false);
    const clock = virtualClock();
    const planner = createRetryPlanner({ baseDelayMs: 5, sleep: clock.sleep, jitter: clock.jitter });
    let calls = 0;
    await expect(
      planner.run(async () => {
        calls += 1;
        return Promise.reject(error);
      }, TARGET),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(planner.attemptsFor(TARGET.taskKey)).toBe(1);
    expect(planner.history()).toEqual([]);
    // Nothing slept, because nothing was scheduled.
    expect(clock.delays).toEqual([]);
  });

  it("is a REAL ZodError, not a look-alike, that the table calls non-transient", () => {
    const error = realSchemaViolation();
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).name).toBe("ZodError");
    expect(classifyTransient(error)).toBe(false);
  });
});

// ── sc-9-2: the jittered exponential envelope ────────────────────────

describe("successive retry delays fall inside the declared jitter envelope (sc-9-2)", () => {
  const BASE = 100;
  const FACTOR = 2;
  const MAX = 30_000;

  /** `min(maxDelayMs, baseDelayMs * factor**n)` — the policy's own un-jittered schedule. */
  function raw(n: number): number {
    return Math.min(MAX, BASE * FACTOR ** n);
  }

  async function exhaust(jitters: readonly number[]): Promise<ReturnType<typeof virtualClock>> {
    const clock = virtualClock(jitters);
    const planner = createRetryPlanner({
      maxAttempts: 5,
      baseDelayMs: BASE,
      factor: FACTOR,
      maxDelayMs: MAX,
      sleep: clock.sleep,
      jitter: clock.jitter,
    });
    await expect(planner.run(async () => Promise.reject(http(503)), TARGET)).rejects.toBeInstanceOf(
      Error,
    );
    return clock;
  }

  it.each([
    { name: "jitter floor", jitters: [0] },
    { name: "jitter ceiling", jitters: [0.999] },
    { name: "mixed jitter", jitters: [0.1, 0.9, 0.35, 0.66] },
  ])("keeps every interval inside [0.5*raw, raw] under $name", async ({ jitters }) => {
    const clock = await exhaust(jitters);
    expect(clock.delays).toHaveLength(4);

    // The INTERVALS between successive retry timestamps, which is what the criterion
    // names — derived from the stamps rather than re-read from the delays.
    const intervals = clock.stamps.map((stamp, i) => (i === 0 ? stamp : stamp - clock.stamps[i - 1]));
    intervals.forEach((interval, n) => {
      expect(interval, `interval ${String(n)} is the delay the policy asked for`).toBeCloseTo(
        clock.delays[n],
        6,
      );
    });

    intervals.forEach((interval, n) => {
      const ceiling = raw(n);
      expect(interval, `retry ${String(n + 1)} lower bound`).toBeGreaterThanOrEqual(
        0.5 * ceiling - 1e-9,
      );
      expect(interval, `retry ${String(n + 1)} upper bound`).toBeLessThanOrEqual(ceiling + 1e-9);
    });

    // The schedule really did GROW: a flat backoff would satisfy the envelope of retry 1
    // and nothing else, so pin that the ceilings differ.
    expect(raw(0)).toBe(100);
    expect(raw(3)).toBe(800);
  });

  it("caps the growth at maxDelayMs rather than growing without bound", async () => {
    const clock = virtualClock([1 - Number.EPSILON]);
    const planner = createRetryPlanner({
      maxAttempts: 8,
      baseDelayMs: 1000,
      factor: 10,
      maxDelayMs: 5000,
      sleep: clock.sleep,
      jitter: clock.jitter,
    });
    await expect(planner.run(async () => Promise.reject(http(503)), TARGET)).rejects.toBeInstanceOf(
      Error,
    );
    expect(clock.delays).toHaveLength(7);
    for (const delay of clock.delays) expect(delay).toBeLessThanOrEqual(5000);
    expect(Math.max(...clock.delays)).toBeGreaterThan(4000);
  });

  it("schedules real time without spending any: the injected clock is the only clock", async () => {
    const startedAt = Date.now();
    const clock = await exhaust([0.999]);
    const elapsedMs = Date.now() - startedAt;

    const scheduled = clock.delays.reduce((a, b) => a + b, 0);
    expect(scheduled).toBeGreaterThan(1000);
    // If a real timer had run, the wall clock would have moved by `scheduled`.
    expect(elapsedMs).toBeLessThan(scheduled / 2);
  });

  it("records which task each retry belonged to, so a branch can be named without the trace", async () => {
    const clock = virtualClock();
    const planner = createRetryPlanner({ baseDelayMs: 10, sleep: clock.sleep, jitter: clock.jitter });
    await expect(planner.run(async () => Promise.reject(http(503)), TARGET)).rejects.toBeInstanceOf(
      Error,
    );
    const other = { nodeId: "sprint_evaluate", branchKey: null, taskKey: "task-key-root" };
    await expect(planner.run(async () => Promise.reject(http(503)), other)).rejects.toBeInstanceOf(
      Error,
    );

    expect(planner.history().map((a) => a.branchKey)).toEqual([
      "sprint-golden-2",
      "sprint-golden-2",
      null,
      null,
    ]);
    expect(planner.attemptsFor(TARGET.taskKey)).toBe(3);
    expect(planner.attemptsFor(other.taskKey)).toBe(3);
  });
});
