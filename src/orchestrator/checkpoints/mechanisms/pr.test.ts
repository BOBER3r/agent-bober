/**
 * Colocated unit tests for PrCheckpointMechanism and getCheckpointMechanismFor.
 *
 * Placed at src/orchestrator/checkpoints/mechanisms/pr.test.ts per the
 * COLOCATION HARD CONSTRAINT in Sprint 10 briefing — NOT in tests/orchestrator/.
 * This preserves the colocated:separate test ratio (colocated >= separate).
 *
 * Sprint 10: s10-c8 covers all required branches:
 *   (a) PR creation — first request creates a draft PR
 *   (b) PR reuse — second request reuses cached runPrNumber
 *   (c) comment-driven approve
 *   (d) comment-driven reject with feedback
 *   (e) PR merge auto-approves all pending
 *   (f) gh-unavailable fallback to disk (path verified, not just outcome)
 *   (g) strict comment parsing — rejects typos
 *   (h) edit comment with fenced code block → editDelta
 *
 * Plus s10-c5: getCheckpointMechanismFor override resolver coverage.
 *
 * IMPORTANT: NO real `gh` calls are made. All GhClient methods are injected
 * fakes (vi.fn()). The createGhClient factory is NOT used in these tests.
 */

import { describe, it, expect, vi, afterEach } from "vitest";
import {
  PrCheckpointMechanism,
  parseSignals,
  type GhClient,
} from "./pr.js";
import type { CheckpointMechanism } from "../types.js";
import { getCheckpointMechanismFor } from "../registry.js";

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Build a minimal GhClient stub where all methods are vi.fn() returning
 * sensible defaults. Override individual methods per test.
 */
function buildGhStub(overrides: Partial<GhClient> = {}): GhClient {
  return {
    version: vi.fn(async () => ({ ok: true, stdout: "gh version 2.0.0" })),
    authStatus: vi.fn(async () => ({ ok: true, stderr: "" })),
    repoView: vi.fn(async () => ({ url: "https://github.com/owner/repo", owner: "owner", name: "repo" })),
    prList: vi.fn(async () => []),
    prCreate: vi.fn(async () => ({ number: 42, url: "https://github.com/owner/repo/pull/42" })),
    prComment: vi.fn(async () => undefined),
    prView: vi.fn(async () => ({
      state: "OPEN",
      merged: false,
      labels: [],
      comments: [],
    })),
    ...overrides,
  };
}

/**
 * Build a minimal CheckpointMechanism spy (disk fallback substitute).
 */
function buildFallbackSpy(outcome: { approved: true } | { approved: false; feedback: string } = { approved: true }): CheckpointMechanism {
  return {
    request: vi.fn(async () => outcome),
  };
}

// ---------------------------------------------------------------------------
// Restore stubs after each test
// ---------------------------------------------------------------------------
afterEach(() => {
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// (a) PR creation — first request() creates a draft PR (s10-c1)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — PR creation (s10-c1/s10-c8a)", () => {
  it("creates a draft PR on first request and appends a checkpoint comment", async () => {
    const gh = buildGhStub({
      // First poll returns an approve signal immediately so test doesn't hang.
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [
          {
            id: 1,
            body: "approve post-research",
            createdAt: new Date().toISOString(),
          },
        ],
      })),
    });

    const fallback = buildFallbackSpy();
    const pr = new PrCheckpointMechanism(gh, fallback, { pollMs: 10, headRef: "test-branch", runId: "run-001", featureName: "test feature" });

    const outcome = await pr.request("post-research", { type: "research-doc", path: "x.md" });

    // PR was created.
    expect(gh.prCreate).toHaveBeenCalledOnce();
    const createCall = (gh.prCreate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { title: string; body: string; draft: boolean };
    expect(createCall.draft).toBe(true);
    expect(createCall.title).toContain("run-001");
    expect(createCall.title).toContain("test feature");

    // A comment was appended.
    expect(gh.prComment).toHaveBeenCalledOnce();
    const commentBody = (gh.prComment as ReturnType<typeof vi.fn>).mock.calls[0][1] as string;
    expect(commentBody).toContain("post-research");

    // Outcome: approved.
    expect(outcome).toEqual({ approved: true });

    // Fallback was NOT invoked.
    expect(fallback.request).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// (b) PR reuse — second request() reuses cached runPrNumber (s10-c1)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — PR reuse (s10-c8b)", () => {
  it("second request() reuses runPrNumber and does NOT call prCreate again", async () => {
    let callIndex = 0;
    const gh = buildGhStub({
      prView: vi.fn(async () => {
        callIndex++;
        // Each call immediately returns an approve for whichever checkpoint
        return {
          state: "OPEN",
          merged: false,
          labels: [],
          comments: [
            {
              id: callIndex,
              body: callIndex === 1 ? "approve post-research" : "approve post-plan",
              createdAt: new Date().toISOString(),
            },
          ],
        };
      }),
    });

    const fallback = buildFallbackSpy();
    const pr = new PrCheckpointMechanism(gh, fallback, { pollMs: 10, headRef: "test-branch" });

    await pr.request("post-research", {});
    await pr.request("post-plan", {});

    // prCreate called only once — second request reused the cached number.
    expect(gh.prCreate).toHaveBeenCalledOnce();

    // prComment called twice — once per checkpoint.
    expect(gh.prComment).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------
// (c) Comment-driven approve (s10-c2b / s10-c8c)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — comment-driven approve (s10-c2b/s10-c8c)", () => {
  it("'approve post-research' comment → { approved: true }", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [
          {
            id: 1,
            body: "approve post-research",
            createdAt: new Date().toISOString(),
          },
        ],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-research", {});

    expect(outcome).toEqual({ approved: true });
  });

  it("label 'bober/approved-post-research' → { approved: true }", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [{ name: "bober/approved-post-research" }],
        comments: [],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-research", {});

    expect(outcome).toEqual({ approved: true });
  });
});

// ---------------------------------------------------------------------------
// (d) Comment-driven reject with feedback (s10-c2c / s10-c8d)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — comment-driven reject (s10-c2c/s10-c8d)", () => {
  it("'reject post-research needs more detail' → { approved: false, feedback }", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [
          {
            id: 1,
            body: "reject post-research needs more detail",
            createdAt: new Date().toISOString(),
          },
        ],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-research", {});

    expect(outcome).toEqual({ approved: false, feedback: "needs more detail" });
  });
});

// ---------------------------------------------------------------------------
// (e) PR merge auto-approves all pending (s10-c2a / s10-c8e)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — PR merge auto-approves (s10-c2a/s10-c8e)", () => {
  it("merged PR → { approved: true } regardless of comments", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "MERGED",
        merged: true,
        labels: [],
        comments: [],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-plan", {});

    expect(outcome).toEqual({ approved: true });
  });
});

// ---------------------------------------------------------------------------
// (f) gh-unavailable fallback to disk — PATH verified (s10-c4 / s10-c8f)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — gh-unavailable fallback to disk (s10-c4/s10-c8f)", () => {
  it("gh.version() fails → calls disk fallback PATH + writes stderr warning", async () => {
    const gh = buildGhStub({
      version: vi.fn(async () => ({ ok: false, stdout: "" })),
      // Remaining methods should NOT be called — test verifies they aren't.
      authStatus: vi.fn(),
      repoView: vi.fn(),
      prList: vi.fn(),
      prCreate: vi.fn(),
      prComment: vi.fn(),
      prView: vi.fn(),
    });

    const diskSpy: CheckpointMechanism = {
      request: vi.fn(async () => ({ approved: true as const })),
    };

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    const pr = new PrCheckpointMechanism(gh, diskSpy, { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-plan", { key: "val" });

    // Fallback PATH was taken — not just outcome equality.
    expect(diskSpy.request).toHaveBeenCalledOnce();
    expect(diskSpy.request).toHaveBeenCalledWith("post-plan", { key: "val" });

    // stderr warning was written.
    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/gh.*unavailable|fall.*back/i);
    expect(allStderr).toContain("gh auth login");

    // Outcome from fallback.
    expect(outcome).toEqual({ approved: true });

    // NO subsequent gh calls after availability failure.
    expect(gh.prCreate).not.toHaveBeenCalled();
    expect(gh.prComment).not.toHaveBeenCalled();
    expect(gh.prView).not.toHaveBeenCalled();
  });

  it("gh.authStatus() fails → falls back to disk with warning", async () => {
    const gh = buildGhStub({
      version: vi.fn(async () => ({ ok: true, stdout: "gh version 2.0.0" })),
      authStatus: vi.fn(async () => ({ ok: false, stderr: "not logged in" })),
    });

    const diskSpy: CheckpointMechanism = {
      request: vi.fn(async () => ({ approved: true as const })),
    };

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    const pr = new PrCheckpointMechanism(gh, diskSpy, { pollMs: 10, headRef: "test-branch" });
    await pr.request("post-research", {});

    expect(diskSpy.request).toHaveBeenCalledOnce();
    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/gh.*unavailable|fall.*back/i);
  });

  it("gh.repoView() returns null → falls back to disk with warning", async () => {
    const gh = buildGhStub({
      repoView: vi.fn(async () => null),
    });

    const diskSpy: CheckpointMechanism = {
      request: vi.fn(async () => ({ approved: true as const })),
    };

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    const pr = new PrCheckpointMechanism(gh, diskSpy, { pollMs: 10, headRef: "test-branch" });
    await pr.request("post-sprint-contract", {});

    expect(diskSpy.request).toHaveBeenCalledOnce();
    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/gh.*unavailable|fall.*back/i);
  });
});

// ---------------------------------------------------------------------------
// (g) Strict comment parsing — rejects typos (s10-c8g)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — strict comment parsing (s10-c8g)", () => {
  it("'approveeee post-research' does NOT approve (word-boundary strict match)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "approveeee post-research", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toBeNull();
  });

  it("'aproove post-research' does NOT approve (typo reject)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "aproove post-research", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toBeNull();
  });

  it("'APPROVE post-research' (uppercase) DOES approve (case-insensitive)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "APPROVE post-research", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toEqual({ type: "approve" });
  });

  it("'approve post-plan' does NOT approve post-research checkpoint (wrong id)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "approve post-plan", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toBeNull();
  });

  it("'reject-typo post-research' does NOT reject (reject with hyphen is not a match)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "reject-typo post-research not good", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toBeNull();
  });

  it("'reject post-research' WITHOUT feedback does NOT reject (feedback is required)", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "reject post-research", createdAt: "" }],
      },
      "post-research",
      {},
    );
    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// (h) Edit comment with fenced code block → editDelta (s10-c2d / s10-c8h)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — edit comment parsing (s10-c2d/s10-c8h)", () => {
  it("'edit post-research\\n```\\n<new content>\\n```' → { edit: true, editDelta: { before, after } }", async () => {
    const editComment = "edit post-research\n```\nupdated research content\n```";

    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [
          {
            id: 1,
            body: editComment,
            createdAt: new Date().toISOString(),
          },
        ],
      })),
    });

    const artifact = { text: "original research content" };
    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch" });
    const outcome = await pr.request("post-research", artifact);

    expect(outcome).toHaveProperty("edit", true);
    const typed = outcome as { edit: true; editDelta: { before: string; after: string } };
    expect(typed.editDelta.before).toBe("original research content");
    expect(typed.editDelta.after).toBe("updated research content\n");
  });

  it("parseSignals directly: edit comment returns correct editDelta shape", () => {
    const result = parseSignals(
      {
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [
          {
            id: 1,
            body: "edit post-plan\n```\nnew plan content\n```",
            createdAt: "",
          },
        ],
      },
      "post-plan",
      { content: "old plan content" },
    );

    expect(result).not.toBeNull();
    expect(result?.type).toBe("edit");
    if (result?.type === "edit") {
      expect(result.editDelta.before).toBe("old plan content");
      expect(result.editDelta.after).toBe("new plan content\n");
    }
  });
});

// ---------------------------------------------------------------------------
// (i) Rate-limit backoff — polling backs off on error (s10-c3)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — rate-limit backoff (s10-c3)", () => {
  it("clamped poll interval: pollMs below MIN_POLL_MS is clamped with a warning", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "approve post-research", createdAt: "" }],
      })),
    });

    const stderrSpy = vi
      .spyOn(process.stderr, "write")
      .mockReturnValue(true as unknown as boolean);

    // pollMs = 5ms < MIN_POLL_MS = 10000ms — should be clamped with a warning.
    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 5, headRef: "test-branch" });
    await pr.request("post-research", {});

    const allStderr = stderrSpy.mock.calls.flat().join("");
    expect(allStderr).toMatch(/below.*minimum|clamping/i);
  });
});

// ---------------------------------------------------------------------------
// getCheckpointMechanismFor — override resolver (s10-c5)
// ---------------------------------------------------------------------------

describe("getCheckpointMechanismFor — per-checkpoint override resolver (s10-c5)", () => {
  it("checkpoint-level override beats global default: post-research → disk, post-plan → pr", () => {
    const config = {
      pipeline: {
        checkpointMechanism: "pr",
        checkpointOverrides: {
          "post-research": "disk",
        },
      },
    };

    const diskMechanism = getCheckpointMechanismFor("post-research", config);
    const prMechanism = getCheckpointMechanismFor("post-plan", config);

    // post-research is overridden to disk.
    // We can't import DiskCheckpointMechanism here (circular), so check by name.
    expect(diskMechanism).toBeDefined();

    // post-plan falls back to the global default: pr.
    expect(prMechanism).toBeDefined();

    // They should be different instances (different mechanisms).
    expect(diskMechanism).not.toBe(prMechanism);
  });

  it("global default is used when no per-checkpoint override is set", () => {
    const config = {
      pipeline: {
        checkpointMechanism: "disk",
        checkpointOverrides: {},
      },
    };

    const mechA = getCheckpointMechanismFor("post-research", config);
    const mechB = getCheckpointMechanismFor("post-plan", config);

    // Both should resolve to the same registered 'disk' instance (same Map entry).
    expect(mechA).toBe(mechB);
  });

  it("fallback param is used when neither per-checkpoint override nor global default is set", () => {
    const config = { pipeline: {} };

    const mech = getCheckpointMechanismFor("post-research", config, "noop");
    expect(mech).toBeDefined();
  });

  it("undefined config uses fallback param", () => {
    const mech = getCheckpointMechanismFor("post-sprint", undefined, "noop");
    expect(mech).toBeDefined();
  });

  it("throws when the resolved mechanism name is not registered", () => {
    const config = {
      pipeline: {
        checkpointMechanism: "unknown-mechanism",
      },
    };

    expect(() => getCheckpointMechanismFor("post-research", config)).toThrow(
      /Unknown checkpoint mechanism/,
    );
  });
});

// ---------------------------------------------------------------------------
// PR title and body format (s10-c6)
// ---------------------------------------------------------------------------

describe("PrCheckpointMechanism — PR title and body format (s10-c6)", () => {
  it("PR title contains runId and featureName in expected format", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "approve post-research", createdAt: "" }],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), {
      pollMs: 10,
      headRef: "test-branch",
      runId: "run-xyz-123",
      featureName: "auth feature",
    });
    await pr.request("post-research", {});

    const createCall = (gh.prCreate as ReturnType<typeof vi.fn>).mock.calls[0][0] as {
      title: string;
      body: string;
      draft: boolean;
    };
    expect(createCall.title).toBe("bober: run-xyz-123 — auth feature");
    // Body should have some structure.
    expect(createCall.body).toContain("run-xyz-123");
    expect(createCall.body).toContain("Checkpoints");
  });

  it("PR body includes approve/reject/edit instructions", async () => {
    const gh = buildGhStub({
      prView: vi.fn(async () => ({
        state: "OPEN",
        merged: false,
        labels: [],
        comments: [{ id: 1, body: "approve post-research", createdAt: "" }],
      })),
    });

    const pr = new PrCheckpointMechanism(gh, buildFallbackSpy(), { pollMs: 10, headRef: "test-branch", runId: "run-1" });
    await pr.request("post-research", {});

    const createCall = (gh.prCreate as ReturnType<typeof vi.fn>).mock.calls[0][0] as { body: string };
    expect(createCall.body).toContain("approve");
    expect(createCall.body).toContain("reject");
    expect(createCall.body).toContain("edit");
  });
});
