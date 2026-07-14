/**
 * Unit tests for security-hub.ts
 * (spec-20260712-security-audit-agent-team, sprint 6).
 *
 * Covers:
 * - sc-6-1: pure mapAuditToFindings — severity mapping (critical->5,
 *   important->3), every mapped object validates against the REAL
 *   FindingSchema, stable title (vulnClass + path:line), description +
 *   flattened evidence land in evidence[].
 * - sc-6-2: emitSecurityFindings — sink called once per mapped finding, a
 *   throwing sink is swallowed and logged (never throws), clean audit emits
 *   zero sink calls.
 * - sc-6-3: emitting the same audit result twice through the REAL
 *   finding-store (file-backed, temp dir) leaves one active row per
 *   finding — the hub's content-hash dedup absorbs the duplicate.
 * - sc-6-4: clean audits (no critical/important) emit nothing; minor and
 *   approvedAreas are never emitted. (The "no Finding-shape redefinition /
 *   imports point at src/hub/" grep checks run as a build-time verification
 *   step, not a unit test — see the sprint's verification commands.)
 */

import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

import { mapAuditToFindings, emitSecurityFindings } from "./security-hub.js";
import type { SecurityFindingSink } from "./security-hub.js";
import type { SecurityAuditResult, SecurityFinding } from "./security-audit-types.js";
import { FindingSchema } from "../hub/finding.js";
import type { Finding } from "../hub/finding.js";
import { FactStore } from "../state/facts.js";
import { ingestFinding, readFindings } from "../hub/finding-store.js";
import { logger } from "../utils/logger.js";

// ── Fixtures ──────────────────────────────────────────────────────────

const NOW = "2026-07-12T12:00:00.000Z";
const LATER = "2026-07-12T13:00:00.000Z";

function makeResult(overrides?: Partial<SecurityAuditResult>): SecurityAuditResult {
  const base: SecurityAuditResult = {
    review: {
      reviewId: "r-hub-test",
      contractId: "sec-hub-test",
      specId: "test-spec",
      timestamp: NOW,
      summary: "fixture review",
      critical: [],
      important: [],
      minor: [],
      approvedAreas: [],
    },
    stack: "node",
    scannerRan: false,
    parsed: true,
    verdict: "pass",
  };
  return {
    ...base,
    ...overrides,
    review: { ...base.review, ...overrides?.review },
  };
}

const criticalFinding: SecurityFinding = {
  description: "SQL injection via unescaped string concatenation",
  evidence: [{ path: "src/db.ts", line: 88, snippet: "`SELECT * FROM x WHERE id=${id}`" }],
  vulnClass: "injection",
};

const importantFinding: SecurityFinding = {
  description: "Missing input validation on user-supplied path",
  evidence: [{ path: "src/bar.ts", line: 34, snippet: "readFile(userPath)" }],
  vulnClass: "input-validation",
};

const cleanResult = makeResult();

const resultWithOneCritical = makeResult({
  review: { critical: [criticalFinding] },
  verdict: "blocked",
});

const resultWithCritAndImportant = makeResult({
  review: { critical: [criticalFinding], important: [importantFinding] },
  verdict: "blocked",
});

// ── sc-6-1: pure mapping ────────────────────────────────────────────────

describe("mapAuditToFindings — sc-6-1", () => {
  it("maps critical->severity 5/urgency 5 and important->severity 3/urgency 3; every object validates against FindingSchema", () => {
    const findings = mapAuditToFindings(resultWithCritAndImportant, NOW);
    expect(findings).toHaveLength(2);

    for (const f of findings) {
      expect(() => FindingSchema.parse(f)).not.toThrow();
    }

    const crit = findings.find((f) => f.tags.includes("vuln:injection"));
    const imp = findings.find((f) => f.tags.includes("vuln:input-validation"));
    expect(crit).toBeDefined();
    expect(imp).toBeDefined();
    expect(crit?.severity).toBe(5);
    expect(crit?.urgency).toBe(5);
    expect(imp?.severity).toBe(3);
    expect(imp?.urgency).toBe(3);
  });

  it("builds a STABLE title (vulnClass + path:line) and puts description + flattened evidence in evidence[]", () => {
    const [finding] = mapAuditToFindings(
      makeResult({ review: { critical: [criticalFinding] } }),
      NOW,
    );
    expect(finding).toBeDefined();
    const discriminator = createHash("sha256")
      .update(criticalFinding.description)
      .digest("hex")
      .slice(0, 8);
    expect(finding!.title).toBe(`[security] injection #${discriminator} at src/db.ts:88`);
    expect(finding!.title).not.toContain(criticalFinding.description);
    expect(finding!.evidence).toContain(criticalFinding.description);
    expect(finding!.evidence.some((e) => e.includes("src/db.ts:88"))).toBe(true);
    expect(finding!.domain).toBe("security");
    expect(finding!.kind).toBe("risk");
    expect(finding!.status).toBe("open");
    expect(finding!.tags).toEqual(["security", "vuln:injection", "stack:node"]);
  });

  it("re-mapping the identical finding produces the identical id (retry-idempotent)", () => {
    const [a] = mapAuditToFindings(makeResult({ review: { critical: [criticalFinding] } }), NOW);
    const [b] = mapAuditToFindings(
      makeResult({ review: { critical: [criticalFinding] } }),
      LATER,
    );
    expect(a!.id).toBe(b!.id);
  });

  it("falls back to 'vulnerability'/'unknown'/0 when vulnClass and evidence are absent", () => {
    const bare: SecurityFinding = { description: "Unclassified issue", evidence: [] };
    const [finding] = mapAuditToFindings(makeResult({ review: { critical: [bare] } }), NOW);
    expect(finding).toBeDefined();
    const discriminator = createHash("sha256").update(bare.description).digest("hex").slice(0, 8);
    expect(finding!.title).toBe(`[security] vulnerability #${discriminator} at unknown:0`);
    expect(finding!.tags).toEqual(["security", "stack:node"]);
    expect(finding!.evidence).toEqual(["Unclassified issue"]);
  });

  it("clean audit (no critical/important) maps to []", () => {
    expect(mapAuditToFindings(cleanResult, NOW)).toEqual([]);
  });

  it("never emits minor findings or approvedAreas entries", () => {
    const result = makeResult({
      review: {
        minor: [{ description: "style nit", evidence: [] }],
        approvedAreas: ["src/ok.ts"],
      },
    });
    expect(mapAuditToFindings(result, NOW)).toEqual([]);
  });
});

// ── sc-1-4: hub id collision fix (G10) ──────────────────────────────────

describe("mapAuditToFindings — sc-1-4 hub id collision fix", () => {
  it("two DIFFERENT vulns of the same vulnClass at the same path:line produce two DISTINCT ids", () => {
    const findingA: SecurityFinding = {
      description: "SQL injection in the login handler",
      evidence: [{ path: "src/db.ts", line: 88, snippet: "query(a)" }],
      vulnClass: "injection",
      signatureId: "sig-aaa",
    };
    const findingB: SecurityFinding = {
      description: "SQL injection in the search handler",
      evidence: [{ path: "src/db.ts", line: 88, snippet: "query(b)" }],
      vulnClass: "injection",
      signatureId: "sig-bbb",
    };

    const findings = mapAuditToFindings(
      makeResult({ review: { critical: [findingA, findingB] } }),
      NOW,
    );

    expect(findings).toHaveLength(2);
    expect(findings[0]!.id).not.toBe(findings[1]!.id);
    expect(findings[0]!.title).toContain("#sig-aaa");
    expect(findings[1]!.title).toContain("#sig-bbb");
    expect(findings[0]!.tags).toContain("sig:sig-aaa");
    expect(findings[1]!.tags).toContain("sig:sig-bbb");
  });

  it("a retried identical finding (no signatureId/cwe) still dedups to the same id via the description hash", () => {
    const finding: SecurityFinding = {
      description: "SQL injection in the login handler",
      evidence: [{ path: "src/db.ts", line: 88, snippet: "query(a)" }],
      vulnClass: "injection",
    };

    const [first] = mapAuditToFindings(makeResult({ review: { critical: [finding] } }), NOW);
    const [retried] = mapAuditToFindings(makeResult({ review: { critical: [finding] } }), LATER);

    expect(first!.id).toBe(retried!.id);
  });

  it("cwe/severity/confidence tags are appended only when present, preserving the 3-tag shape otherwise", () => {
    const finding: SecurityFinding = {
      description: "SSRF via unvalidated outbound URL",
      evidence: [{ path: "src/fetch.ts", line: 20, snippet: "fetch(userUrl)" }],
      vulnClass: "ssrf",
      cwe: "CWE-918",
      severity: "high",
      confidence: "firm",
    };

    const [mapped] = mapAuditToFindings(makeResult({ review: { critical: [finding] } }), NOW);

    expect(mapped!.tags).toEqual([
      "security",
      "vuln:ssrf",
      "stack:node",
      "cwe:CWE-918",
      "severity:high",
      "confidence:firm",
    ]);
  });
});

// ── sc-6-2: emission ────────────────────────────────────────────────────

describe("emitSecurityFindings — sc-6-2", () => {
  it("calls the sink once per mapped finding", async () => {
    const calls: Finding[] = [];
    const sink: SecurityFindingSink = async (f) => {
      calls.push(f);
    };

    await emitSecurityFindings(resultWithCritAndImportant, sink, logger, NOW);

    expect(calls).toHaveLength(2);
  });

  it("a throwing sink is swallowed and logged — emitSecurityFindings never throws", async () => {
    const warnSpy = vi.spyOn(logger, "warn").mockImplementation(() => {});
    const sink: SecurityFindingSink = async () => {
      throw new Error("ingest failed");
    };

    await expect(
      emitSecurityFindings(resultWithOneCritical, sink, logger, NOW),
    ).resolves.toBeUndefined();

    expect(warnSpy).toHaveBeenCalled();
    expect(String(warnSpy.mock.calls[0]?.[0])).toContain("ingest failed");
    warnSpy.mockRestore();
  });

  it("clean audit emits zero sink calls", async () => {
    const calls: Finding[] = [];
    const sink: SecurityFindingSink = async (f) => {
      calls.push(f);
    };

    await emitSecurityFindings(cleanResult, sink, logger, NOW);

    expect(calls).toHaveLength(0);
  });
});

// ── sc-6-3: dedup with the REAL finding-store (file-backed, temp dir) ───

describe("emitSecurityFindings — sc-6-3 dedup via the real hub store", () => {
  let tmpRoot: string;

  beforeEach(async () => {
    tmpRoot = await mkdtemp(join(tmpdir(), "bober-sec-hub-"));
  });

  afterEach(async () => {
    await rm(tmpRoot, { recursive: true, force: true });
  });

  it("emitting the same audit result twice (same `now`) leaves exactly one active hub row", async () => {
    const store = new FactStore(join(tmpRoot, "facts.db"));
    const sink: SecurityFindingSink = async (f) => {
      await ingestFinding(store, f, { now: NOW });
    };

    await emitSecurityFindings(resultWithOneCritical, sink, logger, NOW);
    const firstCount = readFindings(store).length;
    expect(firstCount).toBe(1);

    await emitSecurityFindings(resultWithOneCritical, sink, logger, NOW);
    expect(readFindings(store).length).toBe(firstCount);

    store.close();
  });

  it("re-emitting at a later `now` still dedups to one active row (id is content-stable, not clock-stable)", async () => {
    const store = new FactStore(join(tmpRoot, "facts.db"));
    const sinkNow: SecurityFindingSink = async (f) => {
      await ingestFinding(store, f, { now: NOW });
    };
    const sinkLater: SecurityFindingSink = async (f) => {
      await ingestFinding(store, f, { now: LATER });
    };

    await emitSecurityFindings(resultWithOneCritical, sinkNow, logger, NOW);
    await emitSecurityFindings(resultWithOneCritical, sinkLater, logger, LATER);

    const active = readFindings(store);
    expect(active).toHaveLength(1);
    expect(active[0]?.surfacedAt).toBe(LATER);

    store.close();
  });

  it("emitting two distinct findings persists two distinct active rows", async () => {
    const store = new FactStore(join(tmpRoot, "facts.db"));
    const sink: SecurityFindingSink = async (f) => {
      await ingestFinding(store, f, { now: NOW });
    };

    await emitSecurityFindings(resultWithCritAndImportant, sink, logger, NOW);

    expect(readFindings(store)).toHaveLength(2);
    store.close();
  });
});
