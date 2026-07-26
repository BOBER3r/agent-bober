/**
 * readApprovedSeoFindings — the hub->ApprovedFinding adapter
 * (spec-20260717-seo-improver-builder, Sprint 11; ADR-4). The REVERSE of
 * `../hub-emitter.ts`'s SeoFinding->hub mapping: decodes exactly what the
 * emitter encoded (domain `"seo"` filter, `cite:` evidence extraction,
 * `playbook:`/`workflow:` tag extraction — all inside `ApprovedFinding.from`).
 *
 * Reads RAW rows via the same primitive `../../hub/finding-store.ts:47`'s
 * `readFindings` uses (`getActiveFacts(HUB_SCOPE, undefined, "finding")`) —
 * deliberately NOT `readFindings()` itself, because that helper calls
 * `FindingSchema.parse`, which THROWS on a status outside the canonical
 * 5-value enum (`finding-store.ts:48`); an `"approved"` row would crash it.
 * Instead each row is `safeParse`d against the widened
 * `ApprovedHubFindingSchema` and skipped on failure — mirrors
 * `FactStoreFindingSource.read` (`../../hub/finding-source.ts`,
 * "never throws; skip malformed").
 */
import { HUB_SCOPE } from "../../hub/finding-source.js";
import type { FactStore } from "../../state/facts.js";

import { ApprovedFinding, ApprovedHubFindingSchema } from "./approved-finding.js";

/**
 * Reads approved, cited, SEO-domain hub Findings from `store` and maps each
 * to an `ApprovedFinding` via `ApprovedFinding.from`. Never throws: malformed
 * JSON, schema-invalid rows, non-`"seo"`-domain rows, non-`"approved"`
 * status, and uncited/malformed-citation rows are all silently skipped
 * (sc-11-4).
 */
export function readApprovedSeoFindings(store: FactStore): ApprovedFinding[] {
  const out: ApprovedFinding[] = [];

  for (const row of store.getActiveFacts(HUB_SCOPE, undefined, "finding")) {
    let json: unknown;
    try {
      json = JSON.parse(row.value) as unknown;
    } catch {
      continue; // malformed JSON — skip, never throw
    }

    const parsed = ApprovedHubFindingSchema.safeParse(json);
    if (!parsed.success) continue; // schema-invalid — skip

    if (parsed.data.domain !== "seo") continue; // SEO-domain only (../hub-emitter.ts:69)

    const approved = ApprovedFinding.from(parsed.data); // null if !approved / cite-bad
    if (approved !== null) out.push(approved);
  }

  return out;
}
