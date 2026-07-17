/**
 * ApprovedFinding — the structural safety boundary between the hub and the
 * Sprint-12 `SeoBuilder` (spec-20260717-seo-improver-builder, Sprint 11;
 * ADR-4, `.bober/architecture/arch-20260716-seo-improver-builder-extension-adr-4.md`).
 *
 * Constructible ONLY via `ApprovedFinding.from(...)` — the sole factory,
 * itself never throwing — which asserts the hub Finding is human-approved
 * AND carries a well-formed `cite:` evidence URL before minting an instance.
 * A raw/dropped/downgraded/uncited `SeoFinding` has NO public path into this
 * type: a dropped finding never reached the hub as an approved action, so no
 * `ApprovedFinding` can exist for it (resurrection structurally impossible,
 * sc-11-1/sc-11-2).
 *
 * Schema-vs-contract reconciliation (see the Sprint-11 briefing §0): the
 * canonical hub `FindingSchema.status` (`../hub/finding.js:23`) is
 * `z.enum(["open","in-progress","snoozed","done","dropped"])` — there is NO
 * `"approved"` status, so `finding.status === "approved"` against a raw
 * `Finding` is a TS2367 compile error. Mirroring the do-bridge port-local
 * pattern (`../do-bridge/finding-port.ts:10-19`, "the hub schema is NOT
 * modified"), `ApprovedHubFindingSchema` below WIDENS the status union
 * locally — `../hub/finding.ts` stays byte-identical. Likewise `Finding` has
 * no top-level `citationUrl`; the SEO citation round-trips inside
 * `evidence[]` as a `cite:<url>` string (encoded at
 * `../hub-emitter.ts:76`, decode precedent at `../benchmark/harness.ts:112-121`)
 * — `extractCitationUrl` below decodes exactly what the emitter encoded.
 */
import { z } from "zod";

import { FindingSchema } from "../../hub/finding.js";

// -- Widened hub Finding view (port-local; ../../hub/finding.ts untouched) --

/**
 * Builder-local widened view of the hub `Finding` shape — adds `"approved"`
 * to the status union WITHOUT mutating the canonical `FindingSchema`
 * (mirrors `../../do-bridge/finding-port.ts:10-19`). Every other field is
 * reused verbatim via `.extend()`.
 */
export const ApprovedHubFindingSchema = FindingSchema.extend({
  status: z.enum(["open", "in-progress", "snoozed", "done", "dropped", "approved"]),
});

export type ApprovedHubFinding = z.infer<typeof ApprovedHubFindingSchema>;

// -- Local single-purpose URL check (no shared util exists in src) --------

/**
 * A citationUrl is well-formed when it is a non-empty, non-whitespace string
 * that parses as an absolute http(s) URL. Mirrors `../citation-gate.ts:34-42`
 * (`isWellFormedCitationUrl`) — no shared URL-validation util exists in
 * `src`; this is a local copy per that file's own precedent comment.
 */
function isWellFormedCitationUrl(url: string): boolean {
  if (typeof url !== "string" || url.trim().length === 0) return false;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

// -- cite:/tag extraction (decodes exactly what hub-emitter.ts encoded) ----

/**
 * Extract `sourceCitationUrl` from the `evidence[]` entry that starts with
 * `cite:` (mirrors `../benchmark/harness.ts:112-121`, `lacksWellFormedCitation`).
 * Returns `null` — never throws — when the entry is absent or the URL is
 * malformed. NEVER invents a URL.
 */
function extractCitationUrl(finding: ApprovedHubFinding): string | null {
  const citeEntry = finding.evidence.find((e) => e.startsWith("cite:"));
  if (citeEntry === undefined) return null;
  const url = citeEntry.slice("cite:".length);
  return isWellFormedCitationUrl(url) ? url : null;
}

/**
 * Extract the first `tags[]` entry starting with `prefix`, minus the prefix.
 * Mirrors `../benchmark/harness.ts:106-108` (`extractPlaybookRef`). SEO
 * findings carry `tags: ["seo","workflow:<w>","playbook:<ref>","confidence:<c>"]`
 * (`../hub-emitter.ts:79-84`).
 */
function extractTag(finding: ApprovedHubFinding, prefix: string): string | undefined {
  const tag = finding.tags.find((t) => t.startsWith(prefix));
  return tag !== undefined ? tag.slice(prefix.length) : undefined;
}

// -- ApprovedFinding --------------------------------------------------------

/**
 * A hub Finding a human has approved, carrying a decoded, well-formed
 * citation. The private constructor + private brand field together make
 * this type NOMINAL: a structurally-similar plain object (e.g. a raw
 * `SeoFinding` literal) is never assignable, and `new ApprovedFinding(...)`
 * is unreachable outside this module. `ApprovedFinding.from` is the ONLY
 * public construction path.
 */
export class ApprovedFinding {
  // Private INSTANCE field => TS compares this class nominally. A plain
  // object literal (e.g. a raw SeoFinding) can NEVER satisfy this private
  // member, so it can never be assigned to ApprovedFinding (sc-11-1/sc-11-2,
  // compile-proof — see approved-finding.test.ts).
  private readonly __brand = "ApprovedFinding" as const;

  private constructor(
    /** The hub Finding id this instance was derived from (provenance). */
    readonly sourceFindingId: string,
    readonly title: string,
    /** Extracted from the `cite:` evidence entry — never invented. */
    readonly sourceCitationUrl: string,
    readonly severity: 1 | 2 | 3 | 4 | 5,
    /** From the `playbook:` tag; empty string if the tag is absent. */
    readonly playbookRef: string,
    /** From the `workflow:` tag; empty string if the tag is absent. */
    readonly workflow: string,
  ) {}

  /** Debug representation; also reads `__brand` so it is not flagged unused under `noUnusedLocals`. */
  toString(): string {
    return `${this.__brand}(${this.sourceFindingId})`;
  }

  /**
   * The ONLY way to build an `ApprovedFinding`. Returns `null` — NEVER
   * throws — when `finding.status !== "approved"` or the `cite:` evidence
   * entry is missing/malformed. This is the single gate ADR-4's Risk
   * section calls out: "if the adapter itself trusts an un-approved
   * Finding, the guarantee leaks" — so both checks happen here, in the one
   * place an `ApprovedFinding` can be minted.
   */
  static from(finding: ApprovedHubFinding): ApprovedFinding | null {
    if (finding.status !== "approved") return null;

    const citationUrl = extractCitationUrl(finding);
    if (citationUrl === null) return null;

    // bober: playbookRef/workflow default to "" when the tag is absent
    // rather than gating construction on them — ADR-4's Risk section only
    // requires status===approved + a well-formed citation; these tags are
    // enrichment provenance for Sprint-12, not part of the safety gate.
    const playbookRef = extractTag(finding, "playbook:") ?? "";
    const workflow = extractTag(finding, "workflow:") ?? "";

    return new ApprovedFinding(
      finding.id,
      finding.title,
      citationUrl,
      finding.severity as 1 | 2 | 3 | 4 | 5,
      playbookRef,
      workflow,
    );
  }
}
