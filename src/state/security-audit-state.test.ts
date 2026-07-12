import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, beforeEach, afterEach } from "vitest";

import { saveSecurityAudit, readSecurityAudit, listSecurityAudits } from "./security-audit-state.js";
import type { SecurityAuditResult } from "../orchestrator/security-audit-types.js";
import type { ReviewResult } from "../orchestrator/code-reviewer-agent.js";

// ── Fixture ───────────────────────────────────────────────────────────

let tmpRoot: string;

beforeEach(async () => {
  tmpRoot = await mkdtemp(join(tmpdir(), "bober-security-state-test-"));
});

afterEach(async () => {
  await rm(tmpRoot, { recursive: true, force: true });
});

function makeResult(overrides?: Partial<ReviewResult>): SecurityAuditResult {
  const review: ReviewResult = {
    reviewId: "r",
    contractId: "c-1",
    specId: "s",
    timestamp: "2026-01-01T00:00:00.000Z",
    summary: "one critical finding",
    critical: [
      {
        description: "SQL injection",
        evidence: [{ path: "src/db.ts", line: 10, snippet: "query(`SELECT ${x}`)" }],
      },
    ],
    important: [],
    minor: [],
    approvedAreas: [],
    ...overrides,
  };
  return { review, stack: "node", scannerRan: false, parsed: true, verdict: "blocked" as const };
}

// ── Tests ─────────────────────────────────────────────────────────────

describe("security-audit-state — round trip", () => {
  it("saves and reads back rendered markdown containing the Critical section", async () => {
    const result = makeResult();
    await saveSecurityAudit(tmpRoot, "c-1", result);

    const content = await readSecurityAudit(tmpRoot, "c-1");
    expect(content).not.toBeNull();
    expect(content).toContain("## Critical");
    expect(content).toContain("SQL injection");
  });

  it("renders via the shared review markdown renderer (matches its output exactly)", async () => {
    const result = makeResult();
    await saveSecurityAudit(tmpRoot, "c-1", result);

    const content = await readSecurityAudit(tmpRoot, "c-1");
    // Independently import the renderer and compare byte-for-byte.
    const { renderReviewMarkdown } = await import("../orchestrator/code-reviewer-agent.js");
    expect(content).toBe(renderReviewMarkdown(result.review));
  });

  it("read of a missing contract id returns null without throwing", async () => {
    await expect(readSecurityAudit(tmpRoot, "does-not-exist")).resolves.toBeNull();
  });

  it("list returns [] when the security directory does not exist", async () => {
    await expect(listSecurityAudits(tmpRoot)).resolves.toEqual([]);
  });

  it("list returns saved contract ids after a save", async () => {
    await saveSecurityAudit(tmpRoot, "c-1", makeResult());
    await saveSecurityAudit(tmpRoot, "c-2", makeResult({ contractId: "c-2" }));

    const ids = await listSecurityAudits(tmpRoot);
    expect(ids).toEqual(["c-1", "c-2"]);
  });

  it("overwrites an existing audit for the same contract id", async () => {
    await saveSecurityAudit(tmpRoot, "c-1", makeResult({ summary: "first pass" }));
    await saveSecurityAudit(
      tmpRoot,
      "c-1",
      makeResult({ summary: "second pass", critical: [] }),
    );

    const content = await readSecurityAudit(tmpRoot, "c-1");
    expect(content).toContain("second pass");
    expect(content).toContain("No critical findings.");

    const ids = await listSecurityAudits(tmpRoot);
    expect(ids).toEqual(["c-1"]);
  });

  it("sanitizes unsafe characters in the contract id for the filename", async () => {
    await saveSecurityAudit(tmpRoot, "c/../1", makeResult());
    const ids = await listSecurityAudits(tmpRoot);
    expect(ids).toEqual(["c____1"]);
  });
});
