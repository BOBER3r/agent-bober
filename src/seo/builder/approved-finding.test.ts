/**
 * Tests for `ApprovedFinding` / `readApprovedSeoFindings` / `SeoDraft`
 * (spec-20260717-seo-improver-builder, Sprint 11, sc-11-1..sc-11-5).
 */
import { describe, it, expect } from "vitest";

import { FactStore } from "../../state/facts.js";
import { HUB_SCOPE } from "../../hub/finding-source.js";
import type { SeoFinding } from "../types.js";

import { ApprovedFinding } from "./approved-finding.js";
import type { ApprovedHubFinding } from "./approved-finding.js";
import { readApprovedSeoFindings } from "./hub-approved-source.js";
import type { SeoDraft } from "./draft-types.js";

const T = "2026-07-16T00:00:00.000Z";

// ── Fixtures ─────────────────────────────────────────────────────────

function makeApprovedRow(overrides: Partial<ApprovedHubFinding> = {}): ApprovedHubFinding {
  return {
    id: "abc",
    domain: "seo",
    title: "[seo] technical-audit: Fix title",
    kind: "action",
    urgency: 3,
    severity: 3,
    surfacedAt: T,
    tags: ["seo", "workflow:technical-audit", "playbook:seo.tech.title", "confidence:firm"],
    evidence: ["Fix title", "cite:https://developers.google.com/search/docs"],
    status: "approved",
    ...overrides,
  };
}

function makeSeoFinding(overrides: Partial<SeoFinding> = {}): SeoFinding {
  return {
    recommendation: "De-duplicate the title tag shared by /a and /b.",
    workflow: "technical-audit",
    playbookRef: "seo.technical-audit.title-tags",
    citationUrl: "https://developers.google.com/search/docs/appearance/title-link",
    evidence: [{ metric: "coverageState", value: "Indexed", source: "url-inspection", url: "https://example.com/a" }],
    severity: 3,
    humanApprovalRequired: false,
    confidence: "firm",
    ...overrides,
  };
}

function seedFact(store: FactStore, subject: string, value: string): void {
  store.insertFact({
    scope: HUB_SCOPE,
    subject,
    predicate: "finding",
    value,
    confidence: 1,
    sourceRunId: null,
    tValid: T,
    tCreated: T,
  });
}

// ── ApprovedFinding.from (sc-11-1 / sc-11-2 / sc-11-4) ────────────────

describe("ApprovedFinding.from", () => {
  it("builds an ApprovedFinding from an approved, cited, seo-domain hub Finding", () => {
    const a = ApprovedFinding.from(makeApprovedRow());
    expect(a).not.toBeNull();
    expect(a!.sourceFindingId).toBe("abc");
    expect(a!.sourceCitationUrl).toBe("https://developers.google.com/search/docs");
    expect(a!.severity).toBe(3);
    expect(a!.playbookRef).toBe("seo.tech.title");
    expect(a!.workflow).toBe("technical-audit");
  });

  it("returns null for a non-approved Finding (sc-11-2) — open", () => {
    expect(ApprovedFinding.from(makeApprovedRow({ status: "open" }))).toBeNull();
  });

  it("returns null for a dropped Finding (sc-11-2) — gate-dropped/downgraded never reaches approved", () => {
    expect(ApprovedFinding.from(makeApprovedRow({ status: "dropped" }))).toBeNull();
  });

  it("returns null for an in-progress/snoozed/done Finding", () => {
    expect(ApprovedFinding.from(makeApprovedRow({ status: "in-progress" }))).toBeNull();
    expect(ApprovedFinding.from(makeApprovedRow({ status: "snoozed" }))).toBeNull();
    expect(ApprovedFinding.from(makeApprovedRow({ status: "done" }))).toBeNull();
  });

  it("returns null when the cite: evidence entry is missing (uncited, sc-11-2)", () => {
    expect(ApprovedFinding.from(makeApprovedRow({ evidence: ["no citation here"] }))).toBeNull();
  });

  it("returns null when the cite: evidence entry is malformed (not an absolute http(s) URL)", () => {
    expect(ApprovedFinding.from(makeApprovedRow({ evidence: ["cite:not-a-url"] }))).toBeNull();
    expect(ApprovedFinding.from(makeApprovedRow({ evidence: ["cite:ftp://example.com/x"] }))).toBeNull();
  });

  it("never throws on a malformed/incomplete row", () => {
    expect(() => ApprovedFinding.from(makeApprovedRow({ evidence: [] }))).not.toThrow();
    expect(ApprovedFinding.from(makeApprovedRow({ evidence: [] }))).toBeNull();
  });
});

// ── Compile-time impossibility proof (sc-11-1 / sc-11-2) ──────────────

describe("ApprovedFinding — resurrection is structurally impossible (compile-proof)", () => {
  it("cannot be constructed from a raw SeoFinding, and has no public constructor", () => {
    const raw: SeoFinding = makeSeoFinding();

    // @ts-expect-error — a raw SeoFinding is NOT an ApprovedFinding (nominal brand; sc-11-1/sc-11-2)
    const bad: ApprovedFinding = raw;

    // @ts-expect-error — the constructor is private; no external `new` (sc-11-1)
    const alsoBad = new ApprovedFinding("x", "y", "z", 3, "p", "w");

    // Both lines above are TS compile errors — if either @ts-expect-error
    // does NOT error, `tsc --noEmit` fails, which is exactly the guarantee
    // sc-11-1/sc-11-2 require. Runtime assertions below just prove the test
    // file itself executes past the (intentionally erroring) lines.
    expect(bad).toBeDefined();
    expect(alsoBad).toBeDefined();
  });
});

// ── readApprovedSeoFindings — hub adapter (sc-11-4) ───────────────────

describe("readApprovedSeoFindings", () => {
  it("maps an approved, cited, seo-domain row to an ApprovedFinding", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "abc", JSON.stringify(makeApprovedRow()));

    const result = readApprovedSeoFindings(store);

    expect(result).toHaveLength(1);
    expect(result[0]?.sourceFindingId).toBe("abc");
    expect(result[0]?.sourceCitationUrl).toBe("https://developers.google.com/search/docs");
    store.close();
  });

  it("skips a non-approved row without throwing", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "open-1", JSON.stringify(makeApprovedRow({ id: "open-1", status: "open" })));

    expect(() => readApprovedSeoFindings(store)).not.toThrow();
    expect(readApprovedSeoFindings(store)).toHaveLength(0);
    store.close();
  });

  it("skips a dropped row without throwing", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "dropped-1", JSON.stringify(makeApprovedRow({ id: "dropped-1", status: "dropped" })));

    expect(readApprovedSeoFindings(store)).toHaveLength(0);
    store.close();
  });

  it("skips a non-seo-domain row (even if approved)", () => {
    const store = new FactStore(":memory:");
    seedFact(
      store,
      "other-domain",
      JSON.stringify(makeApprovedRow({ id: "other-domain", domain: "medical" })),
    );

    expect(readApprovedSeoFindings(store)).toHaveLength(0);
    store.close();
  });

  it("skips a row with malformed JSON without throwing", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "good", JSON.stringify(makeApprovedRow({ id: "good" })));
    seedFact(store, "bad", "{not valid json");

    expect(() => readApprovedSeoFindings(store)).not.toThrow();
    const result = readApprovedSeoFindings(store);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceFindingId).toBe("good");
    store.close();
  });

  it("skips a schema-invalid row (urgency out of range) without throwing", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "good", JSON.stringify(makeApprovedRow({ id: "good" })));
    seedFact(store, "invalid", JSON.stringify({ ...makeApprovedRow({ id: "invalid" }), urgency: 6 }));

    const result = readApprovedSeoFindings(store);
    expect(result).toHaveLength(1);
    expect(result[0]?.sourceFindingId).toBe("good");
    store.close();
  });

  it("skips an approved, seo-domain row with no citation (uncited never resurrects)", () => {
    const store = new FactStore(":memory:");
    seedFact(
      store,
      "uncited",
      JSON.stringify(makeApprovedRow({ id: "uncited", evidence: ["no citation here"] })),
    );

    expect(readApprovedSeoFindings(store)).toHaveLength(0);
    store.close();
  });

  it("returns an empty array when no finding rows exist", () => {
    const store = new FactStore(":memory:");
    expect(readApprovedSeoFindings(store)).toEqual([]);
    store.close();
  });

  it("maps multiple approved rows, skipping the non-approved ones", () => {
    const store = new FactStore(":memory:");
    seedFact(store, "a1", JSON.stringify(makeApprovedRow({ id: "a1" })));
    seedFact(store, "a2", JSON.stringify(makeApprovedRow({ id: "a2", status: "open" })));
    seedFact(store, "a3", JSON.stringify(makeApprovedRow({ id: "a3" })));

    const result = readApprovedSeoFindings(store);
    expect(result).toHaveLength(2);
    expect(result.map((f) => f.sourceFindingId).sort()).toEqual(["a1", "a3"]);
    store.close();
  });
});

// ── SeoDraft (sc-11-3) ─────────────────────────────────────────────────

describe("SeoDraft", () => {
  it("carries humanApprovalRequired as the literal true, and a copied sourceCitationUrl", () => {
    const approved = ApprovedFinding.from(makeApprovedRow());
    expect(approved).not.toBeNull();

    const draft: SeoDraft = {
      kind: "title-meta",
      humanApprovalRequired: true,
      sourceCitationUrl: approved!.sourceCitationUrl,
      sourceFindingId: approved!.sourceFindingId,
      target: "https://example.com/page",
      artifact: "<title>Fixed unique title</title>",
      playbookRef: approved!.playbookRef,
    };

    expect(draft.humanApprovalRequired).toBe(true);
    expect(draft.sourceCitationUrl).toBe(approved!.sourceCitationUrl);
    expect(draft.sourceFindingId).toBe(approved!.sourceFindingId);
  });

  it("rejects a forged humanApprovalRequired:false (compile-proof — must be literal true)", () => {
    const base: SeoDraft = {
      kind: "internal-link",
      humanApprovalRequired: true,
      sourceCitationUrl: "https://developers.google.com/search/docs",
      sourceFindingId: "abc",
      target: "https://example.com/page",
      artifact: "Add internal link to /related-page.",
      playbookRef: "seo.tech.title",
    };

    // @ts-expect-error — humanApprovalRequired is the literal type `true`, a `boolean` is forgeable and rejected (ADR-4)
    const forged: SeoDraft = { ...base, humanApprovalRequired: false };

    expect(forged).toBeDefined();
  });

  it("accepts every SeoDraftKind", () => {
    const kinds: SeoDraft["kind"][] = ["schema-jsonld", "internal-link", "title-meta", "content-refresh"];
    for (const kind of kinds) {
      const draft: SeoDraft = {
        kind,
        humanApprovalRequired: true,
        sourceCitationUrl: "https://developers.google.com/search/docs",
        sourceFindingId: "abc",
        target: "https://example.com/page",
        artifact: "proposal text",
        playbookRef: "seo.tech.title",
      };
      expect(draft.kind).toBe(kind);
    }
  });
});
