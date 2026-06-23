/**
 * Unit tests for materializeContracts helper.
 *
 * Tests:
 * (a) S1-C2: pipeline.ts delegates to materializeContracts while both the
 *     post-plan and post-sprint-contract audit checkpoints stay in pipeline.ts.
 * (b) S1-C3: characterization — with generateContractPrecision mocked, a
 *     3-feature spec produces feature-derived contracts matching pre-refactor
 *     expectations (title, description, successCriteria, status, precision
 *     fields, sprintNumber, features).
 * (c) S1-C4: deterministic zero-padded ids (`sprint-<specId>-NN`) and
 *     listContracts lexical ordering == sprintNumber order for 12+ sprints.
 *
 * Colocated with contract-materialization.ts per the project convention.
 * Uses real createContract / saveContract / listContracts against a tmp dir;
 * mocks only the heavy LLM call (generateContractPrecision).
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createSpec } from "../contracts/spec.js";
import { listContracts } from "../state/index.js";

// ── Mock the LLM call so tests are fast and network-free ──────────────

vi.mock("./planner-agent.js", () => ({
  generateContractPrecision: vi.fn(async () => ({
    nonGoals: ["Do not implement the settings UI in this sprint"],
    stopConditions: [
      "npm test passes and the helper exports materializeContracts",
    ],
    definitionOfDone:
      "The helper materializes one contract per feature and persists each to .bober/contracts.",
    assumptions: ["assumption A"],
    outOfScope: ["deferred work B"],
  })),
}));

// ── Temp dir lifecycle ────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-materialize-"));
  vi.clearAllMocks();
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Fixture helpers ───────────────────────────────────────────────────

function specWith(n: number) {
  return createSpec(
    "Test plan",
    "A plan with N features for materialization tests.",
    Array.from({ length: n }, (_, i) => ({
      title: `Feature ${i + 1}`,
      description: `Description for feature ${
        i + 1
      } that is long enough to be valid.`,
      priority: "medium" as const,
      acceptanceCriteria: [
        `Acceptance criterion that is sufficiently long for feature ${i + 1}.`,
      ],
    })),
    { status: "ready" as const },
  );
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("materializeContracts", () => {
  it("S1-C2: pipeline.ts delegates to materializeContracts; checkpoints remain in pipeline", async () => {
    // Read pipeline.ts source and assert structural properties.
    // This is lighter than running runTsPipeline end-to-end with all mocks.
    const pipelineSrc = await readFile(
      new URL("./pipeline.ts", import.meta.url).pathname,
      "utf-8",
    );
    // The helper call must be present.
    expect(pipelineSrc).toContain("materializeContracts(spec, projectRoot, config)");
    // The inline loop must be gone (no longer calls createContract directly).
    expect(pipelineSrc).not.toContain(
      "for (let i = 0; i < spec.features.length; i++)",
    );
    // Both checkpoints must still be present.
    expect(pipelineSrc).toContain('"post-plan"');
    expect(pipelineSrc).toContain('"post-sprint-contract"');
  });

  it("S1-C3: feature-derived content parity — 3-feature spec", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = { planner: { model: "x" } } as never;
    const spec = specWith(3);

    const out = await materializeContracts(spec, tmpDir, cfg);

    expect(out).toHaveLength(3);

    // First contract
    expect(out[0].title).toBe("Feature 1");
    expect(out[0].description).toBe(
      "Description for feature 1 that is long enough to be valid.",
    );
    expect(out[0].sprintNumber).toBe(1);
    expect(out[0].features).toEqual([spec.features[0].featureId]);
    expect(out[0].status).toBe("proposed");
    expect(out[0].successCriteria).toHaveLength(1);
    expect(out[0].successCriteria[0].verificationMethod).toBe("agent-evaluation");
    expect(out[0].successCriteria[0].criterionId).toBe(
      `${spec.features[0].featureId}-criterion-1`,
    );

    // Precision fields applied
    expect(out[0].nonGoals.length).toBeGreaterThan(0);
    expect(out[0].nonGoals[0]).toBe(
      "Do not implement the settings UI in this sprint",
    );
    expect(out[0].stopConditions.length).toBeGreaterThan(0);
    expect(out[0].assumptions).toEqual(["assumption A"]);
    expect(out[0].outOfScope).toEqual(["deferred work B"]);

    // Second and third contracts
    expect(out[1].title).toBe("Feature 2");
    expect(out[1].sprintNumber).toBe(2);
    expect(out[2].title).toBe("Feature 3");
    expect(out[2].sprintNumber).toBe(3);
  });

  it("S1-C4: deterministic zero-padded ids; listContracts order == sprintNumber order for 12 sprints", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = {} as never;
    const spec = specWith(12);

    await materializeContracts(spec, tmpDir, cfg);
    const listed = await listContracts(tmpDir);

    // Verify all 12 contracts are present
    expect(listed).toHaveLength(12);

    // Verify deterministic zero-padded id format
    expect(listed.map((c) => c.contractId)).toEqual(
      Array.from(
        { length: 12 },
        (_, i) => `sprint-${spec.specId}-${String(i + 1).padStart(2, "0")}`,
      ),
    );

    // Verify sprintNumber order matches lexical (file) order
    expect(listed.map((c) => c.sprintNumber)).toEqual([
      1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12,
    ]);
  });

  it("S1-C4: id zero-padding produces correct lexical order (sprint 10 sorts after sprint 09)", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = {} as never;
    const spec = specWith(12);

    await materializeContracts(spec, tmpDir, cfg);
    const listed = await listContracts(tmpDir);

    // sprint-...-09 must come before sprint-...-10 in sorted order
    const ids = listed.map((c) => c.contractId);
    const idx09 = ids.findIndex((id) => id.endsWith("-09"));
    const idx10 = ids.findIndex((id) => id.endsWith("-10"));
    expect(idx09).toBeGreaterThanOrEqual(0);
    expect(idx10).toBeGreaterThanOrEqual(0);
    expect(idx09).toBeLessThan(idx10);
  });
});
