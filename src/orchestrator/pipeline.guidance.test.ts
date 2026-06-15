// ── pipeline.guidance.test.ts ─────────────────────────────────────────
//
// Tests for the Phase 2 guidance injection pipeline read point.
// Covers sc-4-6 (guidance surfaces into agent input) and
// sc-4-7 (no-guidance is a deep-equal no-op).
//
// Pattern: mirrors pipeline-run-id.test.ts "extract pure logic" style —
// we test the exported `injectGuidanceIntoHandoff` helper directly
// rather than driving the full runSprintCycle (which calls real LLMs).

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { injectGuidanceIntoHandoff } from "./pipeline.js";
import { appendGuidance, drainGuidance } from "../state/guidance.js";
import type { ContextHandoff } from "./context-handoff.js";

// ── Fixtures ──────────────────────────────────────────────────────────

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-pipeline-guidance-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// ── Minimal handoff fixture ────────────────────────────────────────────

function makeMinimalHandoff(issuesOverride?: string[]): ContextHandoff {
  return {
    timestamp: new Date().toISOString(),
    from: "planner",
    to: "generator",
    projectContext: {
      name: "test-project",
      type: "greenfield",
      techStack: ["typescript"],
      entryPoints: ["src/index.ts"],
      currentBranch: "main",
    },
    spec: {
      specId: "spec-test",
      title: "Test spec",
      description: "A test spec",
      features: [],
      goals: [],
      nonGoals: [],
      successCriteria: [],
      techStack: [],
      mode: "greenfield",
      status: "ready",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    },
    sprintHistory: [],
    instructions: "Implement the sprint",
    changedFiles: [],
    decisions: [],
    issues: issuesOverride ?? [],
  };
}

// ── sc-4-7: no-guidance is a deep-equal no-op ─────────────────────────

describe("injectGuidanceIntoHandoff — sc-4-7 (no-guidance no-op)", () => {
  it("returns the SAME reference when guidanceTexts is empty", () => {
    const handoff = makeMinimalHandoff();
    const result = injectGuidanceIntoHandoff(handoff, []);
    // Must be the exact same reference, not a copy
    expect(result).toBe(handoff);
  });

  it("is deep-equal to the original when guidanceTexts is empty", () => {
    const handoff = makeMinimalHandoff(["existing issue"]);
    const result = injectGuidanceIntoHandoff(handoff, []);
    expect(result).toEqual(handoff);
  });

  it("drainGuidance returns [] when no guidance file exists (sc-4-7 pipeline path)", async () => {
    // Simulates what the pipeline does when no guidance was queued
    const guidance = await drainGuidance(tmpDir, "run-no-guidance");
    const handoff = makeMinimalHandoff();
    const injected = injectGuidanceIntoHandoff(handoff, guidance);
    // No-op: same reference
    expect(injected).toBe(handoff);
  });
});

// ── sc-4-6: guidance surfaces into agent input ────────────────────────

describe("injectGuidanceIntoHandoff — sc-4-6 (guidance injection)", () => {
  it("appends guidance texts to handoff.issues with 'Human guidance:' prefix", () => {
    const handoff = makeMinimalHandoff(["pre-existing issue"]);
    const result = injectGuidanceIntoHandoff(handoff, ["prefer Zod", "use async/await"]);

    expect(result.issues).toHaveLength(3);
    expect(result.issues[0]).toBe("pre-existing issue");
    expect(result.issues[1]).toBe("Human guidance: prefer Zod");
    expect(result.issues[2]).toBe("Human guidance: use async/await");
  });

  it("does not mutate the original handoff", () => {
    const handoff = makeMinimalHandoff(["original"]);
    const originalIssuesLen = handoff.issues.length;
    injectGuidanceIntoHandoff(handoff, ["new guidance"]);
    expect(handoff.issues).toHaveLength(originalIssuesLen);
  });

  it("full flow: appendGuidance → drainGuidance → inject → surfaces in handoff.issues", async () => {
    const runId = "run-pipeline-test";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "prefer Zod");
    await appendGuidance(tmpDir, runId, "avoid any type");

    const guidance = await drainGuidance(tmpDir, runId);
    expect(guidance).toEqual(["prefer Zod", "avoid any type"]);

    const handoff = makeMinimalHandoff();
    const injected = injectGuidanceIntoHandoff(handoff, guidance);

    expect(injected.issues).toContain("Human guidance: prefer Zod");
    expect(injected.issues).toContain("Human guidance: avoid any type");
  });

  it("second drain returns [] → inject is a no-op (sc-4-5 + sc-4-7 combined)", async () => {
    const runId = "run-second-drain";
    await mkdir(join(tmpDir, ".bober", "runs", runId), { recursive: true });

    await appendGuidance(tmpDir, runId, "some guidance");

    // First drain
    await drainGuidance(tmpDir, runId);

    // Second drain — all consumed
    const guidance2 = await drainGuidance(tmpDir, runId);
    expect(guidance2).toEqual([]);

    const handoff = makeMinimalHandoff();
    const injected = injectGuidanceIntoHandoff(handoff, guidance2);
    // No-op — same reference
    expect(injected).toBe(handoff);
  });
});
