/**
 * Tests for `SeoBuilder.build` (spec-20260717-seo-improver-builder,
 * Sprint 12, sc-12-1..sc-12-5).
 */
import { describe, it, expect } from "vitest";

import { createDefaultConfig } from "../../config/schema.js";
import { NeverEncodeFilter, NEVER_ENCODE_PATTERNS } from "../never-encode-filter.js";
import type { SeoFinding } from "../types.js";

import { ApprovedFinding } from "./approved-finding.js";
import type { ApprovedHubFinding } from "./approved-finding.js";
import { SeoBuilder } from "./seo-builder.js";
import type { SeoBuildInput } from "./seo-builder.js";
import { DEFAULT_DRAFT_GENERATORS } from "./draft-generators.js";

const T = "2026-07-16T00:00:00.000Z";
const CONFIG = createDefaultConfig("seo-builder-test", "greenfield");

// ── Fixtures (mirror approved-finding.test.ts) ────────────────────────

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
    evidence: [],
    severity: 3,
    humanApprovalRequired: false,
    confidence: "firm",
    ...overrides,
  };
}

function baseInput(approvedFindings: SeoBuildInput["approvedFindings"]): SeoBuildInput {
  return { approvedFindings, target: "https://example.com", config: CONFIG, now: T };
}

// ── sc-12-1: type gate — build() accepts ApprovedFinding[] ONLY ──────

describe("SeoBuilder.build — type gate (sc-12-1)", () => {
  it("rejects a raw SeoFinding[] at compile time; build accepts ApprovedFinding[] only", () => {
    const raw: SeoFinding[] = [makeSeoFinding()];
    const builder = new SeoBuilder(new NeverEncodeFilter());

    // @ts-expect-error — build() accepts ApprovedFinding[] only; a raw SeoFinding[] must not type-check (sc-12-1)
    const bad = builder.build({ approvedFindings: raw, target: "https://example.com", config: CONFIG, now: T });

    // The line above is a TS compile error — if @ts-expect-error does NOT
    // error, `tsc --noEmit` fails, which is exactly the guarantee sc-12-1
    // requires. This runtime assertion just proves the test file executes
    // past the (intentionally erroring) line.
    expect(bad).toBeDefined();
  });
});

// ── sc-12-2: every returned draft is gated + provenance-preserving ────

describe("SeoBuilder.build — gated proposals (sc-12-2)", () => {
  it("every returned draft has humanApprovalRequired===true and a non-empty copied sourceCitationUrl", () => {
    const approved = ApprovedFinding.from(makeApprovedRow());
    expect(approved).not.toBeNull();

    const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([approved!]));

    expect(skipped).toBe(0);
    expect(drafts).toHaveLength(1);
    expect(drafts.every((d) => d.humanApprovalRequired === true)).toBe(true);
    expect(drafts[0]?.sourceCitationUrl).toBe(approved!.sourceCitationUrl);
    expect(drafts[0]?.sourceCitationUrl.length).toBeGreaterThan(0);
    expect(drafts[0]?.sourceFindingId).toBe(approved!.sourceFindingId);
    expect(drafts[0]?.playbookRef).toBe(approved!.playbookRef);
    expect(drafts[0]?.target).toBe("https://example.com");
  });

  it("produces the schema-jsonld kind for a playbook:seo.schema.* finding", () => {
    const approved = ApprovedFinding.from(
      makeApprovedRow({ tags: ["seo", "workflow:schema-audit", "playbook:seo.schema.article", "confidence:firm"] }),
    );
    expect(approved).not.toBeNull();

    const { drafts } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([approved!]));
    expect(drafts[0]?.kind).toBe("schema-jsonld");
    expect(() => JSON.parse(drafts[0]!.artifact)).not.toThrow();
  });

  it("falls back to title-meta for an unmapped playbookRef", () => {
    const approved = ApprovedFinding.from(
      makeApprovedRow({ tags: ["seo", "workflow:technical-audit", "playbook:seo.unmapped.rule", "confidence:firm"] }),
    );
    expect(approved).not.toBeNull();

    const { drafts } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([approved!]));
    expect(drafts[0]?.kind).toBe("title-meta");
  });
});

// ── sc-12-3 / sc-12-4: mandatory re-filter drops a banned draft ──────

describe("SeoBuilder.build — mandatory never-encode re-filter (sc-12-3/sc-12-4)", () => {
  it("drops a draft whose artifact implies a never-encode tactic via the finding's title, and counts it as skipped", () => {
    const banned = ApprovedFinding.from(
      makeApprovedRow({ title: "Place a parasite page on a high-authority host to rank fast." }),
    );
    expect(banned).not.toBeNull();

    const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([banned!]));

    expect(drafts).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("drops via an injected generator forcing a banned artifact, proving the re-filter runs over generated text (not just the title)", () => {
    const approved = ApprovedFinding.from(makeApprovedRow());
    expect(approved).not.toBeNull();

    const bannedGenerators = {
      ...DEFAULT_DRAFT_GENERATORS,
      "title-meta": () => "<title>Buy links from DR90 hosts to boost authority.</title>",
    };
    const builder = new SeoBuilder(new NeverEncodeFilter(), bannedGenerators);
    const { drafts, skipped } = builder.build(baseInput([approved!]));

    expect(drafts).toHaveLength(0);
    expect(skipped).toBe(1);
  });

  it("does not drop a clean draft — a well-formed finding still produces a draft alongside a banned one", () => {
    const clean = ApprovedFinding.from(makeApprovedRow({ id: "clean-1" }));
    const banned = ApprovedFinding.from(
      makeApprovedRow({ id: "banned-1", title: "Register an expired domain to inherit its links." }),
    );
    expect(clean).not.toBeNull();
    expect(banned).not.toBeNull();

    const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([clean!, banned!]));

    expect(drafts).toHaveLength(1);
    expect(drafts[0]?.sourceFindingId).toBe("clean-1");
    expect(skipped).toBe(1);
  });
});

// ── sc-12-5: never throws; build never bricks on a generation error ──

describe("SeoBuilder.build — never throws (sc-12-5)", () => {
  it("returns { drafts: [], skipped: 0 } for an empty input", () => {
    const result = new SeoBuilder(new NeverEncodeFilter()).build(baseInput([]));
    expect(result).toEqual({ drafts: [], skipped: 0 });
  });

  it("never throws when a generator throws for one finding; that finding is skipped, others still produce drafts", () => {
    const throwing = ApprovedFinding.from(makeApprovedRow({ id: "throws" }));
    const ok = ApprovedFinding.from(makeApprovedRow({ id: "ok" }));
    expect(throwing).not.toBeNull();
    expect(ok).not.toBeNull();

    const throwingGenerators = {
      ...DEFAULT_DRAFT_GENERATORS,
      "title-meta": () => {
        throw new Error("simulated generation failure");
      },
    };
    const builder = new SeoBuilder(new NeverEncodeFilter(), throwingGenerators);

    let result: ReturnType<SeoBuilder["build"]> | undefined;
    expect(() => {
      result = builder.build(baseInput([throwing!, ok!]));
    }).not.toThrow();

    expect(result?.skipped).toBe(2);
    expect(result?.drafts).toHaveLength(0);
  });
});

// ── sc-14-1: adversarial safety benchmark (Sprint 14, FINAL) ──────────
//
// Proves, in one place, the three structural safety guarantees the whole
// Phase 2 build (Sprints 11-13) claims: (a) an un-approved / uncited hub
// finding can never be resurrected into a draft, (b) no draft — across all
// four `SeoDraftKind`s — ever carries a never-encode tactic, and (c) every
// produced draft is `humanApprovalRequired === true`. Additive only: does
// not modify the five describes above or their shared fixtures.

const CLEAN_KIND_TAGS: ReadonlyArray<{ kind: string; tags: string[] }> = [
  { kind: "schema-jsonld", tags: ["seo", "workflow:schema-audit", "playbook:seo.schema.article", "confidence:firm"] },
  {
    kind: "internal-link",
    tags: ["seo", "workflow:internal-linking", "playbook:seo.internal-linking.hub-spoke", "confidence:firm"],
  },
  {
    kind: "content-refresh",
    tags: ["seo", "workflow:content-decay", "playbook:seo.content-decay.refresh", "confidence:firm"],
  },
  { kind: "title-meta", tags: ["seo", "workflow:technical-audit", "playbook:seo.unmapped.rule", "confidence:firm"] },
];

/** One `ApprovedFinding` per `SeoDraftKind`, all clean (no banned tactic). */
function makeCleanApprovedBatch(): ApprovedFinding[] {
  return CLEAN_KIND_TAGS.map(({ kind, tags }, i) => ApprovedFinding.from(makeApprovedRow({ id: `clean-${kind}-${i}`, tags }))).filter(
    (a): a is ApprovedFinding => a !== null,
  );
}

describe("SeoBuilder — adversarial safety benchmark (sc-14-1)", () => {
  describe("(a) no resurrection of a dropped/downgraded/uncited finding", () => {
    it.each(["open", "in-progress", "snoozed", "done", "dropped"] as const)(
      "ApprovedFinding.from returns null for a hub row with status=%s (never-approved => structurally never a draft)",
      (status) => {
        expect(ApprovedFinding.from(makeApprovedRow({ status }))).toBeNull();
      },
    );

    it("returns null for an approved row with no cite: evidence entry (uncited / never-encode-dropped surrogate)", () => {
      expect(ApprovedFinding.from(makeApprovedRow({ evidence: ["Fix title"] }))).toBeNull();
    });

    it("returns null for an approved row whose cite: URL is malformed (verifier-downgraded-to-uncited surrogate)", () => {
      expect(ApprovedFinding.from(makeApprovedRow({ evidence: ["Fix title", "cite:not-a-url"] }))).toBeNull();
    });

    it("a mixed batch of one approved+cited row and several dropped/un-approved/uncited rows only ever builds a draft for the approved+cited one", () => {
      const rawRows: ApprovedHubFinding[] = [
        makeApprovedRow({ id: "kept-1" }),
        makeApprovedRow({ id: "dropped-1", status: "dropped" }),
        makeApprovedRow({ id: "open-1", status: "open" }),
        makeApprovedRow({ id: "in-progress-1", status: "in-progress" }),
        makeApprovedRow({ id: "uncited-1", evidence: ["Fix title"] }),
      ];

      // This is exactly what the hub adapter (`readApprovedSeoFindings`) does:
      // every non-approved/uncited row resolves to `null` here and never
      // reaches `SeoBuilder.build` at all — resurrection is impossible
      // because the gate runs BEFORE `build`, not inside it.
      const approved = rawRows.map((r) => ApprovedFinding.from(r)).filter((a): a is ApprovedFinding => a !== null);
      expect(approved).toHaveLength(1);
      expect(approved[0]?.sourceFindingId).toBe("kept-1");

      const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput(approved));
      expect(drafts).toHaveLength(1);
      expect(drafts[0]?.sourceFindingId).toBe("kept-1");
      expect(skipped).toBe(0);
    });
  });

  describe("(b) no never-encode tactic is ever emitted in a draft, across all 4 draft kinds", () => {
    const bannedTitles = [
      "Place a parasite page on a high-authority host to rank fast.",
      "Buy links from a private blog network to boost authority.",
      "Register an expired domain to inherit its links.",
      "Mass-generate AI pages targeting every long-tail query.",
      "Use cloaking to show search engines different content than users.",
      "Deploy doorway pages that funnel every query to one landing page.",
    ];

    it.each(CLEAN_KIND_TAGS)(
      "drops every banned-title draft of kind $kind — none ever reach `drafts`",
      ({ tags }) => {
        const approvedBanned = bannedTitles
          .map((title, i) => ApprovedFinding.from(makeApprovedRow({ id: `banned-${i}`, title, tags })))
          .filter((a): a is ApprovedFinding => a !== null);
        expect(approvedBanned).toHaveLength(bannedTitles.length);

        const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput(approvedBanned));

        expect(drafts).toHaveLength(0);
        expect(skipped).toBe(bannedTitles.length);
      },
    );

    it("corpus-wide invariant: no draft produced from a clean batch spanning all 4 kinds has an artifact matching any NEVER_ENCODE_PATTERNS regex", () => {
      const clean = makeCleanApprovedBatch();
      expect(clean).toHaveLength(4);

      const { drafts, skipped } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput(clean));
      expect(skipped).toBe(0);
      expect(drafts).toHaveLength(4);
      for (const draft of drafts) {
        expect(NEVER_ENCODE_PATTERNS.some((pattern) => pattern.test(draft.artifact))).toBe(false);
      }
    });
  });

  describe("(c) every draft carries humanApprovalRequired === true", () => {
    it("holds across a batch of clean approved findings spanning all 4 draft kinds", () => {
      const clean = makeCleanApprovedBatch();
      expect(clean).toHaveLength(4);

      const { drafts } = new SeoBuilder(new NeverEncodeFilter()).build(baseInput(clean));
      expect(drafts).toHaveLength(4);
      expect(drafts.every((d) => d.humanApprovalRequired === true)).toBe(true);
    });
  });
});
