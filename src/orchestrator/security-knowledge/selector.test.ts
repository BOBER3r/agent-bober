import { describe, it, expect } from "vitest";
import { selectSignatures } from "./selector.js";
import type { SecuritySignature } from "./signature.js";

function makeSignature(overrides: Partial<SecuritySignature>): SecuritySignature {
  return {
    stackId: "solidity",
    signatureId: "test.signature",
    title: "Test signature",
    cwe: null,
    severity: "high",
    vulnClass: "injection",
    invariant: "Test invariant.",
    unsafeExample: "unsafe();",
    safeExample: "safe();",
    keywords: [],
    skillRef: "skills/bober.security-solidity/SKILL.md",
    ...overrides,
  };
}

// ── sc-5-3: pure ranking + generic floor always present ────────────────

describe("selectSignatures", () => {
  it("ranks a signature whose keywords match diffKeywords ahead of one that doesn't", () => {
    const matching = makeSignature({ signatureId: "solidity.reentrancy", keywords: ["reentrancy", "call"] });
    const nonMatching = makeSignature({ signatureId: "solidity.other", keywords: ["unrelated"] });

    const result = selectSignatures({
      stackId: "solidity",
      changedPaths: [],
      diffKeywords: ["reentrancy"],
      topK: 1,
      stackSignatures: [nonMatching, matching],
      genericFloor: [],
    });

    expect(result).toHaveLength(1);
    expect(result[0].signatureId).toBe("solidity.reentrancy");
  });

  it("respects topK for the ranked (non-floor) portion", () => {
    const signatures = [1, 2, 3, 4, 5].map((n) =>
      makeSignature({ signatureId: `solidity.sig-${n}`, keywords: [`kw${n}`] }),
    );

    const result = selectSignatures({
      stackId: "solidity",
      changedPaths: [],
      diffKeywords: [],
      topK: 2,
      stackSignatures: signatures,
      genericFloor: [],
    });

    expect(result).toHaveLength(2);
  });

  it("ALWAYS includes every generic-floor signature even when it did not rank into topK", () => {
    const stackSig = makeSignature({ signatureId: "solidity.high-score", keywords: ["match"] });
    const genericSig1 = makeSignature({
      stackId: "generic",
      signatureId: "sql-injection",
      keywords: ["sql"],
    });
    const genericSig2 = makeSignature({
      stackId: "generic",
      signatureId: "command-injection",
      keywords: ["shell"],
    });

    const result = selectSignatures({
      stackId: "solidity",
      changedPaths: [],
      diffKeywords: ["match"],
      topK: 1,
      stackSignatures: [stackSig],
      genericFloor: [genericSig1, genericSig2],
    });

    const ids = result.map((s) => s.signatureId);
    expect(ids).toContain("solidity.high-score");
    expect(ids).toContain("sql-injection");
    expect(ids).toContain("command-injection");
  });

  it("dedups by signatureId when a stack signature also appears in the generic floor", () => {
    const shared = makeSignature({ signatureId: "shared.id" });

    const result = selectSignatures({
      stackId: "generic",
      changedPaths: [],
      diffKeywords: [],
      topK: 5,
      stackSignatures: [shared],
      genericFloor: [shared],
    });

    expect(result.filter((s) => s.signatureId === "shared.id")).toHaveLength(1);
  });

  it("scores a path-hint match (basename overlap with signature keywords)", () => {
    const hinted = makeSignature({ signatureId: "solidity.oracle", keywords: ["oracle", "flashloan"] });
    const unhinted = makeSignature({ signatureId: "solidity.unrelated", keywords: ["unrelated"] });

    const result = selectSignatures({
      stackId: "solidity",
      changedPaths: ["contracts/oracle-adapter.sol"],
      diffKeywords: [],
      topK: 1,
      stackSignatures: [unhinted, hinted],
      genericFloor: [],
    });

    expect(result[0].signatureId).toBe("solidity.oracle");
  });

  it("is pure and total: never throws on empty inputs and returns []", () => {
    const result = selectSignatures({
      stackId: "generic",
      changedPaths: [],
      diffKeywords: [],
      topK: 0,
      stackSignatures: [],
      genericFloor: [],
    });
    expect(result).toEqual([]);
  });

  it("is total for a non-positive or non-finite topK — treats it as 0 ranked slots without throwing", () => {
    const sig = makeSignature({ signatureId: "solidity.a" });
    const result = selectSignatures({
      stackId: "solidity",
      changedPaths: [],
      diffKeywords: [],
      topK: -1,
      stackSignatures: [sig],
      genericFloor: [],
    });
    expect(result).toEqual([]);
  });
});
