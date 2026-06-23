import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSpec, listContracts } from "../../state/index.js";
import {
  createSpec,
  type ClarificationQuestion,
  type PlanSpec,
} from "../../contracts/spec.js";
import { SprintContractSchema } from "../../contracts/sprint-contract.js";
import {
  runPlanAnswerCommand,
  runPlanCommand,
} from "./plan.js";

// ── Mocks for runPlanCommand tests ────────────────────────────────────

vi.mock("../../orchestrator/planner-agent.js", () => ({
  runPlanner: vi.fn(),
  generateContractPrecision: vi.fn(async () => ({
    nonGoals: ["Do not add a CLI command in this sprint."],
    stopConditions: ["The plan command writes one contract per feature to .bober/contracts."],
    definitionOfDone: "The plan command materializes schema-valid contracts after a ready plan.",
    assumptions: [],
    outOfScope: [],
  })),
}));

vi.mock("../../config/loader.js", () => ({
  loadConfig: vi.fn(async () => ({
    planner: { model: "x", provider: "anthropic" },
    generator: {},
    evaluator: {},
    sprint: { maxSprints: 10 },
  })),
}));

let tmpRoot: string;
let consoleLogSpy: ReturnType<typeof vi.spyOn>;

const exampleQuestions: ClarificationQuestion[] = [
  {
    questionId: "Q1",
    category: "scope",
    question: "Should the API support refresh tokens?",
  },
  {
    questionId: "Q2",
    category: "data-model",
    question: "Are admin users a separate role or a flag on the user record?",
  },
];

async function seedSpec(spec: PlanSpec): Promise<void> {
  await saveSpec(tmpRoot, spec);
}

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-plan-answer-"));
  consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  process.exitCode = undefined;
});

afterEach(async () => {
  consoleLogSpy.mockRestore();
  await rm(tmpRoot, { recursive: true, force: true });
});

// ── runPlanCommand tests ──────────────────────────────────────────────

function makeReadySpec(features: number): PlanSpec {
  return createSpec(
    "Test plan",
    "A test plan for runPlanCommand tests.",
    Array.from({ length: features }, (_, i) => ({
      title: `Feature ${i + 1}`,
      description: `Description for feature ${i + 1} that is long enough.`,
      priority: "medium" as const,
      acceptanceCriteria: [
        `Acceptance criterion that is sufficiently long for feature ${i + 1}.`,
      ],
    })),
    { status: "ready" as const },
  );
}

function makeNeedsClariSpec(): PlanSpec {
  return createSpec(
    "Needs clarification plan",
    "A plan that requires clarification before sprints.",
    [
      {
        title: "Feature A",
        description: "Some feature that needs more details.",
        priority: "must-have" as const,
        acceptanceCriteria: ["AC1: feature is implemented and verified."],
      },
    ],
    {
      clarificationQuestions: [
        {
          questionId: "Q1",
          category: "scope",
          question: "Should this include mobile support?",
        },
      ],
    },
  );
}

describe("runPlanCommand", () => {
  let tmpRoot: string;
  let consoleLogSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-plan-cmd-"));
    consoleLogSpy = vi.spyOn(console, "log").mockImplementation(() => {});
    process.exitCode = undefined;
    vi.clearAllMocks();
  });

  afterEach(async () => {
    consoleLogSpy.mockRestore();
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("S2-C4 ready: writes schema-valid contract files after a ready plan", async () => {
    const { runPlanner } = await import("../../orchestrator/planner-agent.js");
    const spec = makeReadySpec(2);
    (runPlanner as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ready", spec });

    await runPlanCommand("build a thing", tmpRoot, {});

    const written = await listContracts(tmpRoot);
    expect(written.length).toBe(spec.features.length);
    for (const c of written) {
      const result = SprintContractSchema.safeParse(c);
      expect(result.success).toBe(true);
    }
  });

  it("S2-C4 needs-clarification: zero contract files written, exitCode 2", async () => {
    const { runPlanner } = await import("../../orchestrator/planner-agent.js");
    const spec = makeNeedsClariSpec();
    (runPlanner as ReturnType<typeof vi.fn>).mockResolvedValue({
      kind: "needs-clarification",
      spec,
    });

    await runPlanCommand("something ambiguous", tmpRoot, {});

    const written = await listContracts(tmpRoot);
    expect(written.length).toBe(0);
    expect(process.exitCode).toBe(2);
  });

  it("S2-C5: re-planning the same specId overwrites prior contracts with no stale files", async () => {
    const { runPlanner } = await import("../../orchestrator/planner-agent.js");

    // First run: 3-feature spec
    const spec3 = makeReadySpec(3);
    (runPlanner as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ready", spec: spec3 });
    await runPlanCommand("first plan", tmpRoot, {});

    const after3 = await listContracts(tmpRoot);
    expect(after3).toHaveLength(3);

    // Second run: 2-feature version of SAME specId
    const spec2: PlanSpec = { ...spec3, features: spec3.features.slice(0, 2) };
    (runPlanner as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ready", spec: spec2 });
    await runPlanCommand("second plan", tmpRoot, {});

    const after2 = await listContracts(tmpRoot);
    expect(after2).toHaveLength(2);
    const ids = after2.map((c) => c.contractId);
    expect(ids.some((id) => id.endsWith("-03"))).toBe(false);
  });

  it("S2-C6: plan hint points to agent-bober sprint (consistent with plan answer hint)", async () => {
    const { runPlanner } = await import("../../orchestrator/planner-agent.js");
    const spec = makeReadySpec(1);
    (runPlanner as ReturnType<typeof vi.fn>).mockResolvedValue({ kind: "ready", spec });

    await runPlanCommand("build something", tmpRoot, {});

    const output = consoleLogSpy.mock.calls.flat().join("\n");
    // The hint must reference "agent-bober sprint" (the command that executes the materialized plan)
    expect(output).toContain("agent-bober sprint");
  });
});

describe("runPlanAnswerCommand", () => {
  it("records an answer, leaves status when other questions remain", async () => {
    const spec = createSpec(
      "Add login flow",
      "Login with JWT",
      [
        {
          title: "Login form",
          description: "Form posts to /api/auth/login",
          priority: "must-have",
          acceptanceCriteria: ["AC1: form submits and stores JWT"],
          dependencies: [],
        },
      ],
      { clarificationQuestions: exampleQuestions, ambiguityScore: 7 },
    );
    await seedSpec(spec);

    await runPlanAnswerCommand(spec.specId, "Q1", "Yes, with rotation", tmpRoot);

    const written = JSON.parse(
      await readFile(join(tmpRoot, ".bober/specs", `${spec.specId}.json`), "utf-8"),
    );
    expect(written.resolvedClarifications).toHaveLength(1);
    expect(written.resolvedClarifications[0].questionId).toBe("Q1");
    expect(written.resolvedClarifications[0].answer).toBe(
      "Yes, with rotation",
    );
    expect(written.status).toBe("needs-clarification"); // Q2 still open
  });

  it("flips status to ready when last question resolved", async () => {
    const spec = createSpec(
      "Add login flow",
      "Login with JWT",
      [
        {
          title: "Login form",
          description: "Form posts to /api/auth/login",
          priority: "must-have",
          acceptanceCriteria: ["AC1: form submits and stores JWT"],
          dependencies: [],
        },
      ],
      {
        clarificationQuestions: [exampleQuestions[0]],
        ambiguityScore: 7,
      },
    );
    await seedSpec(spec);

    await runPlanAnswerCommand(spec.specId, "Q1", "Yes", tmpRoot);

    const written = JSON.parse(
      await readFile(join(tmpRoot, ".bober/specs", `${spec.specId}.json`), "utf-8"),
    );
    expect(written.status).toBe("ready");
    expect(written.resolvedClarifications).toHaveLength(1);
  });

  it("sets exitCode 1 on missing spec without throwing", async () => {
    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPlanAnswerCommand(
      "spec-does-not-exist",
      "Q1",
      "Yes",
      tmpRoot,
    );

    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it("sets exitCode 1 on unknown questionId", async () => {
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
      { clarificationQuestions: [exampleQuestions[0]] },
    );
    await seedSpec(spec);

    const errSpy = vi.spyOn(console, "error").mockImplementation(() => {});

    await runPlanAnswerCommand(spec.specId, "Q-bogus", "Yes", tmpRoot);

    expect(process.exitCode).toBe(1);
    errSpy.mockRestore();
  });

  it("S2-C6: resolving the final clarification materializes schema-valid contracts and prints agent-bober sprint hint", async () => {
    // Build a spec with one open clarification question and one feature.
    const spec = createSpec(
      "Add login flow",
      "Login with JWT tokens",
      [
        {
          title: "Login form",
          description: "Form posts to /api/auth/login and stores JWT",
          priority: "must-have",
          acceptanceCriteria: [
            "AC1: form submits and stores JWT in localStorage",
          ],
        },
      ],
      {
        clarificationQuestions: [
          {
            questionId: "Q1",
            category: "scope",
            question: "Should the API support refresh tokens?",
          },
        ],
      },
    );
    await seedSpec(spec);

    await runPlanAnswerCommand(spec.specId, "Q1", "Yes, with rotation", tmpRoot);

    // The spec should now be ready
    const written = JSON.parse(
      await readFile(join(tmpRoot, ".bober/specs", `${spec.specId}.json`), "utf-8"),
    );
    expect(written.status).toBe("ready");

    // Contracts must have been materialized
    const contracts = await listContracts(tmpRoot);
    expect(contracts.length).toBeGreaterThan(0);
    for (const c of contracts) {
      const result = SprintContractSchema.safeParse(c);
      expect(result.success).toBe(true);
    }

    // The printed output must hint at agent-bober sprint
    const output = consoleLogSpy.mock.calls.flat().join("\n");
    expect(output).toContain("agent-bober sprint");
  });
});
