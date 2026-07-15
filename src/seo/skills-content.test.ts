import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SeoPlaybookParser } from "./parser.js";

// ── Real-asset tests: parse the three per-workflow skill files authored in
// Sprint 3 (spec-20260715-ultimate-seo-suite) -- sc-3-1 (>=6 valid blocks
// each), sc-3-2 (every block cited, no REFUTED claim), sc-3-3 (policyClass
// declared + risk tactics human-approve) ────────────────────────────────

const REFUTED_PATTERNS = [/wikipedia/i, /reddit.*(leading|dominat|leads)/i];

async function loadSkill(relPath: string) {
  const md = await readFile(new URL(`../../${relPath}`, import.meta.url), "utf-8");
  return SeoPlaybookParser.parse(md, relPath);
}

function assertBaseline(signatures: ReturnType<typeof SeoPlaybookParser.parse>, skillRelPath: string) {
  expect(signatures.length).toBeGreaterThanOrEqual(6);
  for (const s of signatures) {
    expect(s.playbookId.length).toBeGreaterThan(0);
    expect(s.title.length).toBeGreaterThan(0);
    expect(s.primarySourceUrl.trim()).not.toBe("");
    expect(["auto-safe", "human-approve"]).toContain(s.policyClass);
    expect(["verified", "primary-unverified", "single-source"]).toContain(s.evidenceGrade);
    expect(s.skillRef).toBe(skillRelPath);
    for (const pattern of REFUTED_PATTERNS) {
      expect(s.title + s.tactic + s.invariant).not.toMatch(pattern);
    }
  }
}

describe("SeoPlaybookParser — real bober.seo-technical-audit skill file", () => {
  it("parses skills/bober.seo-technical-audit/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-technical-audit/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);

    // sc-3-4: encodes NavBoost click behavior, contentEffort, and date-consistency, each cited.
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("navboost-click-quality-audit");
    expect(ids).toContain("contenteffort-low-effort-flag");
    expect(ids).toContain("date-consistency-audit");

    for (const s of signatures) {
      expect(s.workflows).toContain("technical-audit");
    }
  });
});

describe("SeoPlaybookParser — real bober.seo-internal-linking skill file", () => {
  it("parses skills/bober.seo-internal-linking/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-internal-linking/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);

    for (const s of signatures) {
      expect(s.workflows).toContain("internal-linking");
    }

    // sc-3-3: the redirect/migration tactic touches risk -- must be human-approve.
    const merge = signatures.find((s) => s.playbookId === "authority-consolidation-merge");
    expect(merge?.policyClass).toBe("human-approve");
  });
});

describe("SeoPlaybookParser — real bober.seo-schema-audit skill file", () => {
  it("parses skills/bober.seo-schema-audit/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-schema-audit/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);

    for (const s of signatures) {
      expect(s.workflows).toContain("schema-audit");
    }

    // sc-3-4: entity-linking -> AIO evidence, cited to the Schema App case study.
    const entityLinking = signatures.find((s) => s.playbookId === "schema-entity-linking-aio");
    expect(entityLinking?.primarySourceUrl).toBe(
      "https://www.schemaapp.com/schema-markup/case-study-entity-linking-increases-aio-visibility/",
    );

    // sc-3-3: mass schema generation touches risk -- must be human-approve.
    const massGen = signatures.find((s) => s.playbookId === "mass-schema-generation-approval");
    expect(massGen?.policyClass).toBe("human-approve");
  });
});

// ── Sprint 4 (spec-20260715-ultimate-seo-suite) -- sc-4-1 (>=6 valid blocks
// each), sc-4-2 (decay mechanism / siteFocusScore-siteRadius / fan-out /
// AIO-decouple present & cited), sc-4-3 (every block cited + policyClass, no
// REFUTED claim) ────────────────────────────────────────────────────────

describe("SeoPlaybookParser — real bober.seo-content-decay skill file", () => {
  it("parses skills/bober.seo-content-decay/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-content-decay/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);

    for (const s of signatures) {
      expect(s.workflows).toContain("content-decay");
    }
    // sc-4-2: the NavBoost decay mechanism + the 64%-decayed baseline are present & cited.
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("navboost-decay-expected-clicks");
    expect(ids).toContain("content-decay-hcu-baseline");

    const decayMechanism = signatures.find((s) => s.playbookId === "navboost-decay-expected-clicks");
    expect(decayMechanism?.primarySourceUrl).toBe("https://ipullrank.com/google-algo-leak");
    const hcuBaseline = signatures.find((s) => s.playbookId === "content-decay-hcu-baseline");
    expect(hcuBaseline?.primarySourceUrl).toBe("https://detailed.com/q3/");

    // sc-4-1 policy: a live-site rewrite/consolidation tactic must be human-approve.
    const consolidate = signatures.find((s) => s.playbookId === "large-scale-rewrite-consolidation-approval");
    expect(consolidate?.policyClass).toBe("human-approve");
  });
});

describe("SeoPlaybookParser — real bober.seo-topical-map skill file", () => {
  it("parses skills/bober.seo-topical-map/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-topical-map/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);
    for (const s of signatures) {
      expect(s.workflows).toContain("topical-map");
    }
    // sc-4-2: siteFocusScore/siteRadius + fan-out coverage present & cited.
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("sitefocusscore-topical-dedication");
    expect(ids).toContain("siteradius-deviation-outlier-map");
    expect(ids).toContain("query-fan-out-coverage-map");

    const fanOut = signatures.find((s) => s.playbookId === "query-fan-out-coverage-map");
    expect(fanOut?.primarySourceUrl).toBe("https://ahrefs.com/blog/ai-overview-citations-top-10/");

    // sc-4-1 policy: publishing the full map at scale must be human-approve.
    const buildout = signatures.find((s) => s.playbookId === "map-buildout-at-scale-approval");
    expect(buildout?.policyClass).toBe("human-approve");
  });
});

describe("SeoPlaybookParser — real bober.seo-rank-track skill file", () => {
  it("parses skills/bober.seo-rank-track/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-rank-track/SKILL.md";
    const signatures = await loadSkill(relPath);
    assertBaseline(signatures, relPath);
    for (const s of signatures) {
      expect(s.workflows).toContain("rank-track");
    }
    // sc-4-2: AIO-citation-vs-rank decoupling cited to the Ahrefs 38% study.
    const decouple = signatures.find((s) => s.playbookId === "aio-citation-rank-decouple");
    expect(decouple?.primarySourceUrl).toBe("https://ahrefs.com/blog/ai-overview-citations-top-10/");

    // zero-click reality check cited to the Semrush study.
    const zeroClick = signatures.find((s) => s.playbookId === "zero-click-reality-check");
    expect(zeroClick?.primarySourceUrl).toBe("https://www.semrush.com/blog/semrush-ai-overviews-study/");

    // rank-track is pure monitoring/analysis -- every block should be auto-safe.
    for (const s of signatures) {
      expect(s.policyClass).toBe("auto-safe");
    }
  });
});
