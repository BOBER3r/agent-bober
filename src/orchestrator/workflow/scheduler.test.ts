/**
 * Unit tests for the workflow concurrency scheduler.
 *
 * Covers: hand-off semaphore peak-concurrency, Scheduler.parallel ordering +
 * bounded concurrency + agent counting, the maxAgents runaway cap,
 * Scheduler.pipeline per-item staging + drop-to-null on stage throw, and the
 * mapBounded drop-in.
 */

import { describe, it, expect } from "vitest";

import {
  Scheduler,
  Semaphore,
  AgentCapError,
  defaultConcurrency,
  mapBounded,
} from "./scheduler.js";

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Wrap a worker so it records the peak number of simultaneously-active calls.
 */
function concurrencyTracker() {
  let active = 0;
  let peak = 0;
  return {
    get peak() {
      return peak;
    },
    run: async <T>(value: T, ms = 10): Promise<T> => {
      active += 1;
      peak = Math.max(peak, active);
      await delay(ms);
      active -= 1;
      return value;
    },
  };
}

// ── Semaphore ────────────────────────────────────────────────────────

describe("Semaphore", () => {
  it("rejects a cap below 1", () => {
    expect(() => new Semaphore(0)).toThrow();
  });

  it("caps peak concurrency at the configured value", async () => {
    const sem = new Semaphore(2);
    const tracker = concurrencyTracker();
    await Promise.all(
      [1, 2, 3, 4, 5].map(async (n) => {
        await sem.acquire();
        try {
          return await tracker.run(n);
        } finally {
          sem.release();
        }
      }),
    );
    expect(tracker.peak).toBe(2);
  });

  it("hands a slot directly to the next waiter (active never dips)", async () => {
    const sem = new Semaphore(1);
    await sem.acquire();
    expect(sem.inFlight).toBe(1);

    let secondAcquired = false;
    const second = sem.acquire().then(() => {
      secondAcquired = true;
    });

    // Still held by the first acquirer.
    await delay(5);
    expect(secondAcquired).toBe(false);
    expect(sem.inFlight).toBe(1);

    sem.release(); // hands the slot to the waiter; inFlight stays at 1
    await second;
    expect(secondAcquired).toBe(true);
    expect(sem.inFlight).toBe(1);
  });
});

// ── defaultConcurrency ──────────────────────────────────────────────

describe("defaultConcurrency", () => {
  it("is within [1, 16]", () => {
    const c = defaultConcurrency();
    expect(c).toBeGreaterThanOrEqual(1);
    expect(c).toBeLessThanOrEqual(16);
  });
});

// ── Scheduler.parallel ──────────────────────────────────────────────

describe("Scheduler.parallel", () => {
  it("returns results index-aligned with thunks", async () => {
    const s = new Scheduler({ maxConcurrent: 2 });
    const out = await s.parallel([
      () => Promise.resolve("a"),
      () => Promise.resolve("b"),
      () => Promise.resolve("c"),
    ]);
    expect(out).toEqual(["a", "b", "c"]);
  });

  it("bounds concurrency to maxConcurrent", async () => {
    const s = new Scheduler({ maxConcurrent: 3 });
    const tracker = concurrencyTracker();
    await s.parallel(
      Array.from({ length: 9 }, (_, i) => () => tracker.run(i)),
    );
    expect(tracker.peak).toBe(3);
  });

  it("counts each execution against agentsRun", async () => {
    const s = new Scheduler({ maxConcurrent: 4 });
    await s.parallel([() => Promise.resolve(1), () => Promise.resolve(2)]);
    expect(s.agentsRun).toBe(2);
  });

  it("propagates a thunk rejection", async () => {
    const s = new Scheduler({ maxConcurrent: 2 });
    await expect(
      s.parallel([
        () => Promise.resolve(1),
        () => Promise.reject(new Error("boom")),
      ]),
    ).rejects.toThrow("boom");
  });

  it("handles an empty thunk list", async () => {
    const s = new Scheduler();
    expect(await s.parallel([])).toEqual([]);
  });
});

// ── Scheduler maxAgents (runaway cap) ───────────────────────────────

describe("Scheduler maxAgents", () => {
  it("throws AgentCapError once the lifetime cap is exceeded", async () => {
    const s = new Scheduler({ maxConcurrent: 2, maxAgents: 3 });
    await expect(
      s.parallel(Array.from({ length: 5 }, (_, i) => () => Promise.resolve(i))),
    ).rejects.toBeInstanceOf(AgentCapError);
  });

  it("allows exactly maxAgents executions across calls", async () => {
    const s = new Scheduler({ maxConcurrent: 2, maxAgents: 2 });
    await s.parallel([() => Promise.resolve(1), () => Promise.resolve(2)]);
    expect(s.agentsRun).toBe(2);
    await expect(s.parallel([() => Promise.resolve(3)])).rejects.toBeInstanceOf(
      AgentCapError,
    );
  });
});

// ── Scheduler.pipeline ──────────────────────────────────────────────

describe("Scheduler.pipeline", () => {
  it("runs each item through every stage, preserving order", async () => {
    const s = new Scheduler({ maxConcurrent: 4 });
    const out = await s.pipeline(
      [1, 2, 3],
      (prev) => Promise.resolve((prev as number) * 10),
      (prev) => Promise.resolve((prev as number) + 1),
    );
    expect(out).toEqual([11, 21, 31]);
  });

  it("passes the original item and index to each stage", async () => {
    const s = new Scheduler({ maxConcurrent: 4 });
    const out = await s.pipeline(
      ["x", "y"],
      (_prev, item, index) => Promise.resolve(`${item}:${String(index)}`),
    );
    expect(out).toEqual(["x:0", "y:1"]);
  });

  it("drops an item to null when a stage throws, without failing the others", async () => {
    const s = new Scheduler({ maxConcurrent: 4 });
    const out = await s.pipeline(
      [1, 2, 3],
      (prev) => {
        const n = prev as number;
        if (n === 2) throw new Error("stage failed for 2");
        return Promise.resolve(n);
      },
      (prev) => Promise.resolve((prev as number) * 100),
    );
    expect(out).toEqual([100, null, 300]);
  });

  it("bounds total concurrent stage executions to the cap", async () => {
    const s = new Scheduler({ maxConcurrent: 2 });
    const tracker = concurrencyTracker();
    await s.pipeline(
      [1, 2, 3, 4, 5, 6],
      (_prev, item) => tracker.run(item),
    );
    expect(tracker.peak).toBe(2);
  });
});

// ── mapBounded ──────────────────────────────────────────────────────

describe("mapBounded", () => {
  it("preserves input order", async () => {
    const out = await mapBounded([1, 2, 3, 4], 2, (n) =>
      // resolve in reverse-ish order to prove ordering is by index, not finish time
      delay((5 - n) * 5).then(() => n * 2),
    );
    expect(out).toEqual([2, 4, 6, 8]);
  });

  it("caps concurrency at `cap`", async () => {
    const tracker = concurrencyTracker();
    await mapBounded([1, 2, 3, 4, 5], 2, (n) => tracker.run(n));
    expect(tracker.peak).toBe(2);
  });

  it("handles an empty list", async () => {
    expect(await mapBounded([], 4, (n: number) => Promise.resolve(n))).toEqual([]);
  });
});
