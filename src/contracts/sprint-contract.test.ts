import { describe, it, expect } from "vitest";

import {
  SprintContractSchema,
  ContractStatusSchema,
  createContract,
  updateContractStatus,
  isSettledContractStatus,
  isTerminalContractStatus,
  SETTLED_CONTRACT_STATUSES,
  TERMINAL_CONTRACT_STATUSES,
  findPrecisionIssues,
  isContractPrecise,
  MIN_CRITERION_DESCRIPTION_LENGTH,
  MIN_DEFINITION_OF_DONE_LENGTH,
  type SprintContract,
  type ContractStatus,
} from "./sprint-contract.js";

// A reusable, schema-valid contract for tests that need a known-good base.
function validContract(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    contractId: "sprint-test-1",
    specId: "spec-test",
    sprintNumber: 1,
    title: "Add login form",
    description:
      "Wire a login form to /api/auth/login and redirect to /dashboard on 200.",
    status: "proposed",
    dependsOn: [],
    features: ["feat-login"],
    successCriteria: [
      {
        criterionId: "sc-1-1",
        description:
          "Submitting valid credentials posts to /api/auth/login and stores the JWT in an httpOnly cookie.",
        verificationMethod: "playwright",
        required: true,
      },
    ],
    nonGoals: ["No password reset flow in this sprint"],
    stopConditions: ["E2E login test passes against the staging API"],
    definitionOfDone:
      "A user with valid credentials can log in and be redirected to /dashboard, with the JWT set as an httpOnly cookie.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: ["src/components/Login.tsx"],
    iterationHistory: [],
    lastEvalId: null,
    ...overrides,
  };
}

describe("SprintContractSchema", () => {
  it("accepts a fully populated contract", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
  });

  it("rejects criterion description shorter than minimum", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description: "works",
          verificationMethod: "manual",
          required: true,
        },
      ],
    });
    const result = SprintContractSchema.safeParse(c);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.path.join(".").includes("successCriteria"),
        ),
      ).toBe(true);
    }
    // sanity-check the threshold itself
    expect(MIN_CRITERION_DESCRIPTION_LENGTH).toBeGreaterThan(5);
  });

  it("rejects empty successCriteria", () => {
    const c = validContract({ successCriteria: [] });
    const result = SprintContractSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it("rejects empty nonGoals", () => {
    const c = validContract({ nonGoals: [] });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects empty stopConditions", () => {
    const c = validContract({ stopConditions: [] });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects definitionOfDone shorter than minimum", () => {
    const c = validContract({ definitionOfDone: "done" });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
    expect(MIN_DEFINITION_OF_DONE_LENGTH).toBeGreaterThan(5);
  });

  it("rejects free-form verificationMethod values", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description:
            "Submitting valid credentials posts to /api/auth/login successfully.",
          // @ts-expect-error — exercising runtime rejection of invalid enum value
          verificationMethod: "vibes",
          required: true,
        },
      ],
    });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects ambiguityScore outside 0..10", () => {
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: -1 }))
        .success,
    ).toBe(false);
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: 11 }))
        .success,
    ).toBe(false);
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: 5 }))
        .success,
    ).toBe(true);
  });
});

describe("createContract", () => {
  it("produces a schema-valid contract with placeholder precision fields", () => {
    const contract = createContract(
      "Add login form",
      "Wire login form to /api/auth/login.",
      [
        {
          criterionId: "sc-1",
          description:
            "Submitting valid credentials posts to /api/auth/login.",
          verificationMethod: "playwright",
        },
      ],
      { specId: "spec-x", sprintNumber: 2, features: ["feat-login"] },
    );

    const result = SprintContractSchema.safeParse(contract);
    expect(result.success).toBe(true);

    expect(contract.specId).toBe("spec-x");
    expect(contract.sprintNumber).toBe(2);
    expect(contract.status).toBe("proposed");
    expect(contract.successCriteria[0].required).toBe(true);
    expect(contract.nonGoals[0]).toMatch(/Auto-generated/);
  });
});

describe("updateContractStatus", () => {
  it("sets startedAt when entering in-progress", () => {
    const contract = validContract();
    expect(contract.startedAt).toBeUndefined();
    const next = updateContractStatus(contract, "in-progress");
    expect(next.status).toBe("in-progress");
    expect(next.startedAt).toBeTruthy();
  });

  it("sets completedAt for terminal statuses", () => {
    const contract = validContract();
    for (const status of ["passed", "failed", "completed"] as const) {
      const next = updateContractStatus(contract, status);
      expect(next.status).toBe(status);
      expect(next.completedAt).toBeTruthy();
    }
  });

  it("does not overwrite existing startedAt", () => {
    const original = "2026-04-15T10:00:00.000Z";
    const contract = validContract({ startedAt: original });
    const next = updateContractStatus(contract, "in-progress");
    expect(next.startedAt).toBe(original);
  });

  it("agrees with isTerminalContractStatus for every status (so :216-219 cannot drift back)", () => {
    // Pins the coupling between updateContractStatus's completedAt-stamping
    // rule and the exported predicate — the whole point of generalising the
    // inline rule into isTerminalContractStatus. If the two ever diverge,
    // this is the test that fails.
    for (const status of ContractStatusSchema.options) {
      const contract = validContract();
      const next = updateContractStatus(contract, status);
      expect(Boolean(next.completedAt)).toBe(isTerminalContractStatus(status));
    }
  });
});

describe("isSettledContractStatus / isTerminalContractStatus", () => {
  // The exact partition of ALL NINE ContractStatusSchema members, so adding a
  // tenth status to the enum without deciding where it belongs fails this
  // test loudly rather than silently defaulting to "not settled".
  const EXPECTED_SETTLED = new Set<ContractStatus>(["passed", "completed"]);
  const EXPECTED_TERMINAL = new Set<ContractStatus>(["passed", "failed", "completed"]);

  it("SETTLED_CONTRACT_STATUSES is exactly {passed, completed}", () => {
    expect(new Set(SETTLED_CONTRACT_STATUSES)).toEqual(EXPECTED_SETTLED);
  });

  it("TERMINAL_CONTRACT_STATUSES is exactly {passed, failed, completed}", () => {
    expect(new Set(TERMINAL_CONTRACT_STATUSES)).toEqual(EXPECTED_TERMINAL);
  });

  it("TERMINAL_CONTRACT_STATUSES is a strict superset of SETTLED_CONTRACT_STATUSES", () => {
    // The two sets are built one from the other in the source (adds
    // "failed") specifically so they cannot silently diverge. Assert that
    // relationship directly, not just the two memberships independently.
    for (const s of SETTLED_CONTRACT_STATUSES) {
      expect(TERMINAL_CONTRACT_STATUSES.has(s)).toBe(true);
    }
    expect(TERMINAL_CONTRACT_STATUSES.size).toBe(SETTLED_CONTRACT_STATUSES.size + 1);
  });

  it("partitions every member of ContractStatusSchema exactly as expected", () => {
    expect(ContractStatusSchema.options.length).toBe(9); // liveness: the enum still has 9 members
    for (const status of ContractStatusSchema.options) {
      expect(isSettledContractStatus(status)).toBe(EXPECTED_SETTLED.has(status));
      expect(isTerminalContractStatus(status)).toBe(EXPECTED_TERMINAL.has(status));
    }
  });

  it("isSettledContractStatus excludes 'failed' (a failed sprint is over, not settled-good)", () => {
    expect(isSettledContractStatus("failed")).toBe(false);
    expect(isTerminalContractStatus("failed")).toBe(true);
  });

  it("every settled status is also terminal, but not vice versa", () => {
    for (const status of ContractStatusSchema.options) {
      if (isSettledContractStatus(status)) {
        expect(isTerminalContractStatus(status)).toBe(true);
      }
    }
    // "failed" is the witness that the converse does not hold.
    expect(isTerminalContractStatus("failed") && !isSettledContractStatus("failed")).toBe(true);
  });
});

describe("findPrecisionIssues", () => {
  it("returns no issues for a clean contract", () => {
    expect(findPrecisionIssues(validContract())).toEqual([]);
  });

  it("flags banned vague phrases in criterion descriptions", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description: "The login form works correctly when submitted.",
          verificationMethod: "manual",
          required: true,
        },
      ],
    });
    const issues = findPrecisionIssues(c);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].field).toContain("successCriteria");
    expect(issues[0].message).toContain('"works correctly"');
  });

  it("flags vague phrases in definitionOfDone", () => {
    const c = validContract({
      definitionOfDone: "The feature looks good and behaves properly.",
    });
    const issues = findPrecisionIssues(c);
    // Two banned phrases in one string => two issues
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.field === "definitionOfDone")).toBe(true);
  });
});

describe("isContractPrecise", () => {
  it("returns true for a properly authored contract", () => {
    expect(isContractPrecise(validContract())).toBe(true);
  });

  it("returns false for placeholder auto-generated contracts", () => {
    const auto = createContract(
      "Stub",
      "Stub feature",
      [
        {
          criterionId: "sc-1",
          description:
            "The endpoint returns the expected JSON shape on a 200 response.",
          verificationMethod: "api-check",
        },
      ],
    );
    expect(isContractPrecise(auto)).toBe(false);
  });

  it("returns false when ambiguityScore >= 7", () => {
    expect(isContractPrecise(validContract({ ambiguityScore: 7 }))).toBe(false);
    expect(isContractPrecise(validContract({ ambiguityScore: 6 }))).toBe(true);
  });

  it("returns false when banned phrases are present", () => {
    const c = validContract({
      definitionOfDone:
        "The dashboard works correctly and renders the right widgets.",
    });
    expect(isContractPrecise(c)).toBe(false);
  });
});
