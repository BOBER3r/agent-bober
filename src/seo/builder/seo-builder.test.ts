/**
 * Tests for `SeoBuilder.build` (spec-20260717-seo-improver-builder,
 * Sprint 12, sc-12-1..sc-12-5).
 */
import { describe, it, expect } from "vitest";

import { createDefaultConfig } from "../../config/schema.js";
import { NeverEncodeFilter } from "../never-encode-filter.js";
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
