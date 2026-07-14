import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, it, expect, beforeAll } from "vitest";

import { resolveStackSecurityContext } from "./resolver.js";
import { SecurityKnowledgeIndex } from "./index.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const REPO_SKILLS_ROOT = join(REPO_ROOT, "skills");

let index: SecurityKnowledgeIndex;

beforeAll(async () => {
  index = new SecurityKnowledgeIndex(REPO_SKILLS_ROOT);
  await index.load();
});

// ── sc-5-4: non-empty, retrieval-grounded promptFragment for all 8 stacks ──

describe("resolveStackSecurityContext — real skill files", () => {
  const CASES: Array<{ stack: string; token: string }> = [
    { stack: "solidity", token: "solidity.reentrancy-single-function" },
    { stack: "anchor", token: "anchor.missing-account-constraints" },
    { stack: "react", token: "react.dangerously-set-inner-html" },
    { stack: "node", token: "node.sql-injection" },
    { stack: "payments", token: "payments.webhook-missing-hmac" },
    { stack: "igaming", token: "igaming.toctou-balance-double-spend" },
    { stack: "dex-backend", token: "dex.withdrawal-toctou-race" },
  ];

  for (const { stack, token } of CASES) {
    it(`renders a non-empty promptFragment containing "${token}" for stack "${stack}"`, async () => {
      const ctx = await resolveStackSecurityContext({
        stack,
        changedPaths: [],
        index,
      });

      expect(ctx.stackId).toBe(stack);
      expect(ctx.skillName).toBe(`bober.security-${stack}`);
      expect(ctx.promptFragment.length).toBeGreaterThan(0);
      expect(ctx.promptFragment).toContain(token);
      expect(ctx.signatures.length).toBeGreaterThan(0);
    });
  }

  it('renders a non-empty promptFragment containing "sql-injection" for an unknown stack (degrades to generic)', async () => {
    const ctx = await resolveStackSecurityContext({
      stack: { frontend: "vue" },
      changedPaths: [],
      index,
    });

    expect(ctx.stackId).toBe("generic");
    expect(ctx.skillName).toBe("bober.security-generic");
    expect(ctx.promptFragment.length).toBeGreaterThan(0);
    expect(ctx.promptFragment).toContain("sql-injection");
  });

  it("renders a non-empty promptFragment for an absent stack (undefined)", async () => {
    const ctx = await resolveStackSecurityContext({
      stack: undefined,
      changedPaths: [],
      index,
    });

    expect(ctx.stackId).toBe("generic");
    expect(ctx.promptFragment.length).toBeGreaterThan(0);
  });

  it("never leaks raw skill-file frontmatter or head-excerpt content into the fragment (G3)", async () => {
    const ctx = await resolveStackSecurityContext({
      stack: "solidity",
      changedPaths: [],
      index,
    });

    // The old defect rendered the skill's YAML frontmatter / head lines
    // verbatim; the new resolver renders only parsed signature fields.
    expect(ctx.promptFragment).not.toContain("name: bober.security-solidity");
    expect(ctx.promptFragment).not.toMatch(/^---/m);
    expect(ctx.promptFragment).toContain("Invariant:");
    expect(ctx.promptFragment).toContain("Unsafe:");
    expect(ctx.promptFragment).toContain("Safe:");
  });

  it("carries the full ALL_VULN_CLASSES taxonomy regardless of stack", async () => {
    const ctx = await resolveStackSecurityContext({
      stack: "node",
      changedPaths: [],
      index,
    });
    expect(ctx.taxonomy).toEqual(ALL_VULN_CLASSES);
  });

  it("appends optional threatModelText verbatim after the rendered signatures", async () => {
    const ctx = await resolveStackSecurityContext({
      stack: "solidity",
      changedPaths: [],
      index,
      threatModelText: "Additional threat model note: watch for oracle staleness.",
    });

    expect(ctx.promptFragment).toContain("Additional threat model note: watch for oracle staleness.");
  });

  it("keeps stackLabel as the matched candidate string (unchanged field name for downstream consumers)", async () => {
    const ctx = await resolveStackSecurityContext({
      stack: { blockchain: "solidity" },
      changedPaths: [],
      index,
    });
    expect(ctx.stackLabel).toBe("solidity");
  });
});

// ── never-empty fallback when the index is entirely empty (no skills on disk) ──

describe("resolveStackSecurityContext — degraded index", () => {
  it("falls back to a non-empty resolveLensFocus fragment when the selected set is empty", async () => {
    const emptyIndex = new SecurityKnowledgeIndex(join(REPO_ROOT, "does-not-exist-skills-dir"));
    await emptyIndex.load();

    const ctx = await resolveStackSecurityContext({
      stack: "solidity",
      changedPaths: [],
      index: emptyIndex,
    });

    expect(ctx.promptFragment.length).toBeGreaterThan(0);
    expect(ctx.signatures).toEqual([]);
  });
});
