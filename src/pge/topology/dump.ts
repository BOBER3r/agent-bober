import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
import { z } from "zod";
import type { TopologySpec } from "../../contracts/topology.js";
import { canonicalize, checksumTopology } from "./canonical.js";

/**
 * Serialization and on-disk placement of a topology artifact.
 *
 * This module reads and writes plain JSON under `.bober/topology/` and nothing else.
 * It spawns no process, opens no socket and imports no executor — the ESLint
 * `no-restricted-imports` boundary on `src/pge/topology/**` makes that a property of
 * the module graph rather than of a review (ADR-2).
 *
 * `.bober/topology/` is deliberately version-controlled: the runtime loads the JSON,
 * never `coding.graph.ts`, so the committed artifact is the load-bearing contract.
 */

// ── Paths ───────────────────────────────────────────────────────────

/** Directory holding committed topology artifacts, relative to the project root. */
export const TOPOLOGY_DIR = join(".bober", "topology");

/** Absolute path of the committed artifact for `graphId`. */
export function topologyArtifactPath(projectRoot: string, graphId: string): string {
  return join(projectRoot, TOPOLOGY_DIR, `${graphId}.json`);
}

/** Directory the `promptRef` strings in a topology resolve against. */
export const PROMPT_DIR = join(".bober", "prompts");

// ── Filesystem reads ────────────────────────────────────────────────

/**
 * The three distinguishable outcomes of reading a file that may legitimately be absent.
 *
 * `absent` is ONLY `ENOENT`. Every other errno — `EACCES`, `EISDIR`, `EPERM`, `ELOOP` —
 * means the file may well exist and we could not look at it, which is a different fact
 * with a different remedy. Collapsing them into "missing" told the operator to run
 * `bober pge dump`, which would then fail on the same permission.
 */
export type FileRead =
  | { kind: "present"; text: string }
  | { kind: "absent" }
  | { kind: "unreadable"; code: string; message: string };

/** The `code` of a Node `SystemError`, or `undefined` for anything else. */
function errnoCode(error: unknown): string | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return typeof code === "string" ? code : undefined;
}

/** Read `path` as UTF-8, distinguishing "not there" from "there but unreadable". */
export async function readIfPresent(path: string): Promise<FileRead> {
  try {
    return { kind: "present", text: await readFile(path, "utf8") };
  } catch (error) {
    const code = errnoCode(error);
    const message = error instanceof Error ? error.message : String(error);
    if (code === "ENOENT") return { kind: "absent" };
    return { kind: "unreadable", code: code ?? "UNKNOWN", message };
  }
}

// ── Serialization ───────────────────────────────────────────────────

/**
 * The exact bytes `bober pge dump` writes.
 *
 * Nested ordering is delegated to {@link canonicalize} — one canonical ordering, not
 * two — and only the top-level `checksum`, which `canonicalize` elides by
 * construction, is re-inserted and re-sorted here. Pretty-printed with a trailing
 * newline so a topology change is a readable git diff rather than one long line.
 */
export function serializeTopology(spec: TopologySpec): string {
  const canonical = JSON.parse(canonicalize(spec)) as Record<string, unknown>;
  const withChecksum: Record<string, unknown> = { ...canonical, checksum: spec.checksum };
  const sorted: Record<string, unknown> = {};
  for (const key of Object.keys(withChecksum).sort()) {
    sorted[key] = withChecksum[key];
  }
  return `${JSON.stringify(sorted, null, 2)}\n`;
}

// ── Dump ────────────────────────────────────────────────────────────

/**
 * Why a committed artifact does not match the authored literal.
 *
 *  - `none` / `missing` / `content` — the committed file matched, was absent, or differed.
 *  - `unreadable` — the file could not be read for a reason OTHER than absence
 *    (`EACCES`, `EISDIR`, …). Never conflated with `missing`: the remedy differs.
 *  - `stale` — the SPEC's stored checksum does not match its own canonical form, so
 *    writing it would commit a permanently self-inconsistent artifact. Nothing is written.
 */
export type TopologyDrift = "none" | "missing" | "content" | "unreadable" | "stale";

export interface DumpResult {
  /** Absolute path of the committed artifact. */
  path: string;
  /**
   * The checksum CARRIED BY {@link DumpResult.serialized}.
   *
   * Single source: {@link dumpTopology} refuses to proceed unless the spec's stored
   * checksum already equals `checksumTopology(spec)`, so this field, the `checksum` key
   * inside `serialized`, and the canonical checksum are one value by construction. When
   * `drift` is `"stale"` this is the CANONICAL checksum and `stale` reports both sides.
   */
  checksum: `sha256:${string}`;
  /** The exact bytes the authored literal serializes to. */
  serialized: string;
  /** `"none"` when the committed artifact matches byte for byte. */
  drift: TopologyDrift;
  /** True only when this call wrote the file. Always false in check mode. */
  written: boolean;
  /** Set when and only when `drift` is `"unreadable"`. */
  unreadable?: { code: string; message: string };
  /** Set when and only when `drift` is `"stale"`. */
  stale?: { stored: string; canonical: `sha256:${string}` };
}

export interface DumpOptions {
  /**
   * Compare only. The committed artifact is never rewritten, so a drifted file stays
   * drifted and the caller can fail the build on it.
   */
  check?: boolean;
}

/**
 * Serialize `spec` to `.bober/topology/<graphId>.json`.
 *
 * In check mode nothing is written and `drift` reports whether the committed artifact
 * is missing or differs by so much as one byte.
 *
 * Two refusals write nothing in either mode:
 *  - a spec whose stored checksum is not its canonical checksum (`drift: "stale"`),
 *    because the bytes would carry a checksum that contradicts their own content;
 *  - a committed artifact that exists but cannot be read (`drift: "unreadable"`),
 *    because overwriting a file we could not compare against is not a dump, it is a
 *    guess.
 */
export async function dumpTopology(
  projectRoot: string,
  spec: TopologySpec,
  opts: DumpOptions = {},
): Promise<DumpResult> {
  const path = topologyArtifactPath(projectRoot, spec.graphId);
  const serialized = serializeTopology(spec);
  const canonical = checksumTopology(spec);

  if (spec.checksum !== canonical) {
    return {
      path,
      checksum: canonical,
      serialized,
      drift: "stale",
      written: false,
      stale: { stored: spec.checksum, canonical },
    };
  }

  // From here `spec.checksum === canonical === the checksum inside `serialized``: one
  // value, so the reported checksum cannot diverge from the bytes.
  const checksum = spec.checksum;

  const committed = await readIfPresent(path);
  if (committed.kind === "unreadable") {
    return {
      path,
      checksum,
      serialized,
      drift: "unreadable",
      written: false,
      unreadable: { code: committed.code, message: committed.message },
    };
  }

  const drift: TopologyDrift =
    committed.kind === "absent" ? "missing" : committed.text === serialized ? "none" : "content";

  if (opts.check) {
    return { path, checksum, serialized, drift, written: false };
  }

  if (drift === "none") {
    // Byte-identical already — do not touch the file's mtime.
    return { path, checksum, serialized, drift, written: false };
  }

  await mkdir(join(projectRoot, TOPOLOGY_DIR), { recursive: true });
  await writeFile(path, serialized, "utf8");
  return { path, checksum, serialized, drift, written: true };
}

// ── Reading ─────────────────────────────────────────────────────────

export type ReadArtifactResult =
  | { ok: true; raw: unknown; text: string }
  | { ok: false; reason: "missing" | "unreadable" | "unparseable"; message: string };

/**
 * Read a topology artifact as raw JSON. Never throws; a bad file is a typed result.
 *
 * `missing` is `ENOENT` alone — a file that exists but cannot be opened reports
 * `unreadable`, so "create it" is never suggested for a permissions failure.
 */
export async function readTopologyArtifact(path: string): Promise<ReadArtifactResult> {
  const read = await readIfPresent(path);
  if (read.kind === "absent") {
    return { ok: false, reason: "missing", message: `${path} does not exist` };
  }
  if (read.kind === "unreadable") {
    return { ok: false, reason: "unreadable", message: `${read.code}: ${read.message}` };
  }
  try {
    return { ok: true, raw: JSON.parse(read.text) as unknown, text: read.text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "unparseable", message };
  }
}

// ── Prompt store ────────────────────────────────────────────────────

/**
 * The prompt store as found on disk.
 *
 * `available: false` means `.bober/prompts/` DOES NOT EXIST — which is not the same
 * fact as "it exists and holds nothing". An empty-but-present store resolves no ref and
 * every `promptRef` is genuinely unknown; an ABSENT store means this workspace has no
 * prompt store at all and ref resolution cannot be performed, which the caller must
 * report as its own outcome rather than as fifteen unknown refs (see
 * `runPgeValidate`).
 */
export type PromptStore =
  | { available: true; dir: string; refs: Set<string> }
  | { available: false; dir: string };

/**
 * Every `promptRef` resolvable under `.bober/prompts/`.
 *
 * A ref is the file's path below that directory with the `.md` extension removed and
 * POSIX separators, so `.bober/prompts/planner/draft.md` resolves `"planner/draft"`.
 * Prompt BODIES are deliberately not read: the topology checksum is a function of
 * structure alone, so editing a prompt body must not move it.
 */
export async function readPromptStore(projectRoot: string): Promise<PromptStore> {
  const dir = join(projectRoot, PROMPT_DIR);

  try {
    const info = await stat(dir);
    if (!info.isDirectory()) return { available: false, dir };
  } catch {
    return { available: false, dir };
  }

  const refs = new Set<string>();

  /**
   * @returns false when any directory could not be enumerated. A partially read store
   *          must not be reported as available: the missing half would surface as
   *          `UnknownPromptRef` on refs that are in fact perfectly resolvable.
   */
  const walk = async (from: string, prefix: string): Promise<boolean> => {
    let entries: Dirent[];
    try {
      entries = await readdir(from, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return false;
    }
    let complete = true;
    for (const entry of entries) {
      const child = join(from, entry.name);
      if (entry.isDirectory()) {
        const ok = await walk(child, prefix === "" ? entry.name : posix.join(prefix, entry.name));
        complete = complete && ok;
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const base = entry.name.slice(0, -".md".length);
      refs.add(prefix === "" ? base : posix.join(prefix, base));
    }
    return complete;
  };

  return (await walk(dir, "")) ? { available: true, dir, refs } : { available: false, dir };
}

// ── Guards ──────────────────────────────────────────────────────────

/**
 * The minimum shape that makes a JSON document a CANDIDATE topology artifact.
 *
 * Zod, not a hand-rolled predicate: the project has one validation library and a
 * second, hand-written notion of "object with a nodes array" would be free to drift
 * away from `TopologySpecSchema`. Deliberately not `.min(1)` — an empty `nodes` array
 * is a topology with a rule violation (`EmptyGraph`), not a non-topology.
 */
export const TopologyShapeSchema = z.object({ nodes: z.array(z.unknown()) });

/**
 * True when `raw` at least LOOKS like a topology artifact.
 *
 * This selects the ERROR MESSAGE, never whether the schema runs: every verb parses the
 * document through `TopologySpecSchema` (directly, or via `validateTopology`) whatever
 * this returns, so a malformed artifact can no longer skip schema validation by being
 * the wrong shape.
 */
export function looksLikeTopology(raw: unknown): boolean {
  return TopologyShapeSchema.safeParse(raw).success;
}
