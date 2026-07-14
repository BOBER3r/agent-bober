/**
 * RedFlagDetector — pure, synchronous, 0-LLM emergency detection (Phase 6, Sprint 3).
 *
 * ADR-2: Detection is deterministic and local. A conservative keyword/phrase match
 * favors escalation reliability over paraphrase coverage. Novel phrasing may return
 * 'none' and proceed to the normal (still-guardrailed) path — this is the accepted risk
 * documented in ADR-2. Pattern set is versioned for auditability.
 *
 * NO async. NO fs. NO network. NO LLM import. Identical input => identical output.
 */

// ── Type exports ────────────────────────────────────────────────────

/** Six mutually-exclusive categories; 'none' means no emergency pattern matched. */
export type RedFlagCategory =
  | "cardiac"
  | "stroke"
  | "anaphylaxis"
  | "self-harm"
  | "overdose"
  | "none";

/** Result of a single RedFlagDetector.detect() call. */
export interface RedFlagMatch {
  category: RedFlagCategory;
  /**
   * Rule ID that fired (IDs only — never prompt text).
   * Undefined when category === 'none'.
   */
  ruleId?: string;
}

// ── Version constant ─────────────────────────────────────────────────

/** Versioned pattern-set identifier recorded in the audit log (ADR-2). */
export const PATTERNSET_VERSION = "redflag-2026.06.16";

// ── Rule definitions ─────────────────────────────────────────────────

interface CategoryRule {
  ruleId: string;
  category: RedFlagCategory;
  /** Pure predicate over the lowercased, trimmed prompt. */
  test: (norm: string) => boolean;
}

/**
 * Conservative rule list. Order matters:
 * self-harm and overdose are checked so the correct hotline (988) wins over
 * any incidental cardiac/anaphylaxis phrase in the same message.
 *
 * bober: phrase-include matching for now; upgrade to word-boundary regex or
 *        an embedded trie if the pattern count grows to > 50 rules.
 */
const RULES: CategoryRule[] = [
  // ── self-harm (988) ──────────────────────────────────────────────
  {
    ruleId: "self-harm-suicidal",
    category: "self-harm",
    test: (n) => n.includes("suicidal") || n.includes("suicid"),
  },
  {
    ruleId: "self-harm-kill-self",
    category: "self-harm",
    test: (n) =>
      n.includes("kill myself") ||
      n.includes("end my life") ||
      n.includes("take my life") ||
      n.includes("want to die"),
  },
  {
    ruleId: "self-harm-self-harm",
    category: "self-harm",
    test: (n) => n.includes("hurt myself") || n.includes("harm myself"),
  },

  // ── overdose (988) ───────────────────────────────────────────────
  {
    ruleId: "overdose-explicit",
    category: "overdose",
    test: (n) => n.includes("overdose") || n.includes("over dose"),
  },
  {
    ruleId: "overdose-too-many",
    category: "overdose",
    test: (n) => n.includes("took too many") || n.includes("taken too many"),
  },

  // ── cardiac (911) ────────────────────────────────────────────────
  {
    ruleId: "cardiac-chest-pain-radiating",
    category: "cardiac",
    test: (n) =>
      n.includes("chest pain") && (n.includes("radiating") || n.includes("left arm")),
  },
  {
    ruleId: "cardiac-chest-pain-breath",
    category: "cardiac",
    test: (n) =>
      n.includes("chest pain") && (n.includes("short of breath") || n.includes("shortness of breath")),
  },
  {
    ruleId: "cardiac-chest-crushing",
    category: "cardiac",
    test: (n) =>
      (n.includes("crushing chest") || n.includes("chest pressure") || n.includes("chest tightness")) &&
      (n.includes("arm") || n.includes("jaw") || n.includes("breath")),
  },
  {
    ruleId: "cardiac-heart-attack",
    category: "cardiac",
    test: (n) => n.includes("heart attack"),
  },

  // ── stroke (911) — FAST: Face, Arms, Speech, Time ───────────────
  {
    ruleId: "stroke-face-droop",
    category: "stroke",
    test: (n) =>
      n.includes("face droop") ||
      n.includes("facial droop") ||
      n.includes("drooping face"),
  },
  {
    ruleId: "stroke-slurred-speech",
    category: "stroke",
    test: (n) =>
      n.includes("slurred speech") ||
      n.includes("slurring words") ||
      n.includes("can't speak") ||
      n.includes("cannot speak"),
  },
  {
    ruleId: "stroke-arm-weakness",
    category: "stroke",
    test: (n) =>
      (n.includes("arm weakness") || n.includes("arm numb")) &&
      (n.includes("sudden") || n.includes("both arms")),
  },
  {
    ruleId: "stroke-sudden-numbness",
    category: "stroke",
    test: (n) =>
      n.includes("sudden numbness") || n.includes("sudden weakness"),
  },
  {
    ruleId: "stroke-sudden-severe-headache",
    category: "stroke",
    test: (n) =>
      n.includes("worst headache") ||
      (n.includes("sudden") && n.includes("severe headache")),
  },

  // ── anaphylaxis (911) ────────────────────────────────────────────
  {
    ruleId: "anaphylaxis-throat-closing",
    category: "anaphylaxis",
    test: (n) =>
      n.includes("throat closing") ||
      n.includes("throat is closing") ||
      n.includes("throat swelling"),
  },
  {
    ruleId: "anaphylaxis-trouble-breathing-allergic",
    category: "anaphylaxis",
    test: (n) =>
      n.includes("trouble breathing") &&
      (n.includes("allergic") || n.includes("allergy") || n.includes("sting") || n.includes("peanut")),
  },
  {
    ruleId: "anaphylaxis-cant-breathe-allergic",
    category: "anaphylaxis",
    test: (n) =>
      (n.includes("can't breathe") || n.includes("cannot breathe")) &&
      (n.includes("allergic") || n.includes("allergy") || n.includes("sting") || n.includes("peanut")),
  },
  {
    ruleId: "anaphylaxis-anaphylaxis",
    category: "anaphylaxis",
    test: (n) => n.includes("anaphylaxis") || n.includes("anaphylactic"),
  },
];

// ── RedFlagDetector ──────────────────────────────────────────────────

/**
 * Detects emergency red-flag phrases in a medical prompt.
 *
 * PURE + SYNCHRONOUS. No async, no fs, no network, no LLM import.
 * Identical input => identical RedFlagMatch (asserted by sc-3-5).
 *
 * bober: conservative phrase matching; novel or indirect phrasing may return
 *        'none' and fall through to normal SOP handling (ADR-2 accepted risk).
 */
export class RedFlagDetector {
  readonly patternsetVersion = PATTERNSET_VERSION;

  /**
   * Returns the first matching RedFlagMatch, or { category: 'none' } if no
   * rule fires. Evaluation order is self-harm → overdose → cardiac → stroke →
   * anaphylaxis so the correct emergency hotline (988 vs 911) is assigned.
   */
  detect(prompt: string): RedFlagMatch {
    const norm = prompt.toLowerCase().trim();
    for (const rule of RULES) {
      if (rule.test(norm)) {
        return { category: rule.category, ruleId: rule.ruleId };
      }
    }
    return { category: "none" };
  }
}
