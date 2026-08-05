import { readFile } from "node:fs/promises";
import type { Command } from "commander";

import { TopologySpecSchema } from "../../contracts/topology.js";
import type { TopologySpec } from "../../contracts/topology.js";
import { writeStateAudit } from "../../pge/topology/audit.js";
import { checksumTopology } from "../../pge/topology/canonical.js";
import {
  CODING_GRAPH_ID,
  CODING_SCHEMA_REFS,
  authoredGraph,
} from "../../pge/topology/coding.graph.js";
import { diffTopology, serializeTopologyDiff } from "../../pge/topology/diff.js";
import { docDriftReport } from "../../pge/topology/docs.js";
import {
  dumpTopology,
  looksLikeTopology,
  readPromptRefs,
  readTopologyArtifact,
  topologyArtifactPath,
} from "../../pge/topology/dump.js";
import { buildVariantRecord, optimizeTopology, writeVariantRecord } from "../../pge/topology/optimize.js";
import { RENDER_FORMATS, isRenderFormat, renderTopology } from "../../pge/topology/render.js";
import type { RenderFormat } from "../../pge/topology/render.js";
import { validateTopology } from "../../pge/topology/validate.js";
import type {
  PromptRefSet,
  SchemaCatalog,
  ValidationMode,
  ValidationReport,
} from "../../pge/topology/validate.js";
import { findProjectRoot } from "../../utils/fs.js";

/**
 * `bober pge` — read and write Prompt Graph Engineering topology data.
 *
 * The verb is `pge` and the directory is `.bober/topology/` because `bober graph` and
 * `.bober/graph/` are already the code-graph namespace (`cli/commands/graph.ts:39`).
 *
 * This command is the composition root of the topology layer: it is where a
 * filesystem-backed prompt store and a schema catalog are injected into the otherwise
 * pure `validateTopology`. It reads and writes JSON and does nothing else — no node
 * body, no registry and no executor is reachable from `src/pge/topology/**`, which is
 * enforced by the ESLint module-graph boundary rather than by review (ADR-2).
 *
 * Verbs: `dump`, `validate` and `hash` (sprint 2) plus `render`, `diff`, `docs`,
 * `audit-state` and `optimize` (sprint 3). Every sprint-3 verb DERIVES its answer from
 * a committed artifact — none of them consults the authored TypeScript literal, so each
 * one is equally usable on a base-branch file fetched in CI.
 */

// ── Exit codes ──────────────────────────────────────────────────────

/** Everything the requested verb asserted held. */
export const EXIT_OK = 0;
/** The topology is wrong: an error diagnostic, drift, or a stale checksum. */
export const EXIT_FAILED = 1;
/** The command could not run: unknown graph id, unreadable or unparseable file. */
export const EXIT_USAGE = 2;

// ── IO seam ─────────────────────────────────────────────────────────

/**
 * Where a verb writes. Injected so the verbs stay testable without capturing the real
 * stdout, and so no verb ever calls `process.exit` — each returns an exit code and the
 * Commander action assigns it to `process.exitCode`.
 */
export interface PgeIo {
  out(line: string): void;
  err(line: string): void;
}

export function processIo(): PgeIo {
  return {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
}

// ── Injected resolvers ──────────────────────────────────────────────

/**
 * The `mode: "full"` schema catalog.
 *
 * Until the compiler's Zod-resolving catalog ships, the closed list of schema refs the
 * shipped coding topology names IS the catalog, and assignability is nominal identity.
 * A ref outside it surfaces as `UnknownSchemaRef` rather than passing silently.
 */
export function codingSchemaCatalog(): SchemaCatalog {
  const known = new Set(CODING_SCHEMA_REFS);
  return {
    has: (ref) => known.has(ref),
    isAssignable: (from, to) => from === to,
  };
}

/** A {@link PromptRefSet} backed by the on-disk prompt store. */
export function promptRefSet(refs: ReadonlySet<string>): PromptRefSet {
  return { has: (ref) => refs.has(ref) };
}

// ── Reporting ───────────────────────────────────────────────────────

function reportDiagnostics(report: ValidationReport, io: PgeIo): number {
  let errors = 0;
  for (const diagnostic of report.diagnostics) {
    const where = diagnostic.path && diagnostic.path.length > 0 ? ` at ${diagnostic.path.join(".")}` : "";
    const line = `${diagnostic.severity} ${diagnostic.code}${where}: ${diagnostic.message}`;
    if (diagnostic.severity === "error") {
      errors += 1;
      io.err(line);
    } else {
      io.out(line);
    }
  }
  return errors;
}

// ── dump ────────────────────────────────────────────────────────────

export interface PgeDumpOptions {
  graphId?: string;
  /** Compare only; never rewrite a drifted artifact. */
  check?: boolean;
}

/**
 * Serialize the authored literal to `.bober/topology/<graphId>.json`.
 *
 * `--check` exits non-zero when the committed artifact is missing or differs by one
 * byte, and deliberately does NOT rewrite it — silently repairing drift would make the
 * CI gate decorative (ADR-2 risk).
 */
export async function runPgeDump(
  projectRoot: string,
  opts: PgeDumpOptions,
  io: PgeIo,
): Promise<number> {
  const graphId = opts.graphId ?? CODING_GRAPH_ID;
  const spec = authoredGraph(graphId);
  if (!spec) {
    io.err(`Unknown authored graph "${graphId}". Known: ${CODING_GRAPH_ID}.`);
    return EXIT_USAGE;
  }

  const report = validateTopology(spec);
  if (!report.ok) {
    reportDiagnostics(report, io);
    io.err(`Refusing to dump "${graphId}": the authored literal does not validate.`);
    return EXIT_FAILED;
  }

  const result = await dumpTopology(projectRoot, spec, { check: opts.check });

  if (opts.check) {
    if (result.drift === "missing") {
      io.err(`Topology artifact missing: ${result.path}. Run \`bober pge dump\`.`);
      return EXIT_FAILED;
    }
    if (result.drift === "content") {
      io.err(
        `Topology artifact out of date: ${result.path} differs from the authored literal. Run \`bober pge dump\`.`,
      );
      return EXIT_FAILED;
    }
    io.out(`ok ${result.path} ${result.checksum}`);
    return EXIT_OK;
  }

  io.out(`${result.written ? "wrote" : "unchanged"} ${result.path} ${result.checksum}`);
  return EXIT_OK;
}

// ── validate ────────────────────────────────────────────────────────

export interface PgeValidateOptions {
  graphId?: string;
  /** Validate this file instead of the committed artifact for `graphId`. */
  file?: string;
  mode?: ValidationMode;
}

/**
 * Validate a topology artifact and print one line per diagnostic, each naming its
 * code. Exits non-zero when any diagnostic has error severity.
 */
export async function runPgeValidate(
  projectRoot: string,
  opts: PgeValidateOptions,
  io: PgeIo,
): Promise<number> {
  const graphId = opts.graphId ?? CODING_GRAPH_ID;
  const path = opts.file ?? topologyArtifactPath(projectRoot, graphId);

  const artifact = await readTopologyArtifact(path);
  if (!artifact.ok) {
    io.err(
      artifact.reason === "missing"
        ? `Cannot read topology artifact ${path}: ${artifact.message}`
        : `Topology artifact ${path} is not valid JSON: ${artifact.message}`,
    );
    return EXIT_USAGE;
  }

  if (!looksLikeTopology(artifact.raw)) {
    io.err(
      `${path} is JSON but not a topology artifact: it declares no nodes array. Expected a TopologySpec.`,
    );
    return EXIT_USAGE;
  }

  const mode: ValidationMode = opts.mode ?? "structural";
  const report =
    mode === "full"
      ? validateTopology(artifact.raw, {
          mode: "full",
          schemas: codingSchemaCatalog(),
          prompts: promptRefSet(await readPromptRefs(projectRoot)),
        })
      : validateTopology(artifact.raw, { mode: "structural" });

  const errors = reportDiagnostics(report, io);
  if (errors > 0) {
    io.err(`${path}: ${errors} error diagnostic${errors === 1 ? "" : "s"} (mode ${mode}).`);
    return EXIT_FAILED;
  }
  io.out(`ok ${path} (mode ${mode}, ${report.diagnostics.length} diagnostics)`);
  return EXIT_OK;
}

// ── hash ────────────────────────────────────────────────────────────

export interface PgeHashOptions {
  graphId?: string;
  /** Hash this file instead of the authored literal for `graphId`. */
  file?: string;
}

/**
 * Print the topology checksum.
 *
 * The checksum is a function of the canonicalised nodes and edges alone, so a prompt
 * body edited under `.bober/prompts/` cannot move it; adding an edge must.
 */
export async function runPgeHash(
  /**
   * Accepted for verb symmetry and deliberately unused: the checksum is a pure
   * function of the authored literal or of the file the caller named, so nothing about
   * it may depend on what else lives under the project root.
   */
  _projectRoot: string,
  opts: PgeHashOptions,
  io: PgeIo,
): Promise<number> {
  const graphId = opts.graphId ?? CODING_GRAPH_ID;

  if (opts.file === undefined) {
    const spec = authoredGraph(graphId);
    if (!spec) {
      io.err(`Unknown authored graph "${graphId}". Known: ${CODING_GRAPH_ID}.`);
      return EXIT_USAGE;
    }
    io.out(checksumTopology(spec));
    return EXIT_OK;
  }

  const artifact = await readTopologyArtifact(opts.file);
  if (!artifact.ok) {
    io.err(
      artifact.reason === "missing"
        ? `Cannot read topology artifact ${opts.file}: ${artifact.message}`
        : `Topology artifact ${opts.file} is not valid JSON: ${artifact.message}`,
    );
    return EXIT_USAGE;
  }

  if (!looksLikeTopology(artifact.raw)) {
    io.err(
      `${opts.file} is JSON but not a topology artifact: it declares no nodes array. Expected a TopologySpec.`,
    );
    return EXIT_USAGE;
  }

  const parsed = TopologySpecSchema.safeParse(artifact.raw);
  if (!parsed.success) {
    io.err(`Topology artifact ${opts.file} does not match TopologySpecSchema.`);
    return EXIT_USAGE;
  }

  const computed = checksumTopology(parsed.data);
  io.out(computed);
  if (parsed.data.checksum !== computed) {
    io.err(
      `error ChecksumStale: stored ${parsed.data.checksum} does not match the canonical form ${computed}.`,
    );
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

// ── Artifact loading (sprint-3 verbs) ───────────────────────────────

type SpecLoad = { ok: true; spec: TopologySpec; path: string } | { ok: false; exit: number };

/**
 * Read and parse ONE topology artifact from disk.
 *
 * Every sprint-3 verb reads the committed JSON rather than the authored literal: the
 * runtime loads the JSON too (ADR-2), so a derivation taken from the literal could
 * disagree with what actually runs, and none of these verbs would work on a base-branch
 * file in CI.
 */
async function loadArtifactSpec(path: string, io: PgeIo): Promise<SpecLoad> {
  const artifact = await readTopologyArtifact(path);
  if (!artifact.ok) {
    io.err(
      artifact.reason === "missing"
        ? `Cannot read topology artifact ${path}: ${artifact.message}`
        : `Topology artifact ${path} is not valid JSON: ${artifact.message}`,
    );
    return { ok: false, exit: EXIT_USAGE };
  }
  if (!looksLikeTopology(artifact.raw)) {
    io.err(
      `${path} is JSON but not a topology artifact: it declares no nodes array. Expected a TopologySpec.`,
    );
    return { ok: false, exit: EXIT_USAGE };
  }
  const parsed = TopologySpecSchema.safeParse(artifact.raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    const where = issue && issue.path.length > 0 ? issue.path.join(".") : "<root>";
    io.err(
      `Topology artifact ${path} does not match TopologySpecSchema (at ${where}: ${issue?.message ?? "unknown issue"}).`,
    );
    return { ok: false, exit: EXIT_USAGE };
  }
  return { ok: true, spec: parsed.data, path };
}

function artifactPathFor(projectRoot: string, opts: { graphId?: string; file?: string }): string {
  return opts.file ?? topologyArtifactPath(projectRoot, opts.graphId ?? CODING_GRAPH_ID);
}

// ── render ──────────────────────────────────────────────────────────

export interface PgeRenderOptions {
  graphId?: string;
  /** Render this file instead of the committed artifact for `graphId`. */
  file?: string;
  format?: string;
}

/**
 * Print a diagram derived from the committed artifact.
 *
 * The output is deterministic and order-invariant, so it can be pinned by a snapshot:
 * a topology change moves the diagram, and a reordering of the authored literal does
 * not.
 */
export async function runPgeRender(
  projectRoot: string,
  opts: PgeRenderOptions,
  io: PgeIo,
): Promise<number> {
  const rawFormat = opts.format ?? "mermaid";
  if (!isRenderFormat(rawFormat)) {
    io.err(`Unknown render format "${rawFormat}". Expected ${RENDER_FORMATS.join(" or ")}.`);
    return EXIT_USAGE;
  }
  const format: RenderFormat = rawFormat;

  const loaded = await loadArtifactSpec(artifactPathFor(projectRoot, opts), io);
  if (!loaded.ok) return loaded.exit;

  // One write of the whole body with the trailing newline removed: the IO seam appends
  // exactly one newline, so stdout carries the rendered bytes unchanged.
  io.out(renderTopology(loaded.spec, format).replace(/\n$/, ""));
  return EXIT_OK;
}

// ── diff ────────────────────────────────────────────────────────────

export interface PgeDiffOptions {
  /** Base artifact path. */
  a: string;
  /** Head artifact path. */
  b: string;
  /** Fail when the diff is non-empty and `graphVersion` did not move forward. */
  requireVersionBump?: boolean;
}

/**
 * Diff two committed artifacts and print the structured result as JSON.
 *
 * Exit code is 0 for any diff — a diff is information, not a verdict — unless
 * `--require-version-bump` is set, which is the CI gate: a structural change that did
 * not move `graphVersion` forward fails.
 */
export async function runPgeDiff(
  /** Unused: both sides are named explicitly, so nothing depends on which root we sit in. */
  _projectRoot: string,
  opts: PgeDiffOptions,
  io: PgeIo,
): Promise<number> {
  const left = await loadArtifactSpec(opts.a, io);
  if (!left.ok) return left.exit;
  const right = await loadArtifactSpec(opts.b, io);
  if (!right.ok) return right.exit;

  const diff = diffTopology(left.spec, right.spec);
  io.out(serializeTopologyDiff(diff).replace(/\n$/, ""));

  if (opts.requireVersionBump && !diff.empty && !diff.graphVersion.bumped) {
    io.err(
      `Topology changed but graphVersion did not move forward (${diff.graphVersion.from} -> ${diff.graphVersion.to}).`,
    );
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

// ── docs ────────────────────────────────────────────────────────────

export interface PgeDocsOptions {
  graphId?: string;
  /** Check this artifact instead of the committed one for `graphId`. */
  file?: string;
  /** Markdown document whose `pge:nodes` block declares the documented node ids. */
  doc: string;
}

/**
 * Compare the node ids documented in a markdown file to the node ids in the artifact.
 *
 * Exits non-zero on any drift in either direction: an undocumented node and a
 * documented node that no longer exists are both stale documentation.
 */
export async function runPgeDocs(
  projectRoot: string,
  opts: PgeDocsOptions,
  io: PgeIo,
): Promise<number> {
  const loaded = await loadArtifactSpec(artifactPathFor(projectRoot, opts), io);
  if (!loaded.ok) return loaded.exit;

  let text: string;
  try {
    text = await readFile(opts.doc, "utf8");
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    io.err(`Cannot read documentation file ${opts.doc}: ${message}`);
    return EXIT_USAGE;
  }

  const report = docDriftReport(loaded.spec, text);
  for (const id of report.missing) {
    io.err(`error DocDrift: node "${id}" is declared in the topology but absent from ${opts.doc}.`);
  }
  for (const id of report.extra) {
    io.err(`error DocDrift: "${id}" is documented in ${opts.doc} but is not a declared node.`);
  }
  if (report.drift.length > 0) {
    io.err(`${opts.doc}: ${report.drift.length} documentation drift(s).`);
    return EXIT_FAILED;
  }
  io.out(`ok ${opts.doc} (${report.declared.length} nodes documented)`);
  return EXIT_OK;
}

// ── audit-state ─────────────────────────────────────────────────────

export interface PgeAuditStateOptions {
  graphId?: string;
  /** Audit this artifact instead of the committed one for `graphId`. */
  file?: string;
  /** Compare only; never rewrite a drifted audit. */
  check?: boolean;
}

/**
 * Derive `.bober/topology/state-audit.json` from the artifact.
 *
 * Writers and readers come from `nodes[].writes` / `nodes[].reads` — the single
 * encoding ADR-4 allows — so the audit cannot drift from the graph without the
 * artifact itself changing.
 */
export async function runPgeAuditState(
  projectRoot: string,
  opts: PgeAuditStateOptions,
  io: PgeIo,
): Promise<number> {
  const loaded = await loadArtifactSpec(artifactPathFor(projectRoot, opts), io);
  if (!loaded.ok) return loaded.exit;

  const result = await writeStateAudit(projectRoot, loaded.spec, { check: opts.check });

  // The artifact parsed as a topology but audits to something StateAuditSchema rejects
  // (an empty `reducerRef` is the reachable case). Nothing was written; report it as a
  // failed verb rather than letting the caller commit an unloadable audit.
  if (result.drift === "invalid") {
    const where = result.invalid?.key !== undefined ? `channel "${result.invalid.key}"` : "the audit";
    io.err(
      `error StateAuditInvalid: ${where} produced an invalid state audit at ${result.invalid?.path ?? "<root>"}: ${result.invalid?.message ?? "unknown issue"}.`,
    );
    io.err(`Refusing to write ${result.path}. Fix the artifact and re-run.`);
    return EXIT_FAILED;
  }

  if (opts.check) {
    if (result.drift === "missing") {
      io.err(`State audit missing: ${result.path}. Run \`bober pge audit-state\`.`);
      return EXIT_FAILED;
    }
    if (result.drift === "content") {
      io.err(
        `State audit out of date: ${result.path} differs from the artifact. Run \`bober pge audit-state\`.`,
      );
      return EXIT_FAILED;
    }
    io.out(`ok ${result.path} (${result.audit.keys.length} channels)`);
    return EXIT_OK;
  }

  io.out(
    `${result.written ? "wrote" : "unchanged"} ${result.path} (${result.audit.keys.length} channels)`,
  );
  return EXIT_OK;
}

// ── optimize ────────────────────────────────────────────────────────

export interface PgeOptimizeOptions {
  graphId?: string;
  /** Base artifact path; defaults to the committed artifact for `graphId`. */
  file?: string;
  /** The candidate topology the mutation produced. */
  variant: string;
  /** Write the variant record. Default true. */
  write?: boolean;
}

/**
 * The optimisation hook at the command line.
 *
 * The MUTATION is supplied as a candidate artifact — there is no search strategy and no
 * scoring model in this sprint (deferred R10) — and this verb does what the hook does:
 * stamp `provenance: "optimizer"`, re-seal the checksum, re-validate, and record the
 * result under `.bober/topology/variants/`, which `dump --check` never inspects.
 */
export async function runPgeOptimize(
  projectRoot: string,
  opts: PgeOptimizeOptions,
  io: PgeIo,
): Promise<number> {
  const base = await loadArtifactSpec(artifactPathFor(projectRoot, opts), io);
  if (!base.ok) return base.exit;
  const candidate = await loadArtifactSpec(opts.variant, io);
  if (!candidate.ok) return candidate.exit;

  const result = optimizeTopology(base.spec, () => candidate.spec);
  const record = buildVariantRecord(base.spec, result);

  if (opts.write !== false) {
    const written = await writeVariantRecord(projectRoot, record);
    io.out(`wrote ${written.path}`);
  }

  io.out(
    `variant ${record.variantId} provenance=${record.provenance} valid=${record.valid} score=${record.score === null ? "null" : String(record.score)}`,
  );

  const errors = reportDiagnostics(result.report, io);
  if (errors > 0) {
    io.err(`variant ${record.variantId}: ${errors} error diagnostic${errors === 1 ? "" : "s"}.`);
    return EXIT_FAILED;
  }
  return EXIT_OK;
}

// ── Commander wiring ────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

function parseMode(raw: string | undefined, io: PgeIo): ValidationMode | undefined {
  if (raw === undefined) return "structural";
  if (raw === "structural" || raw === "full") return raw;
  io.err(`Unknown validation mode "${raw}". Expected "structural" or "full".`);
  return undefined;
}

/** Register the `pge` subcommand on the root program. */
export function registerPgeCommand(program: Command): void {
  const pge = program
    .command("pge")
    .description("Prompt Graph Engineering topology artifacts (.bober/topology/)");

  pge
    .command("dump")
    .description("Serialize the authored topology to .bober/topology/<graphId>.json")
    .option("--graph <id>", "Graph id to dump", CODING_GRAPH_ID)
    .option("--check", "Fail instead of writing when the committed artifact has drifted")
    .action(async (cmdOpts: { graph?: string; check?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeDump(
        await resolveRoot(),
        { graphId: cmdOpts.graph, check: cmdOpts.check },
        io,
      );
    });

  pge
    .command("validate [file]")
    .description("Validate a topology artifact and print every diagnostic code")
    .option("--graph <id>", "Graph id whose committed artifact to validate", CODING_GRAPH_ID)
    .option("--mode <mode>", "structural (default) or full", "structural")
    .action(async (file: string | undefined, cmdOpts: { graph?: string; mode?: string }) => {
      const io = processIo();
      const mode = parseMode(cmdOpts.mode, io);
      if (mode === undefined) {
        process.exitCode = EXIT_USAGE;
        return;
      }
      process.exitCode = await runPgeValidate(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file, mode },
        io,
      );
    });

  pge
    .command("hash [file]")
    .description("Print the topology checksum of the authored literal or of a file")
    .option("--graph <id>", "Graph id whose authored literal to hash", CODING_GRAPH_ID)
    .action(async (file: string | undefined, cmdOpts: { graph?: string }) => {
      const io = processIo();
      process.exitCode = await runPgeHash(await resolveRoot(), { graphId: cmdOpts.graph, file }, io);
    });

  pge
    .command("render [file]")
    .description("Render the committed topology as a mermaid or dot diagram")
    .option("--graph <id>", "Graph id whose committed artifact to render", CODING_GRAPH_ID)
    .option("--format <format>", `Diagram format: ${RENDER_FORMATS.join(" or ")}`, "mermaid")
    .action(async (file: string | undefined, cmdOpts: { graph?: string; format?: string }) => {
      const io = processIo();
      process.exitCode = await runPgeRender(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file, format: cmdOpts.format },
        io,
      );
    });

  pge
    .command("diff <a> <b>")
    .description("Structurally diff two topology artifacts and print JSON")
    .option(
      "--require-version-bump",
      "Exit non-zero when the diff is non-empty and graphVersion did not move forward",
    )
    .action(async (a: string, b: string, cmdOpts: { requireVersionBump?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeDiff(
        await resolveRoot(),
        { a, b, requireVersionBump: cmdOpts.requireVersionBump },
        io,
      );
    });

  pge
    .command("docs <doc>")
    .description("Check a markdown document's pge:nodes block against the committed topology")
    .option("--graph <id>", "Graph id whose committed artifact to check against", CODING_GRAPH_ID)
    .option("--file <path>", "Check against this artifact instead of the committed one")
    .action(async (doc: string, cmdOpts: { graph?: string; file?: string }) => {
      const io = processIo();
      process.exitCode = await runPgeDocs(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file: cmdOpts.file, doc },
        io,
      );
    });

  pge
    .command("audit-state")
    .description("Derive .bober/topology/state-audit.json from the committed topology")
    .option("--graph <id>", "Graph id whose committed artifact to audit", CODING_GRAPH_ID)
    .option("--file <path>", "Audit this artifact instead of the committed one")
    .option("--check", "Fail instead of writing when the committed audit has drifted")
    .action(async (cmdOpts: { graph?: string; file?: string; check?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeAuditState(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file: cmdOpts.file, check: cmdOpts.check },
        io,
      );
    });

  pge
    .command("optimize <variant>")
    .description(
      "Re-validate a candidate topology as an optimizer variant and record it under .bober/topology/variants/",
    )
    .option("--graph <id>", "Graph id the variant was derived from", CODING_GRAPH_ID)
    .option("--file <path>", "Base artifact path instead of the committed one")
    .option("--no-write", "Validate the variant without recording it")
    .action(async (variant: string, cmdOpts: { graph?: string; file?: string; write?: boolean }) => {
      const io = processIo();
      process.exitCode = await runPgeOptimize(
        await resolveRoot(),
        { graphId: cmdOpts.graph, file: cmdOpts.file, variant, write: cmdOpts.write },
        io,
      );
    });
}
