/** DisclaimerComposer — versioned per-response wellness footer (Phase 6, Sprint 2). */

// ── DisclaimerComposer ──────────────────────────────────────────────

const DISCLAIMER_VERSION = "1.0.0";

/**
 * General-wellness disclaimer text. Non-diagnostic, non-treatment.
 * Consistent with FFDCA §201(h) / GW-safe-harbor posture.
 */
const FOOTER_TEXT =
  "General wellness information only — not medical advice, diagnosis, or treatment. " +
  "Consult a licensed professional. In an emergency call your local emergency number.";

/**
 * Produces a versioned per-response wellness disclaimer footer.
 * Pure — no I/O, no side effects.
 */
export class DisclaimerComposer {
  readonly disclaimerVersion = DISCLAIMER_VERSION;

  /** Returns a non-empty footer string carrying the disclaimerVersion. */
  footer(): string {
    return `${FOOTER_TEXT} [disclaimer v${this.disclaimerVersion}]`;
  }
}
