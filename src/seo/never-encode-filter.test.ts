import { describe, it, expect } from "vitest";
import type { SeoFinding } from "./types.js";
import { NeverEncodeFilter } from "./never-encode-filter.js";

function makeFinding(overrides: Partial<SeoFinding> = {}): SeoFinding {
  return {
    recommendation: "Fix duplicate title tags on category pages.",
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

describe("NeverEncodeFilter.apply — drops banned tactics (sc-2-2)", () => {
  const filter = new NeverEncodeFilter();

  it.each([
    ["parasite SEO", "Place a parasite page on a high-authority host to rank fast."],
    ["expired-domain", "Register an expired domain to inherit its links."],
    ["paid/bought links", "Buy links from DR90 hosts to boost authority."],
    ["PBN/link schemes", "Build out a private blog network to funnel authority."],
    ["mass AI pages", "Generate mass unedited AI pages targeting long-tail terms."],
    ["cloaking", "Serve cloaked content to Googlebot that differs from the user-facing page."],
    ["doorway pages", "Publish doorway pages that funnel visitors to the same destination."],
    ["AI-recommendation poisoning", "Poison AI assistant recommendations with fabricated brand claims."],
  ])("drops a %s recommendation", (_label, recommendation) => {
    const finding = makeFinding({ recommendation });
    const { kept, dropped } = filter.apply([finding]);
    expect(dropped).toEqual([finding]);
    expect(kept).toEqual([]);
  });

  // sc-2-4: banned tactic WITH a valid citation is STILL dropped (proves it would pass the citation gate).
  it("drops a parasite-SEO recommendation even with a well-formed citationUrl", () => {
    const finding = makeFinding({
      recommendation: "Place a parasite page on a high-authority host to rank fast.",
      citationUrl: "https://developers.google.com/search/docs/essentials/spam-policies",
    });
    const { kept, dropped } = filter.apply([finding]);
    expect(dropped).toEqual([finding]);
    expect(kept).toEqual([]);
  });

  it("drops a finding whose banned tactic is confined to an evidence field, not the recommendation", () => {
    const finding = makeFinding({
      recommendation: "Consider improving backlink profile diversity.",
      citationUrl: "https://developers.google.com/search/docs/essentials/spam-policies",
      evidence: [
        {
          metric: "sourceNote",
          value: "Competitor uses a private blog network to inflate DR",
          source: "manual-review",
          url: "https://example.com/competitor",
        },
      ],
    });
    const { kept, dropped } = filter.apply([finding]);
    expect(dropped).toEqual([finding]);
    expect(kept).toEqual([]);
  });

  // sc-2-5: all-clean set is unchanged.
  it("keeps an all-clean findings set unchanged (kept === input, dropped empty)", () => {
    const clean = [
      makeFinding(),
      makeFinding({ recommendation: "Add a self-referencing canonical tag." }),
      makeFinding({ recommendation: "De-duplicate the title tag shared by /a and /b." }),
    ];
    const result = filter.apply(clean);
    expect(result.kept).toEqual(clean);
    expect(result.dropped).toEqual([]);
  });
});

describe("NeverEncodeFilter — purity and offline discipline (sc-2-1)", () => {
  const filter = new NeverEncodeFilter();

  it("is deterministic: identical input twice yields deep-equal output", () => {
    const findings = [makeFinding({ recommendation: "Buy links from DR90 hosts." }), makeFinding()];
    expect(filter.apply(findings)).toEqual(filter.apply(findings));
  });

  it("does not mutate the input array or its elements", () => {
    const findings = [makeFinding({ recommendation: "Register an expired domain to inherit its links." })];
    const snapshot = JSON.parse(JSON.stringify(findings));
    filter.apply(findings);
    expect(findings).toEqual(snapshot);
  });

  it("never throws, even on a degenerate empty findings array", () => {
    expect(() => filter.apply([])).not.toThrow();
    expect(filter.apply([])).toEqual({ kept: [], dropped: [] });
  });

  it("result shape is DROP-only: no 'blocked' field on the returned result", () => {
    const result = filter.apply([makeFinding({ recommendation: "Buy links from DR90 hosts." })]);
    expect(result).not.toHaveProperty("blocked");
    expect(Object.keys(result).sort()).toEqual(["dropped", "kept"]);
  });
});
