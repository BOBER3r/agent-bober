/**
 * Unit tests for the sprint-5 scanner pre-filter (src/orchestrator/security-scanners.ts).
 *
 * sc-5-1: parseSlitherOutput / parseSemgrepOutput against committed fixtures + malformed input.
 * sc-5-2: per-scanner isolation (missing binary / nonzero exit -> [] for that scanner only).
 * sc-5-3: shared AbortSignal -> SIGKILL child -> partial results, no hang.
 * sc-5-5: no test here invokes a real slither/semgrep binary (fixtures + an injected runner,
 * or a plain `node -e` command for the real-process abort test).
 */
import { describe, it, expect, vi } from "vitest";
import { readFile } from "node:fs/promises";
import type { EvalStrategy } from "../config/schema.js";
import type { VulnClass } from "./security-audit-types.js";
import type { ScannerRunner, ScannerRunResult } from "./security-scanners.js";
import {
  parseSlitherOutput,
  parseSemgrepOutput,
  parseNpmAuditOutput,
  parseOsvOutput,
  parseGitleaksOutput,
  runScannerPreFilter,
  isNetworkScanner,
} from "./security-scanners.js";

// ── Fixture loading ────────────────────────────────────────────────

async function loadFixture(name: string): Promise<unknown> {
  const url = new URL(`./__fixtures__/${name}`, import.meta.url);
  const raw = await readFile(url, "utf-8");
  return JSON.parse(raw) as unknown;
}

function makeScanner(overrides: Partial<EvalStrategy> & { type: string }): EvalStrategy {
  return { required: true, ...overrides };
}

// ── sc-5-1: parseSlitherOutput ──────────────────────────────────────

describe("parseSlitherOutput — sc-5-1", () => {
  it("maps the committed slither fixture to the expected SecurityFinding[]", async () => {
    const raw = await loadFixture("slither-sample.json");
    const findings = parseSlitherOutput(raw);

    expect(findings).toHaveLength(2);

    const reentrancy = findings[0];
    expect(reentrancy.description).toContain("[High]");
    expect(reentrancy.description).toContain("reentrancy-eth");
    expect(reentrancy.source).toBe("slither");
    expect(reentrancy.evidence[0]).toEqual({
      path: "contracts/Vault.sol",
      line: 42,
      snippet: "function withdraw",
    });
    // reentrancy has no clean VulnClass home — must stay undefined, never a guess.
    expect(reentrancy.vulnClass).toBeUndefined();

    const txOrigin = findings[1];
    expect(txOrigin.description).toContain("[Medium]");
    expect(txOrigin.description).toContain("tx-origin");
    expect(txOrigin.evidence[0]).toEqual({
      path: "contracts/Auth.sol",
      line: 15,
      snippet: "function isOwner",
    });
    expect(txOrigin.vulnClass).toBe("authn-authz");
  });

  it("returns [] for a non-object input (e.g. a truncated JSON string) — never throws", () => {
    expect(parseSlitherOutput('{"success": true, "results": {"detec')).toEqual([]);
    expect(parseSlitherOutput(undefined)).toEqual([]);
    expect(parseSlitherOutput(null)).toEqual([]);
  });

  it("returns [] for valid JSON with the wrong shape — never throws", () => {
    expect(parseSlitherOutput({})).toEqual([]);
    expect(parseSlitherOutput([1, 2, 3])).toEqual([]);
    expect(parseSlitherOutput({ results: "nope" })).toEqual([]);
    expect(parseSlitherOutput({ results: { detectors: "nope" } })).toEqual([]);
  });
});

// ── sc-5-1: parseSemgrepOutput ───────────────────────────────────────

describe("parseSemgrepOutput — sc-5-1", () => {
  it("maps the committed semgrep fixture to the expected SecurityFinding[]", async () => {
    const raw = await loadFixture("semgrep-sample.json");
    const findings = parseSemgrepOutput(raw);

    expect(findings).toHaveLength(2);

    const sqli = findings[0];
    expect(sqli.description).toContain("[ERROR]");
    expect(sqli.description).toContain("javascript.lang.security.audit.sqli.tainted-sql-string");
    expect(sqli.source).toBe("semgrep");
    expect(sqli.evidence[0].path).toBe("src/db/query.js");
    expect(sqli.evidence[0].line).toBe(12);
    expect(sqli.evidence[0].snippet).toContain("SELECT * FROM users");
    expect(sqli.vulnClass).toBe("injection");

    const secret = findings[1];
    expect(secret.description).toContain("[WARNING]");
    expect(secret.evidence[0].path).toBe("src/config.js");
    expect(secret.evidence[0].line).toBe(5);
    expect(secret.vulnClass).toBe("secret-handling");
  });

  it("returns [] for a non-object input (e.g. a truncated JSON string) — never throws", () => {
    expect(parseSemgrepOutput('{"results": [{"check_id": "x", "pa')).toEqual([]);
    expect(parseSemgrepOutput(undefined)).toEqual([]);
  });

  it("returns [] for valid JSON with the wrong shape — never throws", () => {
    expect(parseSemgrepOutput({})).toEqual([]);
    expect(parseSemgrepOutput([1, 2, 3])).toEqual([]);
    expect(parseSemgrepOutput({ results: "nope" })).toEqual([]);
  });
});

// ── sc-1-3: inferVulnClass — new taxonomy mappings ───────────────────

/** Minimal semgrep-shaped payload driving inferVulnClass through the exported parser. */
function semgrepFor(checkId: string): unknown {
  return {
    results: [
      { check_id: checkId, path: "a.ts", start: { line: 1 }, extra: {} },
    ],
  };
}

describe("inferVulnClass — sc-1-3 new taxonomy mappings", () => {
  it.each<[string, VulnClass]>([
    ["generic.xss.reflected-xss-rule", "xss"],
    ["javascript.browser.security.cross-site-scripting", "xss"],
    ["generic.race-condition.rule", "race-condition"],
    ["security.toctou-check", "race-condition"],
    ["generic.ssrf.rule", "ssrf"],
    ["security.server-side-request-forgery", "ssrf"],
    ["generic.insecure-random.rule", "insecure-randomness"],
    ["generic.weak-random.rule", "insecure-randomness"],
    ["generic.weak-crypto-md5", "crypto-weakness"],
    ["generic.weak-crypto-sha1", "crypto-weakness"],
    ["generic.weak-cipher.rule", "crypto-weakness"],
    ["generic.deserialization.unsafe", "deserialization"],
    ["python.pickle.unmarshal", "deserialization"],
    ["generic.idor.rule", "idor-bola"],
    ["generic.bola.rule", "idor-bola"],
    ["generic.dos.resource-exhaustion", "denial-of-service"],
    ["generic.denial-of-service.rule", "denial-of-service"],
  ])("check_id %j -> vulnClass %j", (checkId, expected) => {
    const [finding] = parseSemgrepOutput(semgrepFor(checkId));
    expect(finding.vulnClass).toBe(expected);
  });

  it("an unrecognized check id maps to undefined (never a forced wrong class)", () => {
    const [finding] = parseSemgrepOutput(semgrepFor("generic.totally-unmapped-rule"));
    expect(finding.vulnClass).toBeUndefined();
  });

  it("reentrancy stays unmapped even with the widened taxonomy (not forced)", () => {
    const [finding] = parseSemgrepOutput(semgrepFor("generic.reentrancy-eth.rule"));
    expect(finding.vulnClass).toBeUndefined();
  });
});

// ── sc-5-4: raw-text fallback for unrecognized scanners ─────────────

describe("runScannerPreFilter — parser selection (sc-5-4)", () => {
  it("selects the slither parser by type name and yields typed findings", async () => {
    const fixtureRaw = JSON.stringify(await loadFixture("slither-sample.json"));
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 0,
      stdout: fixtureRaw,
      failed: false,
    }));

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "slither", command: "slither . --json -" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toHaveLength(2);
    expect(findings[0].source).toBe("slither");
    expect(runner).toHaveBeenCalledTimes(1);
    expect(runner).toHaveBeenCalledWith("slither", [".", "--json", "-"], expect.any(Object));
  });

  it("falls back to a raw-text excerpt finding for an unrecognized scanner", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 0,
      stdout: "1 issue found in main.py: unused import 'os' at line 3",
      failed: false,
    }));

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "pylint", command: "pylint main.py" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("pylint");
    expect(findings[0].description).toContain('Raw output from scanner "pylint"');
    expect(findings[0].evidence[0].snippet).toContain("unused import 'os'");
  });

  it("scanners: [] resolves [] and never invokes the runner (zero child processes)", async () => {
    const runner: ScannerRunner = vi.fn();

    const findings = await runScannerPreFilter({
      scanners: [],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toEqual([]);
    expect(runner).not.toHaveBeenCalled();
  });
});

// ── sc-5-2: per-scanner isolation ────────────────────────────────────

describe("runScannerPreFilter — per-scanner isolation (sc-5-2)", () => {
  it("a missing-binary (ENOENT-like throw) scanner yields [] while the others still contribute; never rejects", async () => {
    const slitherRaw = JSON.stringify(await loadFixture("slither-sample.json"));
    const semgrepRaw = JSON.stringify(await loadFixture("semgrep-sample.json"));

    const runner: ScannerRunner = vi.fn(async (cmd): Promise<ScannerRunResult> => {
      if (cmd === "slither") return { exitCode: 0, stdout: slitherRaw, failed: false };
      if (cmd === "semgrep") return { exitCode: 0, stdout: semgrepRaw, failed: false };
      // Simulate the ENOENT a real execa call would throw for a missing binary.
      throw new Error("spawn nonexistent-scanner-binary ENOENT");
    });

    const findings = await runScannerPreFilter({
      scanners: [
        makeScanner({ type: "slither", command: "slither . --json -" }),
        makeScanner({ type: "custom", command: "nonexistent-scanner-binary --scan" }),
        makeScanner({ type: "semgrep", command: "semgrep --config auto --json ." }),
      ],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    // Middle scanner contributed [] (thrown ENOENT); the other two contribute their findings.
    expect(findings.filter((f) => f.source === "slither")).toHaveLength(2);
    expect(findings.filter((f) => f.source === "semgrep")).toHaveLength(2);
    expect(findings).toHaveLength(4);
  });

  it("a nonzero exit yields [] for that scanner while others still run and contribute", async () => {
    const slitherRaw = JSON.stringify(await loadFixture("slither-sample.json"));

    const runner: ScannerRunner = vi.fn(async (cmd): Promise<ScannerRunResult> => {
      if (cmd === "slither") return { exitCode: 0, stdout: slitherRaw, failed: false };
      // Nonzero exit, no throw — resolves normally per execa's reject:false semantics.
      return { exitCode: 1, stdout: "error: rule config not found", failed: true };
    });

    const findings = await runScannerPreFilter({
      scanners: [
        makeScanner({ type: "slither", command: "slither . --json -" }),
        makeScanner({ type: "semgrep", command: "semgrep --config bad-config --json ." }),
      ],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.source === "slither")).toBe(true);
  });
});

// ── sc-5-3: shared AbortSignal -> SIGKILL child -> partial results ──

describe("runScannerPreFilter — abort mid-scan (sc-5-3)", () => {
  it("kills a long-running scanner child on abort and resolves with the findings gathered so far, without hanging", async () => {
    const slitherRaw = JSON.stringify(await loadFixture("slither-sample.json"));
    const ac = new AbortController();

    // Fast scanner resolves immediately with real findings; the "slow" scanner
    // is a real `node -e` process that sleeps far longer than the test should
    // ever wait — the default execa-backed runner is used here (no injected
    // runner) so the abort test exercises the real SIGKILL wiring, not a fake.
    const scanners: EvalStrategy[] = [
      makeScanner({ type: "slither", command: "slither . --json -" }),
      makeScanner({
        type: "custom",
        label: "slow-scanner",
        command: `${process.execPath} -e "setTimeout(()=>{}, 60000)"`,
      }),
    ];

    // Custom runner: real execa for the slow one (to prove the process is
    // actually killed), fixture stdout for the fast one — avoids depending
    // on a real slither binary while still exercising genuine child-process
    // abort semantics for the long-running command.
    const { execa } = await import("execa");
    const runner: ScannerRunner = async (cmd, args, opts) => {
      if (cmd === "slither") {
        return { exitCode: 0, stdout: slitherRaw, failed: false };
      }
      const result = await execa(cmd, args, {
        cwd: opts.cwd,
        cancelSignal: opts.signal,
        killSignal: "SIGKILL",
        reject: false,
        all: true,
      });
      return { exitCode: result.exitCode, stdout: result.all ?? "", failed: result.failed };
    };

    // Fire the abort shortly after the fast scanner would have completed —
    // bounded and fast so the test itself never hangs.
    setTimeout(() => ac.abort(), 100);

    const start = Date.now();
    const findings = await runScannerPreFilter({
      scanners,
      projectRoot: process.cwd(),
      signal: ac.signal,
      runner,
    });
    const elapsedMs = Date.now() - start;

    // Resolves well before the slow scanner's 60s sleep would have finished.
    expect(elapsedMs).toBeLessThan(5_000);
    // Partial results: only the fast scanner's findings survive.
    expect(findings).toHaveLength(2);
    expect(findings.every((f) => f.source === "slither")).toBe(true);
  }, 10_000);
});

// ── sc-7-1: G9 nonzero-exit fix ──────────────────────────────────────

const npmAuditV7Payload = {
  vulnerabilities: {
    minimist: {
      name: "minimist",
      severity: "critical",
      via: [
        {
          title: "Prototype Pollution",
          url: "https://github.com/advisories/GHSA-xxxx",
          severity: "critical",
        },
      ],
      range: "<1.2.6",
      nodes: ["node_modules/minimist"],
      fixAvailable: true,
    },
  },
  metadata: { vulnerabilities: { critical: 1 } },
};

describe("runScannerPreFilter — G9 nonzero-exit fix (sc-7-1)", () => {
  it("an npm-audit scanner exiting nonzero WITH findings on stdout survives — the findings are parsed, not discarded", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 1,
      stdout: JSON.stringify(npmAuditV7Payload),
      failed: true,
    }));

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "npm-audit", command: "npm audit --json" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings.length).toBeGreaterThan(0);
    expect(findings[0].source).toBe("npm-audit");
    expect(findings[0].vulnClass).toBe("supply-chain");
  });

  it("an npm-audit scanner that fails to spawn (exitCode undefined, ENOENT) yields [] — spawn failure is still discarded", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: undefined,
      stdout: "",
      failed: true,
    }));

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "npm-audit", command: "npm audit --json" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toEqual([]);
  });

  it("an npm-audit scanner whose runner THROWS (real ENOENT) still yields [] — the outer catch is unchanged", async () => {
    const runner: ScannerRunner = vi.fn(async () => {
      throw new Error("spawn npm ENOENT");
    });

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "npm-audit", command: "npm audit --json" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toEqual([]);
  });

  it("a nonzero semgrep exit STILL yields [] — the G9 fix does not flip semgrep's zero-clean policy", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 1,
      stdout: JSON.stringify({ results: [{ check_id: "x", path: "a.ts", start: { line: 1 }, extra: {} }] }),
      failed: true,
    }));

    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "semgrep", command: "semgrep --config auto --error --json ." })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });

    expect(findings).toEqual([]);
  });
});

// ── sc-7-2: parseNpmAuditOutput / parseOsvOutput / parseGitleaksOutput ─

describe("parseNpmAuditOutput — sc-7-2", () => {
  it("maps a real-shaped npm audit v7+ payload to a supply-chain finding", () => {
    const findings = parseNpmAuditOutput(npmAuditV7Payload);
    expect(findings).toHaveLength(1);
    expect(findings[0].vulnClass).toBe("supply-chain");
    expect(findings[0].source).toBe("npm-audit");
    expect(findings[0].description).toContain("minimist");
    expect(findings[0].description).toContain("Prototype Pollution");
    expect(findings[0].evidence[0].path).toBe("node_modules/minimist");
  });

  it("falls back to the v6 advisories shape when vulnerabilities is absent", () => {
    const findings = parseNpmAuditOutput({
      advisories: {
        "1179": {
          module_name: "minimist",
          severity: "high",
          title: "Prototype Pollution",
          url: "https://npmjs.com/advisories/1179",
        },
      },
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].vulnClass).toBe("supply-chain");
    expect(findings[0].source).toBe("npm-audit");
    expect(findings[0].description).toContain("minimist");
  });

  it.each([undefined, null, "{trunc", {}, [1, 2, 3], { vulnerabilities: "nope" }, { advisories: "nope" }])(
    "garbage %j -> []",
    (g) => {
      expect(parseNpmAuditOutput(g)).toEqual([]);
    },
  );
});

describe("parseOsvOutput — sc-7-2", () => {
  it("maps a real-shaped osv-scanner payload to a supply-chain finding", () => {
    const findings = parseOsvOutput({
      results: [
        {
          source: { path: "/repo/package-lock.json", type: "lockfile" },
          packages: [
            {
              package: { name: "lodash", ecosystem: "npm", version: "4.17.20" },
              vulnerabilities: [
                {
                  id: "GHSA-p6mc-m468-83gg",
                  summary: "Prototype pollution in lodash",
                  severity: [{ type: "CVSS_V3", score: "7.4" }],
                },
              ],
            },
          ],
        },
      ],
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].vulnClass).toBe("supply-chain");
    expect(findings[0].source).toBe("osv-scanner");
    expect(findings[0].description).toContain("GHSA-p6mc-m468-83gg");
    expect(findings[0].description).toContain("lodash");
    expect(findings[0].evidence[0].path).toBe("/repo/package-lock.json");
  });

  it.each([undefined, null, "{trunc", {}, [1, 2, 3], { results: "nope" }])("garbage %j -> []", (g) => {
    expect(parseOsvOutput(g)).toEqual([]);
  });
});

describe("parseGitleaksOutput — sc-7-2", () => {
  it("maps a real-shaped gitleaks payload (top-level array) to a secret-handling finding, never echoing the raw Secret", () => {
    const findings = parseGitleaksOutput([
      {
        Description: "AWS Access Key",
        File: "src/config.ts",
        StartLine: 12,
        EndLine: 12,
        RuleID: "aws-access-token",
        Secret: "AKIALIVE_CREDENTIAL_DO_NOT_LEAK",
        Match: "const k = 'AKIA...'",
        Commit: "abc123",
      },
    ]);
    expect(findings).toHaveLength(1);
    expect(findings[0].vulnClass).toBe("secret-handling");
    expect(findings[0].source).toBe("gitleaks");
    expect(findings[0].evidence[0].path).toBe("src/config.ts");
    expect(findings[0].evidence[0].line).toBe(12);
    expect(findings[0].evidence[0].snippet).not.toContain("AKIALIVE_CREDENTIAL_DO_NOT_LEAK");
  });

  it.each([undefined, null, "{trunc", {}, { Description: "not an array" }])("garbage %j -> []", (g) => {
    expect(parseGitleaksOutput(g)).toEqual([]);
  });
});

// ── sc-7-2: detectScannerKind recognizes the 3 new kinds ─────────────

describe("runScannerPreFilter — new scanner kind detection (sc-7-2)", () => {
  it("selects the npm-audit parser by type name", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 0,
      stdout: JSON.stringify(npmAuditV7Payload),
      failed: false,
    }));
    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "npm-audit", command: "npm audit --json" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });
    expect(findings[0].source).toBe("npm-audit");
  });

  it("selects the osv-scanner parser by command substring", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 0,
      stdout: JSON.stringify({ results: [] }),
      failed: false,
    }));
    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "custom", command: "osv-scanner --format json ." })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });
    expect(findings).toEqual([]); // empty results -> [] findings, but no exception/fallback
    expect(runner).toHaveBeenCalledWith("osv-scanner", ["--format", "json", "."], expect.any(Object));
  });

  it("selects the gitleaks parser by type name", async () => {
    const runner: ScannerRunner = vi.fn(async (): Promise<ScannerRunResult> => ({
      exitCode: 1, // gitleaks exits nonzero when it finds secrets (G9)
      stdout: JSON.stringify([
        { Description: "Generic Secret", File: "a.ts", StartLine: 1, RuleID: "generic", Match: "x" },
      ]),
      failed: true,
    }));
    const findings = await runScannerPreFilter({
      scanners: [makeScanner({ type: "gitleaks", command: "gitleaks detect --report-format json" })],
      projectRoot: "/tmp/project",
      signal: new AbortController().signal,
      runner,
    });
    expect(findings).toHaveLength(1);
    expect(findings[0].source).toBe("gitleaks");
    expect(findings[0].vulnClass).toBe("secret-handling");
  });
});

// ── isNetworkScanner (sc-7-5 support) ─────────────────────────────────

describe("isNetworkScanner", () => {
  it("returns true for npm-audit and osv-scanner", () => {
    expect(isNetworkScanner(makeScanner({ type: "npm-audit", command: "npm audit --json" }))).toBe(true);
    expect(isNetworkScanner(makeScanner({ type: "custom", command: "osv-scanner --format json ." }))).toBe(true);
  });

  it("returns false for gitleaks (local secret scan) and other kinds", () => {
    expect(isNetworkScanner(makeScanner({ type: "gitleaks", command: "gitleaks detect" }))).toBe(false);
    expect(isNetworkScanner(makeScanner({ type: "slither", command: "slither . --json -" }))).toBe(false);
    expect(isNetworkScanner(makeScanner({ type: "semgrep", command: "semgrep --json ." }))).toBe(false);
  });
});
