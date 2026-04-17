import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { saveSpec } from "../../state/index.js";
import {
  createSpec,
  type ClarificationQuestion,
  type PlanSpec,
} from "../../contracts/spec.js";
import {
  runPlanAnswerCommand,
} from "./plan.js";

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
});
