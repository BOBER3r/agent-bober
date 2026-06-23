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
import { SprintContractSchema } from "../contracts/sprint-contract.js";
import { listContracts, clearContractsForSpec } from "../state/index.js";

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

  it("S2-C2: valid embedded spec.sprints entries are used verbatim with status normalized to proposed", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = { planner: { model: "x" } } as never;
    const spec = specWith(2);

    // Build two fully-valid SprintContract objects (status "agreed" to verify normalization)
    const embeddedEntry1 = {
      contractId: "orig-id-1",
      specId: "other-spec",
      sprintNumber: 99,
      title: "Embedded Sprint One",
      description: "This embedded sprint implements the login feature.",
      status: "agreed" as const,
      successCriteria: [
        {
          criterionId: "emb-1-c1",
          description: "The login form submits credentials and returns a JWT token on success.",
          verificationMethod: "unit-test" as const,
          required: true,
        },
      ],
      nonGoals: ["Do not implement the registration flow in this sprint."],
      stopConditions: ["All unit tests pass for the authentication module."],
      definitionOfDone: "The login endpoint accepts valid credentials and returns a JWT.",
      assumptions: ["JWT secret is pre-configured in env."],
      outOfScope: ["Registration and password reset flows."],
      dependsOn: [],
      features: ["feat-login"],
      iterationHistory: [],
      lastEvalId: null,
    };
    const embeddedEntry2 = {
      contractId: "orig-id-2",
      specId: "other-spec",
      sprintNumber: 100,
      title: "Embedded Sprint Two",
      description: "This embedded sprint implements the logout feature.",
      status: "in-progress" as const,
      successCriteria: [
        {
          criterionId: "emb-2-c1",
          description: "The logout endpoint invalidates the user session and clears the cookie.",
          verificationMethod: "api-check" as const,
          required: true,
        },
      ],
      nonGoals: ["Do not implement token refresh in this sprint."],
      stopConditions: ["Integration test verifies logout clears the session cookie."],
      definitionOfDone: "The logout endpoint clears the session and returns HTTP 200 with no body.",
      assumptions: [],
      outOfScope: [],
      dependsOn: [],
      features: ["feat-logout"],
      iterationHistory: [],
      lastEvalId: null,
    };

    // Assign embedded sprints (createSpec doesn't accept sprints)
    (spec as Record<string, unknown>).sprints = [embeddedEntry1, embeddedEntry2];

    const out = await materializeContracts(spec, tmpDir, cfg);

    // Embedded branch: both entries used, status normalized, ids deterministic
    expect(out).toHaveLength(2);

    expect(out[0].status).toBe("proposed");
    expect(out[0].specId).toBe(spec.specId);
    expect(out[0].sprintNumber).toBe(1);
    expect(out[0].contractId).toBe(`sprint-${spec.specId}-01`);

    // Embedded criteria preserved
    expect(out[0].successCriteria).toHaveLength(1);
    expect(out[0].successCriteria[0].criterionId).toBe("emb-1-c1");
    expect(out[0].successCriteria[0].verificationMethod).toBe("unit-test");
    expect(out[0].nonGoals).toEqual(embeddedEntry1.nonGoals);
    expect(out[0].stopConditions).toEqual(embeddedEntry1.stopConditions);
    expect(out[0].definitionOfDone).toBe(embeddedEntry1.definitionOfDone);

    expect(out[1].status).toBe("proposed");
    expect(out[1].contractId).toBe(`sprint-${spec.specId}-02`);
    expect(out[1].successCriteria[0].criterionId).toBe("emb-2-c1");

    // Files must be on disk and schema-valid
    const listed = await listContracts(tmpDir);
    expect(listed).toHaveLength(2);
    for (const c of listed) {
      const parseResult = SprintContractSchema.safeParse(c);
      expect(parseResult.success).toBe(true);
    }
  });

  it("S2-C3: malformed embedded entries fall back to feature-derived without throwing", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = { planner: { model: "x" } } as never;
    const spec = specWith(2);

    // Assign malformed embedded entry (missing required fields: status, successCriteria, etc.)
    (spec as Record<string, unknown>).sprints = [{ title: "x" }];

    // Must not throw
    const out = await materializeContracts(spec, tmpDir, cfg);

    // Falls back to feature-derived: count == features.length
    expect(out).toHaveLength(spec.features.length);

    // Feature-derived contracts have titles matching the feature titles
    expect(out[0].title).toBe(spec.features[0].title);
    expect(out[1].title).toBe(spec.features[1].title);

    // All are schema-valid
    for (const c of out) {
      const parseResult = SprintContractSchema.safeParse(c);
      expect(parseResult.success).toBe(true);
    }

    // All use agent-evaluation (feature-derived signature)
    expect(out[0].successCriteria[0].verificationMethod).toBe("agent-evaluation");
  });

  it("S2-C5: idempotency — re-materializing same specId leaves no stale higher-numbered files", async () => {
    const { materializeContracts } = await import("./contract-materialization.js");
    const cfg = { planner: { model: "x" } } as never;

    // First: materialize a 3-feature spec
    const spec3 = specWith(3);
    await materializeContracts(spec3, tmpDir, cfg);
    const after3 = await listContracts(tmpDir);
    expect(after3).toHaveLength(3);

    // Second: clear + materialize a 2-feature version of the SAME specId
    const spec2 = {
      ...spec3,
      features: spec3.features.slice(0, 2),
    } as typeof spec3;

    await clearContractsForSpec(tmpDir, spec3.specId);
    await materializeContracts(spec2, tmpDir, cfg);

    const after2 = await listContracts(tmpDir);
    expect(after2).toHaveLength(2);

    // The stale -03 file must not exist
    const ids = after2.map((c) => c.contractId);
    expect(ids.some((id) => id.endsWith("-03"))).toBe(false);
    expect(ids.some((id) => id.endsWith("-01"))).toBe(true);
    expect(ids.some((id) => id.endsWith("-02"))).toBe(true);
  });
});
