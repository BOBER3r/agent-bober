import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SecuritySignatureParser } from "./parser.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";
import { parseFrontmatter } from "../../vault/frontmatter.js";
import type { SecurityStackId } from "./signature.js";

// ── Real-asset table test: parses the four money/crypto per-stack skill
// files (spec-20260714-security-auditor-per-stack-skills, sprint 3) and
// asserts zero dropped blocks — the load-bearing guard against an invalid
// VulnClass (e.g. the non-existent "access-control") silently dropping a
// signature block. ────────────────────────────────────────────────────

interface FileCase {
  stackId: SecurityStackId;
  relPath: string;
  minBlocks: number;
  expectedIdsOrKeywords: string[];
}

const CASES: FileCase[] = [
  {
    stackId: "solidity",
    relPath: "skills/bober.security-solidity/SKILL.md",
    minBlocks: 10,
    expectedIdsOrKeywords: [
      "solidity.reentrancy-single-function",
      "solidity.spot-price-oracle-flashloan",
      "solidity.missing-onlyowner",
      "solidity.erc4626-inflation",
      "solidity.unsafe-erc20",
    ],
  },
  {
    stackId: "anchor",
    relPath: "skills/bober.security-anchor/SKILL.md",
    minBlocks: 6,
    expectedIdsOrKeywords: [
      "anchor.missing-account-constraints",
      "anchor.unchecked-sysvar-loader",
      "anchor.missing-signer-check",
    ],
  },
  {
    stackId: "igaming",
    relPath: "skills/bober.security-igaming/SKILL.md",
    minBlocks: 10,
    expectedIdsOrKeywords: [
      "igaming.toctou-balance-double-spend",
      "igaming.client-supplied-odds",
      "igaming.non-csprng-outcome",
      "igaming.bonus-wagering-abuse",
    ],
  },
  {
    stackId: "dex-backend",
    relPath: "skills/bober.security-dex-backend/SKILL.md",
    minBlocks: 10,
    expectedIdsOrKeywords: [
      "dex.withdrawal-toctou-race",
      "dex.token-decimals-mismatch",
      "dex.hot-wallet-key-in-env",
      "dex.siwe-replay",
    ],
  },
];

describe("SecuritySignatureParser — real money/crypto per-stack skill files", () => {
  for (const testCase of CASES) {
    describe(testCase.relPath, () => {
      it(`parses to >= ${testCase.minBlocks} well-formed signatures with ZERO dropped blocks`, async () => {
        const md = await readFile(new URL(`../../../${testCase.relPath}`, import.meta.url), "utf-8");

        const signatures = SecuritySignatureParser.parse(testCase.stackId, md, testCase.relPath);

        // Zero-drop assertion: every authored "### " block must have parsed —
        // a block using an invalid VulnClass (e.g. "access-control") is
        // silently dropped by the parser, which this assertion catches.
        const rawBlockCount = parseFrontmatter(md).body.split(/^### /m).length - 1;
        expect(signatures.length).toBe(rawBlockCount);

        expect(signatures.length).toBeGreaterThanOrEqual(testCase.minBlocks);

        for (const signature of signatures) {
          expect(signature.stackId).toBe(testCase.stackId);
          expect(signature.signatureId.length).toBeGreaterThan(0);
          expect(signature.title.length).toBeGreaterThan(0);
          expect(ALL_VULN_CLASSES).toContain(signature.vulnClass);
          expect(["critical", "high", "medium", "low", "info"]).toContain(signature.severity);
          expect(signature.unsafeExample.trim()).not.toBe("");
          expect(signature.safeExample.trim()).not.toBe("");
          expect(signature.skillRef).toBe(testCase.relPath);
        }
      });

      it("has unique signatureIds within the file", async () => {
        const md = await readFile(new URL(`../../../${testCase.relPath}`, import.meta.url), "utf-8");
        const signatures = SecuritySignatureParser.parse(testCase.stackId, md, testCase.relPath);
        const ids = signatures.map((s) => s.signatureId);
        expect(new Set(ids).size).toBe(ids.length);
      });

      it("includes the expected money-loss signature ids", async () => {
        const md = await readFile(new URL(`../../../${testCase.relPath}`, import.meta.url), "utf-8");
        const signatures = SecuritySignatureParser.parse(testCase.stackId, md, testCase.relPath);
        const ids = new Set(signatures.map((s) => s.signatureId));
        for (const expectedId of testCase.expectedIdsOrKeywords) {
          expect(ids).toContain(expectedId);
        }
      });
    });
  }

  it("never uses the non-existent 'access-control' VulnClass across any of the four files", async () => {
    for (const testCase of CASES) {
      const md = await readFile(new URL(`../../../${testCase.relPath}`, import.meta.url), "utf-8");
      const signatures = SecuritySignatureParser.parse(testCase.stackId, md, testCase.relPath);
      for (const signature of signatures) {
        expect(signature.vulnClass).not.toBe("access-control");
      }
    }
  });
});
