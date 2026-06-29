import { describe, it, expect } from "vitest";
import { codingPromoter } from "./coding-promoter.js";
import type { Finding } from "../hub/finding.js";

const T = "2026-06-28T00:00:00.000Z";

const CODING_FINDING: Finding = {
  id: "abc123def456abc1",
  domain: "coding",
  title: "fix the CI build",
  kind: "action",
  urgency: 3,
  severity: 2,
  evidence: [],
  surfacedAt: T,
  tags: [],
  status: "open",
};

describe("codingPromoter — sc-1-3", () => {
  it("returns kind='bober-run' for a coding finding", () => {
    const plan = codingPromoter(CODING_FINDING);
    expect(plan.kind).toBe("bober-run");
  });

  it("task is a non-empty string derived from the finding title", () => {
    const plan = codingPromoter(CODING_FINDING);
    expect(plan.task).toBeTruthy();
    expect(plan.task.length).toBeGreaterThan(0);
    expect(plan.task).toContain(CODING_FINDING.title);
  });

  it("task includes evidence when evidence is non-empty", () => {
    const finding: Finding = {
      ...CODING_FINDING,
      evidence: ["build fails on node 20", "missing env var CI"],
    };
    const plan = codingPromoter(finding);
    expect(plan.task).toContain("build fails on node 20");
  });

  it("appends at most two evidence lines", () => {
    const finding: Finding = {
      ...CODING_FINDING,
      evidence: ["evidence 1", "evidence 2", "evidence 3"],
    };
    const plan = codingPromoter(finding);
    expect(plan.task).toContain("evidence 1");
    expect(plan.task).toContain("evidence 2");
    // third evidence line should not appear
    expect(plan.task).not.toContain("evidence 3");
  });

  it("teamId is undefined when no team tag is present", () => {
    const plan = codingPromoter(CODING_FINDING);
    expect(plan.teamId).toBeUndefined();
  });

  it("teamId is extracted from a team:<id> tag", () => {
    const finding: Finding = {
      ...CODING_FINDING,
      tags: ["team:backend", "priority:high"],
    };
    const plan = codingPromoter(finding);
    expect(plan.teamId).toBe("backend");
  });

  it("works for a projects domain finding", () => {
    const finding: Finding = {
      ...CODING_FINDING,
      domain: "projects",
      title: "migrate database to postgres",
    };
    const plan = codingPromoter(finding);
    expect(plan.kind).toBe("bober-run");
    expect(plan.task).toContain("migrate database to postgres");
  });

  it("task is a single line (no newlines)", () => {
    const finding: Finding = {
      ...CODING_FINDING,
      evidence: ["first evidence line", "second evidence line"],
    };
    const plan = codingPromoter(finding);
    expect(plan.task).not.toContain("\n");
  });
});
