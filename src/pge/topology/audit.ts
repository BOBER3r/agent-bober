import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";
import { CHECKSUM_PATTERN } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { checksumTopology } from "./canonical.js";
import { TOPOLOGY_DIR } from "./dump.js";

/**
 * State audit: every declared channel key with the nodes that write it and read it.
 *
 * Writers and readers are DERIVED from `nodes[].writes` / `nodes[].reads` because
 * ADR-4 forbids storing them a second time on `channels[]`, so there is exactly one
 * encoding to read and the audit cannot disagree with the artifact.
 *
 * `generatedFrom.checksum` is the CANONICAL checksum of the spec, not the `checksum`
 * field it carries: an artifact whose stored checksum has gone stale still audits to
 * the truth, and a stale AUDIT is detectable by comparing this value against the
 * artifact's canonical form.
 */

// ── Schema ──────────────────────────────────────────────────────────

export const StateAuditKeySchema = z.object({
  key: z.string().min(1),
  writers: z.array(z.string().min(1)),
  readers: z.array(z.string().min(1)),
  reducer: z.string().min(1),
});
export type StateAuditKey = z.infer<typeof StateAuditKeySchema>;

export const StateAuditSchema = z.object({
  generatedFrom: z.object({
    graphId: z.string().min(1),
    checksum: z.string().regex(CHECKSUM_PATTERN),
  }),
  keys: z.array(StateAuditKeySchema),
});
export type StateAudit = z.infer<typeof StateAuditSchema>;

// ── Paths ───────────────────────────────────────────────────────────

export const STATE_AUDIT_FILENAME = "state-audit.json";

/** Absolute path of the committed state audit. */
export function stateAuditPath(projectRoot: string): string {
  return join(projectRoot, TOPOLOGY_DIR, STATE_AUDIT_FILENAME);
}

// ── Derivation ──────────────────────────────────────────────────────

function compareStrings(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compareStrings);
}

/**
 * Derive the state audit from the artifact alone.
 *
 * Keys are exactly the DECLARED channels, sorted by id. A node writing or reading a
 * channel absent from `channels[]` is a validator diagnostic (`ChannelDeclMismatch` /
 * `UndeclaredChannel`), not an audit row — inventing a key here would let an undeclared
 * channel look governed.
 */
export function generateStateAudit(spec: TopologySpec): StateAudit {
  const writers = new Map<string, string[]>();
  const readers = new Map<string, string[]>();

  for (const node of spec.nodes) {
    for (const channel of node.writes) {
      const bucket = writers.get(channel);
      if (bucket) bucket.push(node.id);
      else writers.set(channel, [node.id]);
    }
    for (const channel of node.reads) {
      const bucket = readers.get(channel);
      if (bucket) bucket.push(node.id);
      else readers.set(channel, [node.id]);
    }
  }

  const keys: StateAuditKey[] = [...spec.channels]
    .sort((a, b) => compareStrings(a.id, b.id))
    .map((channel) => ({
      key: channel.id,
      writers: sortedUnique(writers.get(channel.id) ?? []),
      readers: sortedUnique(readers.get(channel.id) ?? []),
      reducer: channel.reducerRef,
    }));

  return {
    generatedFrom: { graphId: spec.graphId, checksum: checksumTopology(spec) },
    keys,
  };
}

/** The exact bytes `bober pge audit-state` writes. Pretty-printed, one trailing newline. */
export function serializeStateAudit(audit: StateAudit): string {
  return `${JSON.stringify(audit, null, 2)}\n`;
}

// ── Writing ─────────────────────────────────────────────────────────

/**
 * `invalid` means the DERIVED audit does not satisfy `StateAuditSchema`, so nothing was
 * compared and nothing was written — drift is unknowable when the derivation itself is
 * not a state audit.
 */
export type StateAuditDrift = "none" | "missing" | "content" | "invalid";

/** Why a derived audit failed its own schema. */
export interface StateAuditInvalid {
  /** Dotted path of the first offending field, e.g. `keys.4.reducer`. */
  path: string;
  message: string;
  /** The channel key whose row is malformed, when the issue is inside `keys[]`. */
  key?: string;
}

export interface StateAuditResult {
  path: string;
  audit: StateAudit;
  /** Empty when `drift` is `"invalid"`: bytes are produced only for a schema-valid audit. */
  serialized: string;
  drift: StateAuditDrift;
  /** True only when this call wrote the file. Always false in check mode. */
  written: boolean;
  /** Set only when `drift` is `"invalid"`. */
  invalid?: StateAuditInvalid;
}

export interface WriteStateAuditOptions {
  /** Compare only. A drifted audit stays drifted so the caller can fail the build on it. */
  check?: boolean;
}

/**
 * Derive the audit and write it to `.bober/topology/state-audit.json`.
 *
 * Idempotent: the derivation is a pure function of the artifact and the serialization is
 * deterministic, so running twice leaves byte-identical content and the second call
 * does not touch the file.
 *
 * The derived audit is parsed through `StateAuditSchema` BEFORE any byte is written, and
 * a failure returns `drift: "invalid"` with nothing written. This is reachable, not
 * theoretical: `ChannelDeclSchema.reducerRef` is `z.string()` while
 * `StateAuditKeySchema.reducer` is `z.string().min(1)`, so an artifact carrying an empty
 * `reducerRef` parses as a topology but audits to a row this module's own exported
 * schema rejects. Writing it would commit an artifact that the very next
 * `StateAuditSchema.parse` throws on.
 */
export async function writeStateAudit(
  projectRoot: string,
  spec: TopologySpec,
  opts: WriteStateAuditOptions = {},
): Promise<StateAuditResult> {
  const path = stateAuditPath(projectRoot);
  const audit = generateStateAudit(spec);

  const validated = StateAuditSchema.safeParse(audit);
  if (!validated.success) {
    const issue = validated.error.issues[0];
    const issuePath = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
    // `keys.<index>.<field>` — recover the channel key so the caller can name it.
    const index = issue?.path[0] === "keys" ? Number(issue.path[1]) : Number.NaN;
    const key = Number.isInteger(index) ? audit.keys[index]?.key : undefined;
    return {
      path,
      audit,
      serialized: "",
      drift: "invalid",
      written: false,
      invalid: { path: issuePath, message: issue?.message ?? "unknown issue", key },
    };
  }

  // Serialize the PARSED value, so the bytes on disk are provably schema-conformant.
  const serialized = serializeStateAudit(validated.data);

  let committed: string | undefined;
  try {
    committed = await readFile(path, "utf8");
  } catch {
    committed = undefined;
  }

  const drift: StateAuditDrift =
    committed === undefined ? "missing" : committed === serialized ? "none" : "content";

  if (opts.check || drift === "none") {
    return { path, audit, serialized, drift, written: false };
  }

  await mkdir(join(projectRoot, TOPOLOGY_DIR), { recursive: true });
  await writeFile(path, serialized, "utf8");
  return { path, audit, serialized, drift, written: true };
}
