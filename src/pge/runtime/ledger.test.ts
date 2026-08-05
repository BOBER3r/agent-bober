import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { BudgetExceededError } from "../../orchestrator/workflow/budget.js";
import { BudgetLedgerSchema } from "../state/overall.js";
import type { LedgerEntry } from "../state/overall.js";
import type { NodeUsage } from "../registry/nodes.js";
import { ZERO_USAGE, createBudgetLedger, ledgerKey } from "./ledger.js";

/**
 * sc-6-8 — replay-idempotent cost accounting.
 *
 * The one property worth a test suite: charging the SAME (nodeId, attempt, callIndex)
 * twice must leave the totals unchanged. An accumulator passes every other test in this
 * file and fails this one, which is exactly why the file exists.
 */

const USAGE = (over: Partial<NodeUsage> = {}): NodeUsage => ({
  calls: 1,
  tokensIn: 100,
  tokensOut: 50,
  costUsd: 0.25,
  ...over,
});

/** Every per-node sum, summed. Equal to `totals()` if and only if the ledger is keyed. */
function sumPerNode(perNode: Record<string, NodeUsage>): NodeUsage {
  return Object.values(perNode).reduce<NodeUsage>(
    (into, usage) => ({
      calls: into.calls + usage.calls,
      tokensIn: into.tokensIn + usage.tokensIn,
      tokensOut: into.tokensOut + usage.tokensOut,
      costUsd: into.costUsd + usage.costUsd,
    }),
    { ...ZERO_USAGE },
  );
}

describe("BudgetLedger.charge REPLACES by key (sc-6-8)", () => {
  it("charging the same (nodeId, attempt, callIndex) twice does not double the total", () => {
    const ledger = createBudgetLedger();
    const key = { nodeId: "sprint_generate", attempt: 0, callIndex: 0 };

    ledger.charge(key, USAGE());
    const afterFirst = ledger.totals();

    ledger.charge(key, USAGE());
    expect(ledger.totals()).toEqual(afterFirst);
    expect(ledger.totals()).toEqual({ calls: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.25 });
    expect(ledger.entries().length).toBe(1);
  });

  it("a re-charge with corrected numbers REPLACES rather than adds", () => {
    const ledger = createBudgetLedger();
    const key = { nodeId: "plan", attempt: 1, callIndex: 2 };

    ledger.charge(key, USAGE({ calls: 1, tokensIn: 10, tokensOut: 5, costUsd: 0.01 }));
    ledger.charge(key, USAGE({ calls: 1, tokensIn: 999, tokensOut: 111, costUsd: 1.5 }));

    expect(ledger.totals()).toEqual({ calls: 1, tokensIn: 999, tokensOut: 111, costUsd: 1.5 });
    expect(ledger.entries()).toEqual([
      { nodeId: "plan", attempt: 1, callIndex: 2, calls: 1, tokensIn: 999, tokensOut: 111, costUsd: 1.5 },
    ]);
  });

  it("distinguishes attempt and callIndex — they are part of the identity", () => {
    const ledger = createBudgetLedger();
    ledger.charge({ nodeId: "n", attempt: 0, callIndex: 0 }, USAGE());
    ledger.charge({ nodeId: "n", attempt: 1, callIndex: 0 }, USAGE());
    ledger.charge({ nodeId: "n", attempt: 1, callIndex: 1 }, USAGE());

    expect(ledger.entries().length).toBe(3);
    expect(ledger.totals()).toEqual({ calls: 3, tokensIn: 300, tokensOut: 150, costUsd: 0.75 });
    expect(ledger.perNode()["n"]).toEqual({
      calls: 3,
      tokensIn: 300,
      tokensOut: 150,
      costUsd: 0.75,
    });
  });

  it("per-node sums equal run totals across a replayed superstep", () => {
    const ledger = createBudgetLedger();
    const charges = [
      { nodeId: "plan", attempt: 0, callIndex: 0 },
      { nodeId: "sprint_generate", attempt: 0, callIndex: 0 },
      { nodeId: "sprint_generate", attempt: 0, callIndex: 1 },
      { nodeId: "sprint_evaluate", attempt: 0, callIndex: 0 },
    ];
    for (const key of charges) ledger.charge(key, USAGE());
    const before = ledger.totals();

    // The superstep is replayed after a crash-resume: every charge arrives a second time.
    for (const key of charges) ledger.charge(key, USAGE());

    expect(ledger.totals()).toEqual(before);
    expect(sumPerNode(ledger.perNode())).toEqual(ledger.totals());
    expect(ledger.perNode()["sprint_generate"]).toEqual({
      calls: 2,
      tokensIn: 200,
      tokensOut: 100,
      costUsd: 0.5,
    });
  });

  it("merge folds committed entries back in with the same replace-by-key rule", () => {
    // Exact binary fractions throughout: this test is about keying, and a float artefact
    // in the assertion would be noise.
    const committed: LedgerEntry[] = [
      { nodeId: "plan", attempt: 0, callIndex: 0, calls: 1, tokensIn: 10, tokensOut: 2, costUsd: 0.125 },
      { nodeId: "curate", attempt: 0, callIndex: 0, calls: 1, tokensIn: 20, tokensOut: 4, costUsd: 0.25 },
    ];
    const expected = { calls: 2, tokensIn: 30, tokensOut: 6, costUsd: 0.375 };
    const resumed = createBudgetLedger(committed);
    expect(resumed.totals()).toEqual(expected);

    // The resumed run re-executes `plan` at the same attempt: not a second charge.
    resumed.charge(
      { nodeId: "plan", attempt: 0, callIndex: 0 },
      { calls: 1, tokensIn: 10, tokensOut: 2, costUsd: 0.125 },
    );
    expect(resumed.totals()).toEqual(expected);

    resumed.merge(committed);
    expect(resumed.totals()).toEqual(expected);
    expect(resumed.entries().length).toBe(2);
  });

  it("keys distinct charge triples distinctly", () => {
    const keys = new Set([
      ledgerKey({ nodeId: "a", attempt: 1, callIndex: 2 }),
      ledgerKey({ nodeId: "a", attempt: 2, callIndex: 1 }),
      ledgerKey({ nodeId: "a", attempt: 12, callIndex: 0 }),
      ledgerKey({ nodeId: "a 1", attempt: 2, callIndex: 0 }),
      ledgerKey({ nodeId: "b", attempt: 1, callIndex: 2 }),
    ]);
    expect(keys.size).toBe(5);

    const ledger = createBudgetLedger();
    ledger.charge({ nodeId: "a", attempt: 1, callIndex: 2 }, USAGE());
    ledger.charge({ nodeId: "a 1", attempt: 2, callIndex: 0 }, USAGE());
    expect(ledger.entries().length).toBe(2);
  });

  it("entries() is sorted, serialisable and not a live view of the ledger", () => {
    const ledger = createBudgetLedger();
    ledger.charge({ nodeId: "z", attempt: 0, callIndex: 0 }, USAGE());
    ledger.charge({ nodeId: "a", attempt: 1, callIndex: 1 }, USAGE());
    ledger.charge({ nodeId: "a", attempt: 0, callIndex: 0 }, USAGE());

    const entries = ledger.entries();
    expect(entries.map((e) => `${e.nodeId}:${e.attempt}:${e.callIndex}`)).toEqual([
      "a:0:0",
      "a:1:1",
      "z:0:0",
    ]);
    // The ledger channel value must parse as the committed schema.
    expect(BudgetLedgerSchema.parse(entries)).toEqual(entries);

    const firstEntry = entries[0] as LedgerEntry;
    firstEntry.costUsd = 999;
    expect(ledger.totals().costUsd).toBeCloseTo(0.75, 10);
  });

  it("rejects a charge whose numbers are not chargeable", () => {
    const ledger = createBudgetLedger();
    expect(() =>
      ledger.charge({ nodeId: "n", attempt: 0, callIndex: 0 }, USAGE({ costUsd: Number.NaN })),
    ).toThrow();
    expect(() =>
      ledger.charge({ nodeId: "n", attempt: 0, callIndex: 0 }, USAGE({ tokensIn: -1 })),
    ).toThrow();
    expect(() => ledger.charge({ nodeId: "", attempt: 0, callIndex: 0 }, USAGE())).toThrow();
    expect(ledger.entries()).toEqual([]);
  });

  it("a node id that shadows Object.prototype is an ordinary key", () => {
    const ledger = createBudgetLedger();
    ledger.charge({ nodeId: "constructor", attempt: 0, callIndex: 0 }, USAGE());
    ledger.charge({ nodeId: "__proto__", attempt: 0, callIndex: 0 }, USAGE({ costUsd: 0.5 }));

    const perNode = ledger.perNode();
    expect(perNode["constructor"]).toEqual({ calls: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.25 });
    expect(perNode["__proto__"]).toEqual({ calls: 1, tokensIn: 100, tokensOut: 50, costUsd: 0.5 });
    expect(sumPerNode(perNode)).toEqual(ledger.totals());
  });
});

describe("assertWithinCeiling (sc-6-8)", () => {
  it("throws a typed BudgetExceededError once the ceiling is passed", () => {
    const ledger = createBudgetLedger();
    ledger.charge({ nodeId: "a", attempt: 0, callIndex: 0 }, USAGE({ costUsd: 0.75 }));
    ledger.charge({ nodeId: "b", attempt: 0, callIndex: 0 }, USAGE({ costUsd: 0.5 }));

    // At the ceiling is within it; above it is not.
    expect(() => ledger.assertWithinCeiling(1.25)).not.toThrow();
    expect(() => ledger.assertWithinCeiling(2)).not.toThrow();
    expect(() => ledger.assertWithinCeiling(1.24)).toThrow(BudgetExceededError);

    const error = (() => {
      try {
        ledger.assertWithinCeiling(1);
        return null;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BudgetExceededError);
    expect((error as BudgetExceededError).kind).toBe("usd");
    expect((error as BudgetExceededError).name).toBe("BudgetExceededError");
    expect((error as BudgetExceededError).message).toMatch(/1\.250000/);
  });

  it("a replayed charge cannot push a run over its ceiling", () => {
    const ledger = createBudgetLedger();
    const key = { nodeId: "expensive", attempt: 0, callIndex: 0 };
    ledger.charge(key, USAGE({ costUsd: 0.9 }));
    expect(() => ledger.assertWithinCeiling(1)).not.toThrow();

    // With an accumulator this second charge would trip a ceiling the run never passed.
    ledger.charge(key, USAGE({ costUsd: 0.9 }));
    expect(() => ledger.assertWithinCeiling(1)).not.toThrow();
  });

  it("an empty ledger is within any non-negative ceiling", () => {
    const ledger = createBudgetLedger();
    expect(ledger.totals()).toEqual(ZERO_USAGE);
    expect(Object.keys(ledger.perNode())).toEqual([]);
    expect(() => ledger.assertWithinCeiling(0)).not.toThrow();
  });
});

describe("the ledger is not a store", () => {
  it("writes no file anywhere while being constructed and charged", async () => {
    const root = await mkdtemp(join(tmpdir(), "bober-pge-ledger-"));
    try {
      const before = await readdir(root);
      const ledger = createBudgetLedger();
      for (let i = 0; i < 10; i += 1) {
        ledger.charge({ nodeId: `n${i}`, attempt: 0, callIndex: 0 }, USAGE());
      }
      ledger.entries();
      ledger.totals();
      ledger.perNode();
      expect(await readdir(root)).toEqual(before);
      expect(await readdir(root)).toEqual([]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
