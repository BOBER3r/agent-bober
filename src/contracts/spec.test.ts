import { describe, it, expect } from "vitest";

import {
  PlanSpecSchema,
  createSpec,
  hasOpenClarifications,
  getOpenClarifications,
  isPipelineReady,
  resolveClarification,
  AMBIGUITY_BLOCK_THRESHOLD,
  type PlanSpec,
  type ClarificationQuestion,
} from "./spec.js";

function exampleQuestion(
  overrides: Partial<ClarificationQuestion> = {},
): ClarificationQuestion {
  return {
    questionId: "Q1",
    category: "scope",
    question: "Should the API support refresh tokens?",
    ...overrides,
  };
}

function validSpec(overrides: Partial<PlanSpec> = {}): PlanSpec {
  const now = new Date().toISOString();
  return {
    specId: "spec-test",
    version: 1,
    title: "Add login flow",
    description: "Add username/password login with JWT.",
    status: "ready",
    mode: "greenfield",
    features: [
      {
        featureId: "feat-1",
        title: "Login form",
        description: "Form posts to /api/auth/login",
        priority: "must-have",
        acceptanceCriteria: ["AC1: Form submits credentials and stores JWT"],
        dependencies: [],
      },
    ],
    assumptions: [],
    outOfScope: [],
    clarificationQuestions: [],
    resolvedClarifications: [],
    techStack: [],
    nonFunctionalRequirements: [],
    constraints: [],
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

describe("PlanSpecSchema", () => {
  it("accepts a fully populated spec", () => {
    expect(PlanSpecSchema.safeParse(validSpec()).success).toBe(true);
  });

  it("rejects unknown status", () => {
    const s = validSpec({
      // @ts-expect-error — exercising runtime rejection
      status: "frozen",
    });
    expect(PlanSpecSchema.safeParse(s).success).toBe(false);
  });

  it("rejects unknown priority", () => {
    const s = validSpec({
      features: [
        {
          featureId: "feat-1",
          title: "x",
          description: "x",
          // @ts-expect-error — exercising runtime rejection
          priority: "must",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ],
    });
    expect(PlanSpecSchema.safeParse(s).success).toBe(false);
  });

  it("rejects ambiguityScore outside 0..10", () => {
    expect(
      PlanSpecSchema.safeParse(validSpec({ ambiguityScore: -1 })).success,
    ).toBe(false);
    expect(
      PlanSpecSchema.safeParse(validSpec({ ambiguityScore: 11 })).success,
    ).toBe(false);
    expect(
      PlanSpecSchema.safeParse(validSpec({ ambiguityScore: 0 })).success,
    ).toBe(true);
    expect(
      PlanSpecSchema.safeParse(validSpec({ ambiguityScore: 10 })).success,
    ).toBe(true);
  });

  it("requires features.acceptanceCriteria to be non-empty", () => {
    const s = validSpec({
      features: [
        {
          featureId: "feat-1",
          title: "x",
          description: "x",
          priority: "must-have",
          acceptanceCriteria: [],
          dependencies: [],
        },
      ],
    });
    expect(PlanSpecSchema.safeParse(s).success).toBe(false);
  });
});

describe("createSpec", () => {
  it("produces a schema-valid draft spec by default", () => {
    const spec = createSpec(
      "Hello",
      "World",
      [
        {
          title: "f1",
          description: "d1",
          priority: "must-have",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ],
    );
    expect(spec.status).toBe("draft");
    expect(spec.mode).toBe("greenfield");
    expect(PlanSpecSchema.safeParse(spec).success).toBe(true);
    expect(spec.features[0].featureId).toBe("feat-1");
  });

  it("auto-marks needs-clarification when ambiguityScore is over threshold", () => {
    const spec = createSpec(
      "Hello",
      "World",
      [
        {
          title: "f1",
          description: "d1",
          priority: "must-have",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ],
      { ambiguityScore: AMBIGUITY_BLOCK_THRESHOLD },
    );
    expect(spec.status).toBe("needs-clarification");
  });

  it("auto-marks needs-clarification when questions are supplied", () => {
    const spec = createSpec(
      "Hello",
      "World",
      [
        {
          title: "f1",
          description: "d1",
          priority: "must-have",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ],
      { clarificationQuestions: [exampleQuestion()] },
    );
    expect(spec.status).toBe("needs-clarification");
  });

  it("respects an explicit status override", () => {
    const spec = createSpec(
      "Hello",
      "World",
      [
        {
          title: "f1",
          description: "d1",
          priority: "must-have",
          acceptanceCriteria: ["AC1"],
          dependencies: [],
        },
      ],
      { status: "ready", ambiguityScore: 9 },
    );
    expect(spec.status).toBe("ready");
  });
});

describe("clarification helpers", () => {
  const baseSpec = validSpec({
    status: "needs-clarification",
    ambiguityScore: 8,
    clarificationQuestions: [
      exampleQuestion({ questionId: "Q1" }),
      exampleQuestion({ questionId: "Q2", question: "Multi-tenant?" }),
    ],
  });

  it("hasOpenClarifications is false when no questions exist regardless of status", () => {
    const s = validSpec({ status: "needs-clarification" });
    // status alone does not imply open questions — that's isPipelineReady's job
    expect(hasOpenClarifications(s)).toBe(false);
  });

  it("hasOpenClarifications detects unresolved questions", () => {
    const s = validSpec({
      status: "ready",
      clarificationQuestions: [exampleQuestion()],
      resolvedClarifications: [],
    });
    expect(hasOpenClarifications(s)).toBe(true);
  });

  it("getOpenClarifications returns only unresolved entries", () => {
    const open = getOpenClarifications(baseSpec);
    expect(open.map((q) => q.questionId)).toEqual(["Q1", "Q2"]);

    const partial = resolveClarification(baseSpec, "Q1", "Yes");
    expect(getOpenClarifications(partial).map((q) => q.questionId)).toEqual([
      "Q2",
    ]);
  });

  it("resolveClarification records the answer and timestamps it", () => {
    const updated = resolveClarification(baseSpec, "Q1", "Yes, with rotation");
    expect(updated.resolvedClarifications).toHaveLength(1);
    expect(updated.resolvedClarifications[0]).toMatchObject({
      questionId: "Q1",
      answer: "Yes, with rotation",
      resolvedBy: "user",
    });
    expect(updated.resolvedClarifications[0].resolvedAt).toBeTruthy();
  });

  it("resolveClarification flips status to ready when last question resolved", () => {
    const oneQ = validSpec({
      status: "needs-clarification",
      clarificationQuestions: [exampleQuestion()],
    });
    const updated = resolveClarification(oneQ, "Q1", "Yes");
    expect(updated.status).toBe("ready");
  });

  it("resolveClarification keeps status when other questions remain", () => {
    const updated = resolveClarification(baseSpec, "Q1", "Yes");
    expect(updated.status).toBe("needs-clarification");
  });

  it("resolveClarification overwrites a previous answer to the same question", () => {
    const first = resolveClarification(baseSpec, "Q1", "Maybe");
    const second = resolveClarification(first, "Q1", "Definitely");
    const q1Answers = second.resolvedClarifications.filter(
      (r) => r.questionId === "Q1",
    );
    expect(q1Answers).toHaveLength(1);
    expect(q1Answers[0].answer).toBe("Definitely");
  });

  it("resolveClarification throws on unknown questionId", () => {
    expect(() =>
      resolveClarification(baseSpec, "Q-doesnt-exist", "Yes"),
    ).toThrow(/not found/);
  });

  it("isPipelineReady is false for needs-clarification status", () => {
    expect(isPipelineReady(validSpec({ status: "needs-clarification" }))).toBe(
      false,
    );
  });

  it("isPipelineReady is false when open questions remain even with ready status", () => {
    const s = validSpec({
      status: "ready",
      clarificationQuestions: [exampleQuestion()],
    });
    expect(isPipelineReady(s)).toBe(false);
  });

  it("isPipelineReady is true for a clean ready spec", () => {
    expect(isPipelineReady(validSpec())).toBe(true);
  });

  it("isPipelineReady is false for abandoned status", () => {
    expect(isPipelineReady(validSpec({ status: "abandoned" }))).toBe(false);
  });

  it("supports planner-authored self-answers", () => {
    const updated = resolveClarification(
      baseSpec,
      "Q1",
      "Codebase shows JWT pattern at src/auth.ts:42",
      "planner",
    );
    expect(updated.resolvedClarifications[0].resolvedBy).toBe("planner");
  });
});
