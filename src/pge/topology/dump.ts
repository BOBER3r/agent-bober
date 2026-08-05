import type { Dirent } from "node:fs";
import { mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join, posix } from "node:path";
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

// ── Serialization ───────────────────────────────────────────────────

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

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

/** Why a committed artifact does not match the authored literal. */
export type TopologyDrift = "none" | "missing" | "content";

export interface DumpResult {
  /** Absolute path of the committed artifact. */
  path: string;
  /** Checksum of the canonical form of the authored literal. */
  checksum: `sha256:${string}`;
  /** The exact bytes the authored literal serializes to. */
  serialized: string;
  /** `"none"` when the committed artifact matches byte for byte. */
  drift: TopologyDrift;
  /** True only when this call wrote the file. Always false in check mode. */
  written: boolean;
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
 */
export async function dumpTopology(
  projectRoot: string,
  spec: TopologySpec,
  opts: DumpOptions = {},
): Promise<DumpResult> {
  const path = topologyArtifactPath(projectRoot, spec.graphId);
  const serialized = serializeTopology(spec);
  const checksum = checksumTopology(spec);

  let committed: string | undefined;
  try {
    committed = await readFile(path, "utf8");
  } catch {
    committed = undefined;
  }

  const drift: TopologyDrift =
    committed === undefined ? "missing" : committed === serialized ? "none" : "content";

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
  | { ok: false; reason: "missing" | "unparseable"; message: string };

/** Read a topology artifact as raw JSON. Never throws; a bad file is a typed result. */
export async function readTopologyArtifact(path: string): Promise<ReadArtifactResult> {
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "missing", message };
  }
  try {
    return { ok: true, raw: JSON.parse(text) as unknown, text };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: "unparseable", message };
  }
}

// ── Prompt store ────────────────────────────────────────────────────

/**
 * Every `promptRef` resolvable under `.bober/prompts/`.
 *
 * A ref is the file's path below that directory with the `.md` extension removed and
 * POSIX separators, so `.bober/prompts/planner/draft.md` resolves `"planner/draft"`.
 * Prompt BODIES are deliberately not read: the topology checksum is a function of
 * structure alone, so editing a prompt body must not move it.
 */
export async function readPromptRefs(projectRoot: string): Promise<Set<string>> {
  const root = join(projectRoot, PROMPT_DIR);
  const refs = new Set<string>();

  const walk = async (dir: string, prefix: string): Promise<void> => {
    let entries: Dirent[];
    try {
      entries = await readdir(dir, { withFileTypes: true, encoding: "utf8" });
    } catch {
      return;
    }
    for (const entry of entries) {
      const child = join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(child, prefix === "" ? entry.name : posix.join(prefix, entry.name));
        continue;
      }
      if (!entry.name.endsWith(".md")) continue;
      const base = entry.name.slice(0, -".md".length);
      refs.add(prefix === "" ? base : posix.join(prefix, base));
    }
  };

  await walk(root, "");
  return refs;
}

// ── Guards ──────────────────────────────────────────────────────────

/**
 * True when `raw` at least LOOKS like a topology artifact — used to give a readable
 * error before Zod produces a wall of issues for, say, a JSON array.
 */
export function looksLikeTopology(raw: unknown): boolean {
  return isPlainObject(raw) && Array.isArray(raw.nodes);
}
