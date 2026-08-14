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

// ── Scheduler.settle ────────────────────────────────────────────────

/**
 * `settle` is the barrier-shaped sibling of `parallel`. Its whole reason to exist is that
 * `parallel` is backed by `Promise.all`, so ONE rejecting thunk discards the results of
 * every thunk that succeeded — which is wrong at a superstep barrier, where the graph
 * runtime must see the failures ALONGSIDE the branches that committed before it can decide
 * what to route.
 */
describe("Scheduler.settle", () => {
  it("returns one index-aligned outcome per thunk", async () => {
    const scheduler = new Scheduler({ maxConcurrent: 4 });
    const outcomes = await scheduler.settle([
      () => Promise.resolve("a"),
      () => Promise.resolve("b"),
      () => Promise.resolve("c"),
    ]);
    expect(outcomes).toEqual([
      { status: "fulfilled", value: "a" },
      { status: "fulfilled", value: "b" },
      { status: "fulfilled", value: "c" },
    ]);
  });

  it("keeps every successful result when a sibling rejects — the reason parallel cannot", async () => {
    const scheduler = new Scheduler({ maxConcurrent: 4 });
    const boom = new Error("branch 2 failed");
    const thunks = [
      () => Promise.resolve(1),
      () => Promise.reject(boom),
      () => Promise.resolve(3),
    ];

    const outcomes = await scheduler.settle(thunks);
    expect(outcomes[0]).toEqual({ status: "fulfilled", value: 1 });
    expect(outcomes[1]).toEqual({ status: "rejected", reason: boom });
    expect(outcomes[2]).toEqual({ status: "fulfilled", value: 3 });

    // The same batch through `parallel` loses both survivors.
    await expect(new Scheduler({ maxConcurrent: 4 }).parallel(thunks)).rejects.toBe(boom);
  });

  it("still bounds concurrency at the cap", async () => {
    const tracker = concurrencyTracker();
    const scheduler = new Scheduler({ maxConcurrent: 2 });
    await scheduler.settle([1, 2, 3, 4, 5].map((n) => () => tracker.run(n)));
    expect(tracker.peak).toBe(2);
  });

  it("counts every execution against the lifetime agent cap", async () => {
    const scheduler = new Scheduler({ maxConcurrent: 4, maxAgents: 3 });
    const outcomes = await scheduler.settle([
      () => Promise.resolve(1),
      () => Promise.resolve(2),
      () => Promise.resolve(3),
      () => Promise.resolve(4),
    ]);
    expect(scheduler.agentsRun).toBe(3);
    expect(outcomes.slice(0, 3).map((o) => o.status)).toEqual([
      "fulfilled",
      "fulfilled",
      "fulfilled",
    ]);
    // The runaway guard is REPORTED, not propagated: at a barrier the caller must see it
    // beside the branches that did complete.
    expect(outcomes[3].status).toBe("rejected");
    expect(outcomes[3].status === "rejected" && outcomes[3].reason).toBeInstanceOf(AgentCapError);
  });

  it("returns an empty array for an empty batch", async () => {
    expect(await new Scheduler({ maxConcurrent: 2 }).settle([])).toEqual([]);
  });
});
