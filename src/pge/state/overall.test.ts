import { describe, expect, it } from "vitest";

import { createSpec } from "../../contracts/spec.js";
import { PlanSpecSchema } from "../../contracts/spec.js";
import { SprintContractSchema, createContract } from "../../contracts/sprint-contract.js";
import {
  BranchStatusSchema,
  BudgetLedgerSchema,
  GraphMessageSchema,
  OVERALL_STATE_KEYS,
  OVERALL_STATE_KEY_BUDGET,
  OverallStateSchema,
  ScratchRefSchema,
  SprintVerdictSchema,
  initialOverallState,
  overallStateKeys,
} from "./overall.js";

/**
 * sc-5-1 / sc-5-2 — the public state surface.
 *
 * The snapshot below is a KEY-SET snapshot, never a value snapshot: it is stable across
 * every change that does not add or remove a channel, and it fails the moment one does.
 * The expected list is written out literally rather than derived from
 * `OVERALL_STATE_KEYS`, because comparing the whitelist to itself would pass for any
 * whitelist at all.
 */

// ── sc-5-1: the pinned key set ──────────────────────────────────────

/**
 * The sixteen public channels, sorted.
 *
 * Amending this list is a deliberate act: the architecture's prose says "Exactly 14
 * keys" over a schema that enumerates sixteen (as of sprint 7 of
 * spec-20260812-pge-real-workload-errors, which added `specDraft`), and the enumeration
 * wins — every one of these has a writer in the shipped `coding` topology.
 */
const PINNED_OVERALL_STATE_KEYS = [
  "branchStatus",
  "counters",
  "currentPhase",
  "evaluations",
  "featureRequest",
  "ledger",
  "messages",
  "projectRoot",
  "refs",
  "runId",
  "spec",
  "specDraft",
  "specId",
  "sprintContracts",
  "testAnchors",
  "verdict",
];

describe("OverallState key snapshot", () => {
  it("pins the exact schema key set as a sorted list", () => {
    expect(overallStateKeys()).toEqual(PINNED_OVERALL_STATE_KEYS);
  });

  it("pins the key-count budget at 16, matching the key set", () => {
    expect(OVERALL_STATE_KEY_BUDGET).toBe(16);
    expect(PINNED_OVERALL_STATE_KEYS).toHaveLength(OVERALL_STATE_KEY_BUDGET);
    expect(overallStateKeys()).toHaveLength(OVERALL_STATE_KEY_BUDGET);
  });

  it("keeps the exported whitelist identical to the schema's own keys", () => {
    expect([...OVERALL_STATE_KEYS]).toEqual(PINNED_OVERALL_STATE_KEYS);
    expect([...OVERALL_STATE_KEYS].sort()).toEqual([...OVERALL_STATE_KEYS]);
  });

  it("holds no channel for node-private scratch", () => {
    // The three-scope rule, asserted where it can be checked: `priv` is a Map on
    // NodeContext and is structurally incapable of reaching the commit boundary.
    expect(overallStateKeys()).not.toContain("priv");
    expect(overallStateKeys()).not.toContain("private");
  });

  it("carries no key from the source documents' errata", () => {
    // `trip_goal` is a leftover from a different design's example state. If it ever
    // appears here, someone pasted a shape instead of binding a contract.
    expect(overallStateKeys()).not.toContain("trip_goal");
  });
});

// ── sc-5-2: the contracts are bound, not copied ─────────────────────

describe("OverallState contract binding", () => {
  it("accepts a real SprintContract in sprintContracts", () => {
    const contract = createContract(
      "Bind the contract",
      "The sprintContracts channel holds the real SprintContract shape.",
      [
        {
          criterionId: "sc-1",
          description: "The parsed contract keeps its contractId and sprintNumber intact.",
          verificationMethod: "unit-test",
        },
      ],
      { specId: "spec-fixture", sprintNumber: 3 },
    );

    const parsed = OverallStateSchema.parse({
      ...initialOverallState({ runId: "run-1", projectRoot: "/tmp/p", featureRequest: "x" }),
      sprintContracts: [contract],
    });

    expect(parsed.sprintContracts).toHaveLength(1);
    expect(parsed.sprintContracts[0].contractId).toBe(contract.contractId);
    expect(parsed.sprintContracts[0].sprintNumber).toBe(3);
    expect(SprintContractSchema.safeParse(parsed.sprintContracts[0]).success).toBe(true);
  });

  it("rejects the source documents' errata contract shape", () => {
    const result = OverallStateSchema.safeParse({
      ...initialOverallState({ runId: "run-1", projectRoot: "/tmp/p", featureRequest: "x" }),
      sprintContracts: [
        { sprint_id: "s1", goals: ["ship it"], files_to_edit: ["a.ts"], verification_commands: [] },
      ],
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("unreachable");
    const paths = result.error.issues.map((issue) => issue.path.join("."));
    expect(paths).toContain("sprintContracts.0.contractId");
    expect(paths).toContain("sprintContracts.0.title");
  });

  it("accepts a real PlanSpec or null in spec, and nothing else", () => {
    const spec = createSpec("Fixture", "A real plan spec.", [
      {
        title: "Feature",
        description: "Something to build.",
        priority: "must-have",
        acceptanceCriteria: ["It compiles."],
      },
    ]);
    expect(PlanSpecSchema.safeParse(spec).success).toBe(true);

    const base = initialOverallState({ runId: "run-1", projectRoot: "/tmp/p", featureRequest: "x" });
    expect(OverallStateSchema.parse({ ...base, spec }).spec?.specId).toBe(spec.specId);
    expect(OverallStateSchema.parse({ ...base, spec: null }).spec).toBeNull();

    const bad = OverallStateSchema.safeParse({ ...base, spec: { specId: "only-an-id" } });
    expect(bad.success).toBe(false);
  });
});

// ── Channel value schemas ───────────────────────────────────────────

describe("channel value schemas", () => {
  it("requires a scratch:// uri and a 64-char lowercase hex digest", () => {
    const good = {
      uri: "scratch://run-1/abc.txt",
      sha256: "a".repeat(64),
      bytes: 12,
      kind: "document",
    };
    expect(ScratchRefSchema.parse(good).kind).toBe("document");

    expect(ScratchRefSchema.safeParse({ ...good, uri: "file:///etc/passwd" }).success).toBe(false);
    expect(ScratchRefSchema.safeParse({ ...good, sha256: "A".repeat(64) }).success).toBe(false);
    expect(ScratchRefSchema.safeParse({ ...good, sha256: "a".repeat(63) }).success).toBe(false);
    expect(ScratchRefSchema.safeParse({ ...good, bytes: -1 }).success).toBe(false);
    expect(ScratchRefSchema.safeParse({ ...good, kind: "screenshot" }).success).toBe(false);
  });

  it("gives every message an intrinsic id and a sequence number", () => {
    const message = GraphMessageSchema.parse({
      id: "m-1",
      seq: 0,
      role: "assistant",
      nodeId: "draft",
      text: "hello",
      tokens: 3,
    });
    expect(message.id).toBe("m-1");
    expect(GraphMessageSchema.safeParse({ ...message, id: "" }).success).toBe(false);
    expect(GraphMessageSchema.safeParse({ ...message, role: "narrator" }).success).toBe(false);
    expect(GraphMessageSchema.safeParse({ ...message, seq: -1 }).success).toBe(false);
  });

  it("keys every ledger entry by (nodeId, attempt, callIndex)", () => {
    const entry = {
      nodeId: "draft",
      attempt: 0,
      callIndex: 1,
      calls: 1,
      tokensIn: 100,
      tokensOut: 20,
      costUsd: 0.02,
    };
    expect(BudgetLedgerSchema.parse([entry])).toHaveLength(1);
    const missingKey: Record<string, unknown> = { ...entry };
    delete missingKey.callIndex;
    expect(BudgetLedgerSchema.safeParse([missingKey]).success).toBe(false);
    expect(BudgetLedgerSchema.safeParse([{ ...entry, costUsd: -1 }]).success).toBe(false);
  });

  it("constrains branch status to the declared branch states", () => {
    expect(BranchStatusSchema.parse({ state: "failed", attempts: 2 }).attempts).toBe(2);
    expect(BranchStatusSchema.safeParse({ state: "exploded", attempts: 0 }).success).toBe(false);
  });

  it("gives every sprint verdict an intrinsic id, a seq and a closed outcome", () => {
    const verdict = SprintVerdictSchema.parse({
      id: "contract-1#1",
      seq: 4,
      contractId: "contract-1",
      sprintNumber: 1,
      iteration: 1,
      verdict: "pass",
      summary: "green",
    });
    expect(verdict.evalId).toBeNull();
    expect(SprintVerdictSchema.safeParse({ ...verdict, verdict: "maybe" }).success).toBe(false);
    expect(SprintVerdictSchema.safeParse({ ...verdict, iteration: 0 }).success).toBe(false);
  });
});

// ── Initial state ───────────────────────────────────────────────────

describe("initialOverallState", () => {
  it("starts every channel at its reducer's identity", () => {
    const state = initialOverallState({
      runId: "run-7",
      projectRoot: "/tmp/project",
      featureRequest: "Add a graph runtime",
    });

    expect(state).toEqual({
      runId: "run-7",
      projectRoot: "/tmp/project",
      featureRequest: "Add a graph runtime",
      specId: null,
      currentPhase: "init",
      spec: null,
      specDraft: null,
      sprintContracts: [],
      evaluations: [],
      messages: [],
      refs: {},
      counters: {},
      branchStatus: {},
      testAnchors: [],
      verdict: "pending",
      ledger: [],
    });
    expect(Object.keys(state).sort()).toEqual(PINNED_OVERALL_STATE_KEYS);
  });

  it("refuses an empty runId or projectRoot", () => {
    expect(() => initialOverallState({ runId: "", projectRoot: "/p", featureRequest: "x" })).toThrow();
    expect(() => initialOverallState({ runId: "r", projectRoot: "", featureRequest: "x" })).toThrow();
  });

  it("only admits a phase the shipped Phase enum declares", () => {
    const state = initialOverallState({ runId: "r", projectRoot: "/p", featureRequest: "x" });
    expect(OverallStateSchema.safeParse({ ...state, currentPhase: "generating" }).success).toBe(true);
    expect(OverallStateSchema.safeParse({ ...state, currentPhase: "vibing" }).success).toBe(false);
  });

  it("only admits the four run verdicts", () => {
    const state = initialOverallState({ runId: "r", projectRoot: "/p", featureRequest: "x" });
    for (const verdict of ["pending", "success", "partial", "failed"]) {
      expect(OverallStateSchema.safeParse({ ...state, verdict }).success).toBe(true);
    }
    expect(OverallStateSchema.safeParse({ ...state, verdict: "ok" }).success).toBe(false);
  });
});
