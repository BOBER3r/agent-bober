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

async function loadSkillWithDiagnostics(relPath: string) {
  const md = await readFile(new URL(`../../${relPath}`, import.meta.url), "utf-8");
  return SeoPlaybookParser.parseWithDiagnostics(md, relPath);
}

// sc-5-2: adversarial tactics (parasite placement, expired-domain plays, paid
// links, mass unedited AI pages, AI-recommendation poisoning) must survive
// ONLY as detection/awareness guidance -- never as an imperative to perform
// the violation under an auto-safe/human-approve label.
const FORBIDDEN_ACTION_PATTERNS = [
  /\bplace\b[^.]*\b(parasite|high-?authority host|third-?party host)/i,
  /\b(?:buy(?:ing)?|purchas(?:e|ing))\b[^.]*\blinks?\b/i,
  /\bregister(ing)?\b[^.]*\bexpired domain/i,
  /\bgenerate\b[^.]*\bmass\b[^.]*\bpages\b/i,
  /\b(?:mass[-\s]?generat(?:e|ing)|generat(?:e|ing)[-\s]?mass)\b/i,
  /\bpoison/i,
];

function assertNoForbiddenActions(signatures: ReturnType<typeof SeoPlaybookParser.parse>) {
  for (const s of signatures) {
    for (const p of FORBIDDEN_ACTION_PATTERNS) {
      expect(s.tactic).not.toMatch(p);
    }
    // no surviving policy-violation block masquerading as auto-safe/human-approve
    // (structurally impossible per the parser's type, asserted explicitly here)
    expect(s.policyClass).not.toBe("never-encode");
  }
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

// ── sc-3-4 (spec-20260717-seo-improver-builder): skills-lint over
// `liveWeightStatus` -- a high-severity playbook (policyClass:
// "human-approve", the only high-stakes signal ON a SeoSignature; ADR-2)
// that OMITS **LiveWeightStatus:** resolves to "unknown" and must be
// flagged. Uses SYNTHETIC parsed signatures, NOT real skill files -- Sprint
// 4 is responsible for authoring `LiveWeightStatus` into the real
// bober.seo-* skill files (nonGoal of this sprint). ────────────────────

/**
 * "High-severity" is undefined directly on `SeoSignature` (severity is
 * model-emitted, on `SeoFinding`). `policyClass === "human-approve"` is the
 * only high-stakes signal a signature carries, so it is the lint's proxy
 * for "high-severity playbook" (per the sprint briefing/ADR-2 risk note).
 */
function findHighSeverityOmissions(signatures: ReturnType<typeof SeoPlaybookParser.parse>) {
  return signatures.filter((s) => s.policyClass === "human-approve" && s.liveWeightStatus === "unknown");
}

describe("SeoPlaybookParser — skills-lint: LiveWeightStatus omission on high-severity playbooks (sc-3-4)", () => {
  it("flags a human-approve signature that omits LiveWeightStatus (resolves to unknown)", () => {
    const md = [
      "### risky-live-site-rewrite",
      "- **Title:** Large-scale rewrite",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** human-approve",
      // No LiveWeightStatus label -- soft-field default applies.
    ].join("\n");

    const signatures = SeoPlaybookParser.parse(md, "synthetic-fixture.md");
    const omissions = findHighSeverityOmissions(signatures);

    expect(signatures).toHaveLength(1);
    expect(signatures[0].liveWeightStatus).toBe("unknown");
    expect(omissions).toHaveLength(1);
    expect(omissions[0].playbookId).toBe("risky-live-site-rewrite");
  });

  it("does NOT flag a human-approve signature that declares LiveWeightStatus", () => {
    const md = [
      "### risky-live-site-rewrite-declared",
      "- **Title:** Large-scale rewrite",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** human-approve",
      "- **LiveWeightStatus:** documented-only",
    ].join("\n");

    const signatures = SeoPlaybookParser.parse(md, "synthetic-fixture.md");
    const omissions = findHighSeverityOmissions(signatures);

    expect(signatures[0].liveWeightStatus).toBe("documented-only");
    expect(omissions).toHaveLength(0);
  });

  it("does NOT flag an auto-safe signature that omits LiveWeightStatus (not high-severity)", () => {
    const md = [
      "### low-severity-tactic",
      "- **Title:** Low-risk tactic",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** auto-safe",
      // No LiveWeightStatus label -- defaults to unknown, but not high-severity.
    ].join("\n");

    const signatures = SeoPlaybookParser.parse(md, "synthetic-fixture.md");
    const omissions = findHighSeverityOmissions(signatures);

    expect(signatures[0].policyClass).toBe("auto-safe");
    expect(signatures[0].liveWeightStatus).toBe("unknown");
    expect(omissions).toHaveLength(0);
  });

  it("flags each omitting human-approve signature independently across a mixed batch", () => {
    const md = [
      "### mixed-flagged-1",
      "- **Title:** A",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** human-approve",
      "",
      "### mixed-declared",
      "- **Title:** B",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** human-approve",
      "- **LiveWeightStatus:** live-corroborated",
      "",
      "### mixed-flagged-2",
      "- **Title:** C",
      "- **PrimarySourceUrl:** https://x",
      "- **PolicyClass:** human-approve",
    ].join("\n");

    const signatures = SeoPlaybookParser.parse(md, "synthetic-fixture.md");
    const omissions = findHighSeverityOmissions(signatures);

    expect(signatures).toHaveLength(3);
    expect(omissions.map((s) => s.playbookId).sort()).toEqual(["mixed-flagged-1", "mixed-flagged-2"]);
  });
});

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

// ── Sprint 5 (spec-20260715-ultimate-seo-suite) -- sc-5-1 (>=6 valid blocks
// each), sc-5-2 (adversarial tactics survive ONLY as never-encode/detection,
// never as an auto-safe/human-approve DO-instruction), sc-5-3 (ai-visibility
// VERIFIED GEO correlations cited; verticals cover iGaming/crypto/SaaS) ──

describe("SeoPlaybookParser — real bober.seo-ai-visibility skill file", () => {
  it("parses skills/bober.seo-ai-visibility/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-ai-visibility/SKILL.md";
    const { signatures, dropped } = await loadSkillWithDiagnostics(relPath);
    assertBaseline(signatures, relPath);

    for (const s of signatures) {
      expect(s.workflows).toContain("ai-visibility");
    }

    // sc-5-2: the AI-recommendation-poisoning block was DROPPED (never-encode).
    expect(dropped).toBeGreaterThan(0);
    assertNoForbiddenActions(signatures);

    // sc-5-3: the VERIFIED GEO correlations are present and cited to the
    // matching source from the curator's verified citation map.
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("ai-visibility-youtube-presence-audit");
    expect(ids).toContain("ai-visibility-branded-mention-audit");
    expect(ids).toContain("ai-visibility-ghost-citation-mention-split");
    expect(ids).toContain("ai-visibility-per-platform-geo-divergence");

    const youtube = signatures.find((s) => s.playbookId === "ai-visibility-youtube-presence-audit");
    expect(youtube?.primarySourceUrl).toBe("https://ahrefs.com/blog/ai-brand-visibility-correlations/");
    expect(youtube?.invariant).toMatch(/0\.737/);

    const branded = signatures.find((s) => s.playbookId === "ai-visibility-branded-mention-audit");
    expect(branded?.primarySourceUrl).toBe("https://ahrefs.com/blog/ai-brand-visibility-correlations/");
    expect(branded?.invariant).toMatch(/0\.66-0\.71/);
    expect(branded?.invariant).toMatch(/0\.218/);

    const ghost = signatures.find((s) => s.playbookId === "ai-visibility-ghost-citation-mention-split");
    expect(ghost?.primarySourceUrl).toBe("https://www.semrush.com/blog/the-ghost-citations-study/");
    expect(ghost?.invariant).toMatch(/61\.7%/);

    // sc-5-3: per-platform divergence guidance is explicitly marked perishable.
    const divergence = signatures.find((s) => s.playbookId === "ai-visibility-per-platform-geo-divergence");
    expect(divergence?.title + divergence?.tactic + divergence?.invariant).toMatch(/perishable/i);
  });
});

describe("SeoPlaybookParser — real bober.seo-parasite-watch skill file", () => {
  it("parses skills/bober.seo-parasite-watch/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-parasite-watch/SKILL.md";
    const { signatures, dropped } = await loadSkillWithDiagnostics(relPath);
    assertBaseline(signatures, relPath);

    for (const s of signatures) {
      expect(s.workflows).toContain("parasite-watch");
    }

    // sc-5-2: never-encode blocks (parasite placement / expired-domain / paid
    // links) were DROPPED -- they never reach a prompt.
    expect(dropped).toBeGreaterThan(0);

    // sc-5-2: NO surviving block RECOMMENDS a policy-violating action.
    // Adversarial tactics survive ONLY as detection (auto-safe, "detect/
    // monitor a competitor") -- never as an imperative to perform the tactic.
    assertNoForbiddenActions(signatures);

    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("parasite-competitor-detection-highdr-hosts");
    expect(ids).toContain("site-reputation-abuse-policy-awareness");
  });
});

describe("SeoPlaybookParser — real bober.seo-verticals skill file", () => {
  it("parses skills/bober.seo-verticals/SKILL.md into >=6 valid, cited signatures", async () => {
    const relPath = "skills/bober.seo-verticals/SKILL.md";
    const { signatures, dropped } = await loadSkillWithDiagnostics(relPath);
    assertBaseline(signatures, relPath);

    // sc-5-2: the mass-unedited-AI-page tactic was DROPPED (never-encode).
    expect(dropped).toBeGreaterThan(0);
    assertNoForbiddenActions(signatures);

    // sc-5-3: iGaming, crypto/DeFi, and SaaS are all represented.
    const ids = signatures.map((s) => s.playbookId);
    expect(ids).toContain("igaming-scamness-demotion-awareness");
    expect(ids).toContain("igaming-parasite-detection");
    expect(ids).toContain("igaming-regulatory-disclosure");
    expect(ids).toContain("defi-authority-gap-beatable");
    expect(ids).toContain("crypto-ymyl-editorial-override");
    expect(ids).toContain("saas-pseo-per-page-utility");

    // sc-5-3: the DeFi Atlendis 538% authority-gap case is cited correctly.
    const defi = signatures.find((s) => s.playbookId === "defi-authority-gap-beatable");
    expect(defi?.primarySourceUrl).toBe("https://victoriaolsina.com/case-studies/defi-seo/");
    expect(defi?.invariant).toMatch(/538%/);
    expect(defi?.policyClass).toBe("human-approve");

    // sc-5-3: regulatory disclosure is human-approve, never auto-published.
    const disclosure = signatures.find((s) => s.playbookId === "igaming-regulatory-disclosure");
    expect(disclosure?.policyClass).toBe("human-approve");
  });
});
