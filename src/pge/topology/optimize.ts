import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CHECKSUM_PATTERN, TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { TOPOLOGY_DIR, serializeTopology } from "./dump.js";
import { validateTopology } from "./validate.js";
import type { DiagnosticCode, ValidationReport } from "./validate.js";

/**
 * The structure-level optimisation HOOK: apply a caller-supplied mutation, re-seal and
 * re-validate the result, and record it as a variant.
 *
 * Deliberately NOT an optimiser. There is no search strategy, no scoring model and no
 * promotion command (deferred R10): a golden dataset to score against does not exist
 * yet, so `score` is a placeholder that stays `null` until one does. What ships is the
 * seam an offline optimiser can be written against — mutate, re-validate, record —
 * with zero node executions, because nothing in this layer can reach an executor.
 *
 * Variant output carries `provenance: "optimizer"` and lives under
 * `.bober/topology/variants/`, which `bober pge dump --check` never looks at: that gate
 * compares the authored literal against `.bober/topology/<graphId>.json` and applies
 * only to `provenance: "authored"` (ADR-2). Promoting a variant is an explicit human
 * step that rewrites the typed literal.
 */

// ── Paths ───────────────────────────────────────────────────────────

/** Directory holding per-variant records, relative to the project root. */
export const VARIANTS_DIR = join(TOPOLOGY_DIR, "variants");

/** Absolute path of the variants directory. */
export function variantsDir(projectRoot: string): string {
  return join(projectRoot, VARIANTS_DIR);
}

/** Absolute path of one variant record. */
export function variantRecordPath(projectRoot: string, variantId: string): string {
  return join(variantsDir(projectRoot), `${variantId}.json`);
}

// ── Mutation ────────────────────────────────────────────────────────

export type TopologyMutator = (spec: TopologySpec) => TopologySpec;

export interface OptimizeResult {
  /** The mutated topology, provenance-stamped and re-sealed. A NEW object; the input is untouched. */
  spec: TopologySpec;
  /** Structural validation of the mutated topology. Never throws. */
  report: ValidationReport;
}

/**
 * Apply `mutate` to a DEEP COPY of `spec`, stamp `provenance: "optimizer"`, re-seal the
 * checksum over the mutated canonical form and re-validate.
 *
 * The mutator receives a copy, so a mutator that edits its argument in place — the
 * natural way to write one — cannot corrupt the caller's authored graph.
 *
 * @throws TypeError when `spec` fails `TopologySpecSchema.parse`.
 */
export function optimizeTopology(spec: TopologySpec, mutate: TopologyMutator): OptimizeResult {
  const parsed = TopologySpecSchema.safeParse(JSON.parse(JSON.stringify(spec)) as unknown);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
    throw new TypeError(
      `optimizeTopology: the base topology does not match TopologySpecSchema (at ${where}: ${issue?.message ?? "unknown issue"}).`,
    );
  }

  const mutated = mutate(parsed.data);
  const stamped: TopologySpec = { ...mutated, provenance: "optimizer" };
  const sealed: TopologySpec = { ...stamped, checksum: checksumTopology(stamped) };

  return { spec: sealed, report: validateTopology(sealed) };
}

// ── Variant record ──────────────────────────────────────────────────

/**
 * A per-variant record.
 *
 * `score` is a PLACEHOLDER: null until a golden dataset exists to score against
 * (sprint 14). It is present now so an offline optimiser has somewhere to put a result
 * without a schema migration, and so a variant is never mistaken for an authored graph.
 */
export const VariantRecordSchema = z.object({
  formatVersion: z.literal(1),
  variantId: z.string().min(1),
  graphId: z.string().min(1),
  provenance: z.literal("optimizer"),
  /** Canonical checksum of the graph the mutation started from. */
  baseChecksum: z.string().regex(CHECKSUM_PATTERN),
  /** Canonical checksum of the mutated graph. */
  variantChecksum: z.string().regex(CHECKSUM_PATTERN),
  /** True when the mutated graph produced zero error diagnostics. */
  valid: z.boolean(),
  /** Every diagnostic code the mutated graph produced, sorted and de-duplicated. */
  diagnosticCodes: z.array(z.string().min(1)),
  score: z.number().nullable(),
  scoredAt: z.string().nullable(),
  spec: TopologySpecSchema,
});
export type VariantRecord = z.infer<typeof VariantRecordSchema>;

function sanitizeIdSegment(value: string): string {
  return value.replace(/[^A-Za-z0-9_.-]/g, "_");
}

/**
 * Deterministic variant id: graph id plus the first 16 hex characters of the variant's
 * canonical checksum. Two runs of the same mutation over the same base produce the same
 * id, so re-running an optimiser overwrites its own record instead of accumulating
 * duplicates.
 */
export function variantId(spec: TopologySpec): string {
  const checksum = checksumTopology(spec);
  return `${sanitizeIdSegment(spec.graphId)}-${checksum.slice("sha256:".length, "sha256:".length + 16)}`;
}

function diagnosticCodesOf(report: ValidationReport): string[] {
  const codes = new Set<DiagnosticCode>(report.diagnostics.map((d) => d.code));
  return [...codes].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
}

/** Build the record for one optimisation result. Pure — no clock, so it is reproducible. */
export function buildVariantRecord(base: TopologySpec, result: OptimizeResult): VariantRecord {
  // The embedded spec goes through the same canonical serialization as the committed
  // artifact, so a variant record and a dumped artifact of the same graph agree byte for
  // byte on the topology they describe.
  const canonicalSpec = JSON.parse(serializeTopology(result.spec)) as TopologySpec;
  return {
    formatVersion: 1,
    variantId: variantId(result.spec),
    graphId: result.spec.graphId,
    provenance: "optimizer",
    baseChecksum: checksumTopology(base),
    variantChecksum: checksumTopology(result.spec),
    valid: result.report.ok,
    diagnosticCodes: diagnosticCodesOf(result.report),
    score: null,
    scoredAt: null,
    spec: canonicalSpec,
  };
}

/** The exact bytes a variant record is written as. Deterministic. */
export function serializeVariantRecord(record: VariantRecord): string {
  return `${JSON.stringify(record, null, 2)}\n`;
}

export interface WriteVariantResult {
  path: string;
  serialized: string;
}

/**
 * Write one variant record under `.bober/topology/variants/<variantId>.json`.
 *
 * The record is parsed through `VariantRecordSchema` BEFORE any byte is written. This
 * matters because `optimizeTopology` does NOT reject a bad mutation — it returns the
 * mutated spec together with a failing `ValidationReport`, so a mutator that strips a
 * required field yields a `result.spec` that `TopologySpecSchema` rejects, and
 * `buildVariantRecord` embeds it without complaint. Persisting that would leave a
 * committed record no reader of this schema can load.
 *
 * @throws TypeError when `record` fails `VariantRecordSchema.parse`.
 */
export async function writeVariantRecord(
  projectRoot: string,
  record: VariantRecord,
): Promise<WriteVariantResult> {
  const parsed = VariantRecordSchema.safeParse(record);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
    throw new TypeError(
      `writeVariantRecord: the record does not match VariantRecordSchema (at ${where}: ${issue?.message ?? "unknown issue"}).`,
    );
  }

  // Serialize the ORIGINAL record, not `parsed.data`: `TopologySpecSchema.parse` rebuilds
  // the embedded spec in schema-declaration key order, which would destroy the
  // alphabetically-canonical key order `buildVariantRecord` took from `serializeTopology`
  // and break the byte-for-byte agreement between a variant record and a dumped artifact.
  // safeParse succeeding is the guarantee; re-emitting is not needed to obtain it.
  const path = variantRecordPath(projectRoot, record.variantId);
  const serialized = serializeVariantRecord(record);
  await mkdir(variantsDir(projectRoot), { recursive: true });
  await writeFile(path, serialized, "utf8");
  return { path, serialized };
}
