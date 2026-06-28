import { FindingSchema } from "./finding.js";
import type { Finding } from "./finding.js";
import type { FactStore } from "../state/facts.js";

// ── Constants ────────────────────────────────────────────────────────

/** FactStore scope/namespace the hub stores its own findings under. */
export const HUB_SCOPE = "hub";

// ── FindingSource ────────────────────────────────────────────────────

/** Interface for any source that can supply Finding objects. */
export interface FindingSource {
  read(): Finding[];
}

// ── FactStoreFindingSource ───────────────────────────────────────────

/**
 * Reads predicate-'finding' rows from one FactStore scope,
 * JSON-parses and validates each row value into a Finding.
 *
 * Contract: never throws. Rows with malformed JSON or invalid shape
 * are silently skipped; only schema-valid Findings are returned.
 */
export class FactStoreFindingSource implements FindingSource {
  constructor(
    private readonly store: FactStore,
    private readonly scope: string = HUB_SCOPE,
  ) {}

  read(): Finding[] {
    const rows = this.store.getActiveFacts(this.scope, undefined, "finding");
    const findings: Finding[] = [];
    for (const row of rows) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(row.value) as unknown;
      } catch {
        // malformed JSON — skip, never throw (sc-1-3)
        continue;
      }
      const result = FindingSchema.safeParse(parsed);
      if (result.success) {
        findings.push(result.data);
      }
      // schema-invalid value — skip silently
    }
    return findings;
  }
}
