/**
 * RefusalDetector — pure, synchronous, 0-LLM non-emergency content-policy refusal.
 *
 * Classifies prescription / specific-dosing / individualized-treatment-plan requests.
 * Conservative phrase matching: accept FALSE-NEGATIVES (fall through to 'none'),
 * NEVER false-positive into giving medical advice. Pattern set is versioned for audit.
 *
 * NO async. NO fs. NO network. NO LLM import. Identical input => identical output.
 */

// ── Type exports ─────────────────────────────────────────────────────

/** Four mutually-exclusive categories; 'none' means no refusal pattern matched. */
export type RefusalCategory =
  | "prescription"
  | "specific-dosing"
  | "individualized-treatment-plan"
  | "none";

/** Result of a single RefusalDetector.detect() call. */
export interface RefusalMatch {
  category: RefusalCategory;
  /**
   * Rule ID that fired (IDs only — never prompt text).
   * Undefined when category === 'none'.
   */
  ruleId?: string;
}

// ── Version constant ─────────────────────────────────────────────────

/** Versioned pattern-set identifier recorded in the audit log. */
export const REFUSAL_PATTERNSET_VERSION = "refusal-2026.06.17";

// ── Canned refuse reason strings (NEVER model-generated) ─────────────
// Decline + see-a-licensed-clinician. DISTINCT from 911/988 escalations —
// no "911", "988", or "emergency" so refuse text is byte-distinct from escalation text.

const REFUSE_PRESCRIPTION =
  "I can't provide a prescription or recommend a specific prescription medication. " +
  "Please consult a licensed clinician who can evaluate you and prescribe appropriately.";

const REFUSE_DOSING =
  "I can't provide a specific medication dose or dosing schedule for you. " +
  "Please consult a licensed clinician or pharmacist for personalised dosing guidance.";

const REFUSE_TREATMENT_PLAN =
  "I can't create an individualised treatment or care plan. " +
  "Please consult a licensed clinician who can evaluate your situation and develop a plan for you.";

/**
 * Fixed canned reason strings per refusal category.
 * Exported so callers can assert byte-equality (proving non-model-generation).
 */
export const REFUSAL_REASONS: Record<Exclude<RefusalCategory, "none">, string> = {
  prescription: REFUSE_PRESCRIPTION,
  "specific-dosing": REFUSE_DOSING,
  "individualized-treatment-plan": REFUSE_TREATMENT_PLAN,
};

// ── Rule definitions ─────────────────────────────────────────────────

interface CategoryRule {
  ruleId: string;
  category: Exclude<RefusalCategory, "none">;
  /** Pure predicate over the lowercased, trimmed prompt. */
  test: (norm: string) => boolean;
}

/**
 * Conservative rule list. Order: prescription → specific-dosing → treatment-plan.
 * Accept false-negatives freely; NEVER fire on benign informational prompts.
 *
 * bober: phrase-include matching for now; upgrade to word-boundary regex or
 *        a trie if the pattern count grows to > 50 rules.
 */
const RULES: CategoryRule[] = [
  // ── prescription ────────────────────────────────────────────────────
  {
    ruleId: "rx-request-modal",
    category: "prescription",
    test: (n) => n.includes("can you prescribe") || n.includes("could you prescribe"),
  },
  {
    ruleId: "rx-request-write",
    category: "prescription",
    test: (n) =>
      n.includes("write me a prescription") ||
      n.includes("get me a prescription") ||
      n.includes("prescription for me"),
  },
  {
    ruleId: "rx-request-direct",
    category: "prescription",
    test: (n) =>
      n.includes("prescribe me") ||
      (n.includes("prescribe") && (n.includes(" me ") || n.includes(" me?") || n.includes(" i "))),
  },

  // ── specific-dosing ──────────────────────────────────────────────────
  {
    ruleId: "dose-quantity-mg",
    category: "specific-dosing",
    test: (n) => n.includes("how many mg") || n.includes("how many milligrams"),
  },
  {
    ruleId: "dose-query-what",
    category: "specific-dosing",
    test: (n) => n.includes("what dose") || n.includes("what dosage"),
  },
  {
    ruleId: "dose-query-take-mg",
    category: "specific-dosing",
    test: (n) =>
      /should i take\s+\d/.test(n) ||
      (n.includes("should i take") && (n.includes("mg") || n.includes("milligram"))),
  },
  {
    ruleId: "dose-query-how-much-take",
    category: "specific-dosing",
    test: (n) => n.includes("how much") && n.includes("should i take"),
  },

  // ── individualized-treatment-plan ────────────────────────────────────
  {
    ruleId: "txplan-for-me",
    category: "individualized-treatment-plan",
    test: (n) => n.includes("treatment plan for me") || n.includes("my treatment plan"),
  },
  {
    ruleId: "txplan-what-to-do",
    category: "individualized-treatment-plan",
    test: (n) => n.includes("what should i do to treat my") || n.includes("how do i treat my"),
  },
  {
    ruleId: "txplan-personalized",
    category: "individualized-treatment-plan",
    test: (n) =>
      n.includes("personalized treatment") ||
      n.includes("personalised treatment") ||
      n.includes("personal treatment plan"),
  },
  {
    ruleId: "txplan-care-plan",
    category: "individualized-treatment-plan",
    test: (n) => n.includes("care plan for my") || n.includes("care plan for me"),
  },
];

// ── RefusalDetector ──────────────────────────────────────────────────

/**
 * Detects non-emergency content-policy refusal phrases in a medical prompt.
 *
 * PURE + SYNCHRONOUS. No async, no fs, no network, no LLM import.
 * Identical input => identical RefusalMatch output.
 *
 * bober: conservative phrase matching; novel or indirect phrasing may return
 *        'none' and fall through to normal SOP handling (accepted risk; false-negative
 *        is safer than false-positive into refused advice).
 */
export class RefusalDetector {
  readonly patternsetVersion = REFUSAL_PATTERNSET_VERSION;

  /**
   * Returns the first matching RefusalMatch, or { category: 'none' } if no
   * rule fires. Evaluation order is prescription → specific-dosing → treatment-plan.
   */
  detect(prompt: string): RefusalMatch {
    const norm = prompt.toLowerCase().trim();
    for (const rule of RULES) {
      if (rule.test(norm)) {
        return { category: rule.category, ruleId: rule.ruleId };
      }
    }
    return { category: "none" };
  }
}
