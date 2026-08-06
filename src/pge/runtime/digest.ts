import { readdir } from "node:fs/promises";
import { join } from "node:path";

import { z } from "zod";

import { AgentRoleSchema, DecisionSchema } from "../../orchestrator/context-handoff.js";
import type { AgentRole, Decision } from "../../orchestrator/context-handoff.js";
import { PhaseSchema } from "../../state/history.js";
import type { Phase } from "../../state/history.js";
import { ScratchRefSchema } from "../state/overall.js";
import type { ScratchRef } from "../state/overall.js";
import {
  ARCHIVE_OUTPUTS_FILE,
  ARCHIVE_SEALED_MARKER,
  ARCHIVE_SNAPSHOT_FILE,
  ARCHIVE_STDOUT_FILE,
  ARCHIVE_BRANCH_SEPARATOR,
  archiveNodeDir,
  archiveRunDir,
} from "./archive.js";
import { assertSafePathSegment, atomicWriteFile, readIfPresent } from "./scratch.js";
import type { FileRead } from "./scratch.js";
import type { TokenEstimator } from "./token-estimator.js";

/**
 * The Engram phase digest: `.bober/handoff/<phase>-digest.md`.
 *
 * When a phase terminates, the terminating agent distills what the phase LEARNED — high
 * level insights, the modelling choices that worked, what to do next, and specific
 * failure diagnoses — into one small markdown file. The successor then launches from that
 * file (see `handoff.ts`) rather than from the predecessor's transcript.
 *
 * ── `.bober/handoff/` is NOT `.bober/handoffs/` ──
 *
 * The repository already contains a plural `.bober/handoffs/` directory, referenced by
 * `skills/bober.run/SKILL.md` and written by the skill-driven orchestrator, never by
 * TypeScript. It holds `ContextHandoff` JSON documents for the imperative pipeline. This
 * module owns the SINGULAR `.bober/handoff/`, holding per-phase markdown digests for the
 * graph runtime. They are different artifacts with different producers and different
 * lifetimes; merging them would corrupt both.
 *
 * ── Why the vocabulary is borrowed rather than invented ──
 *
 * `modellingChoices` is an array of the EXISTING `Decision` from
 * `src/orchestrator/context-handoff.ts` — `{timestamp, description, rationale, madeBy}` —
 * because the contract's own assumption says the Zod-typed shapes there are the model for
 * this digest rather than a new vocabulary, and because `description` + `rationale` is
 * already the pattern {@link DiagnosisSchema}'s `hypothesis` + `evidence` follows.
 *
 * ── A missing digest is a failure ──
 *
 * {@link readDigest} distinguishes "absent" from "unreadable" (via `FileRead`, whose
 * doc-comment in `scratch.ts` explains why collapsing them is a data-loss bug) and raises
 * a distinct error for each, plus a third for a file that is present and does not parse.
 * There is no fourth branch. Nothing in this module or in `handoff.ts` falls back to the
 * predecessor's raw transcript, under any condition — that is an explicit non-goal, and
 * the reason the fallback cannot exist is that {@link readDigest} is the only way to
 * obtain the value `assembleSuccessorPrompt` requires.
 */

// ── Diagnosis ───────────────────────────────────────────────────────

/**
 * One specific failure diagnosis.
 *
 * `hypothesis` and `evidence` are BOTH required and BOTH `.min(1)`. That pair is what
 * makes a temporarily-regressing direction survivable: a bare number says a run got
 * worse, and only a hypothesis with its evidence says why that is worth keeping.
 *
 * `score` is present in the schema precisely so a score-only payload can be CONSTRUCTED
 * and then REJECTED with the two missing paths named (sc-10-3). A shape that simply had
 * no `score` field would reject such a payload for the wrong reason.
 *
 * `evidenceRef` points at bulk evidence in the scratch store, so a megabyte of failing
 * output never inflates the digest past {@link DIGEST_TOKEN_CEILING}.
 */
export const DiagnosisSchema = z.object({
  hypothesis: z.string().min(1),
  evidence: z.string().min(1),
  evidenceRef: ScratchRefSchema.optional(),
  score: z.number().optional(),
});
export type Diagnosis = z.infer<typeof DiagnosisSchema>;

// ── Digest ──────────────────────────────────────────────────────────

/**
 * The four required sections, each non-empty at BOTH levels.
 *
 * `.min(1)` on the array rejects a missing or empty section; `.min(1)` on the element
 * rejects a section that is present, non-empty, and full of blanks. Both are needed:
 * `insights: [""]` is exactly as useless as `insights: []` and a validator that accepted
 * it would let an empty digest through with a green schema check.
 */
export const PhaseDigestSchema = z.object({
  phase: PhaseSchema,
  runId: z.string().min(1),
  createdAt: z.string().datetime(),
  insights: z.array(z.string().min(1)).min(1),
  modellingChoices: z.array(DecisionSchema).min(1),
  nextSteps: z.array(z.string().min(1)).min(1),
  diagnoses: z.array(DiagnosisSchema).min(1),
});
export type PhaseDigest = z.infer<typeof PhaseDigestSchema>;

/**
 * The same shape before validation — what a distiller produces.
 *
 * Separate from {@link PhaseDigest} so `distillFromArchive` can honestly return "the
 * archive yielded no diagnoses" instead of fabricating one to satisfy `.min(1)`. The
 * emptiness then surfaces at {@link writeDigest}, as a named Zod path.
 */
export interface PhaseDigestDraft {
  phase: Phase;
  runId: string;
  createdAt: string;
  insights: string[];
  modellingChoices: Decision[];
  nextSteps: string[];
  diagnoses: Diagnosis[];
}

/**
 * The pinned ceiling, in estimated tokens, for a rendered digest.
 *
 * A digest exists to be cheap enough that a successor can read it first, unconditionally.
 * The number is enforced by {@link writeDigest} against the CALLER'S estimator, so a
 * project that later plugs in a real tokenizer gets the ceiling measured by that
 * tokenizer without any call site changing.
 */
export const DIGEST_TOKEN_CEILING = 2000;

// ── Layout ──────────────────────────────────────────────────────────

/** `.bober/handoff/` for a project root. Singular — see the module comment. */
export function digestRoot(projectRoot: string): string {
  return join(projectRoot, ".bober", "handoff");
}

/** `.bober/handoff/<phase>-digest.md`. */
export function digestPath(projectRoot: string, phase: Phase): string {
  assertSafePathSegment("phase", phase);
  return join(digestRoot(projectRoot), `${phase}-digest.md`);
}

// ── Errors ──────────────────────────────────────────────────────────

/** The digest file is not there. Never a reason to read the transcript instead. */
export class DigestMissingError extends Error {
  readonly path: string;
  readonly phase: Phase;

  constructor(path: string, phase: Phase) {
    super(
      `No digest for phase "${phase}" at "${path}". The successor's context is built from the digest and there is no fallback to the predecessor transcript.`,
    );
    this.name = "DigestMissingError";
    this.path = path;
    this.phase = phase;
  }
}

/**
 * The digest file may well exist and could not be read.
 *
 * A DIFFERENT fact from {@link DigestMissingError} with a different remedy, kept distinct
 * for the reason `FileRead` exists at all: "create it" is wrong advice for an `EACCES`.
 */
export class DigestUnreadableError extends Error {
  readonly path: string;
  readonly code: string;

  constructor(path: string, code: string, detail: string) {
    super(`Digest at "${path}" could not be read (${code}): ${detail}`);
    this.name = "DigestUnreadableError";
    this.path = path;
    this.code = code;
  }
}

/**
 * The digest is present and does not validate.
 *
 * `issues` renders as `path.join(".")`: message, the same formatter
 * `deserializeHandoff` uses in `src/orchestrator/context-handoff.ts`, so the FAILING PATH
 * is in the message rather than only in a caught object.
 */
export class DigestInvalidError extends Error {
  readonly source: string;
  readonly issues: readonly string[];
  readonly paths: readonly string[];

  constructor(source: string, issues: readonly string[], paths: readonly string[]) {
    super(`Invalid digest (${source}):\n${issues.join("\n")}`);
    this.name = "DigestInvalidError";
    this.source = source;
    this.issues = issues;
    this.paths = paths;
  }
}

/** A field the line-oriented markdown grammar cannot represent without ambiguity. */
export class DigestUnrenderableError extends Error {
  readonly field: string;

  constructor(field: string, reason: string) {
    super(`Digest field "${field}" cannot be rendered: ${reason}`);
    this.name = "DigestUnrenderableError";
    this.field = field;
  }
}

/** The rendered digest is over {@link DIGEST_TOKEN_CEILING}, measured by the caller's estimator. */
export class DigestTooLargeError extends Error {
  readonly tokens: number;
  readonly ceiling: number;
  readonly estimatorId: string;

  constructor(tokens: number, ceiling: number, estimatorId: string) {
    super(
      `Digest estimates to ${String(tokens)} tokens under estimator "${estimatorId}", above the ceiling of ${String(ceiling)}. Move bulk evidence to a ScratchRef.`,
    );
    this.name = "DigestTooLargeError";
    this.tokens = tokens;
    this.ceiling = ceiling;
    this.estimatorId = estimatorId;
  }
}

function invalid(source: string, error: z.ZodError): DigestInvalidError {
  const paths = error.issues.map((issue) => issue.path.join("."));
  const issues = error.issues.map(
    (issue, index) => `  - ${paths[index] === "" ? "<root>" : paths[index]}: ${issue.message}`,
  );
  return new DigestInvalidError(source, issues, paths);
}

// ── Markdown grammar ────────────────────────────────────────────────

/**
 * The four `##` headings, in render order.
 *
 * Exported so a test can assert the written file carries all four rather than
 * re-hardcoding the strings and passing against a renderer that emits none of them.
 */
export const DIGEST_SECTION_HEADINGS = [
  "## Insights",
  "## Modelling choices",
  "## Next steps",
  "## Diagnoses",
] as const;

const [H_INSIGHTS, H_CHOICES, H_NEXT_STEPS, H_DIAGNOSES] = DIGEST_SECTION_HEADINGS;

/** Separates the four fields of a rendered {@link Decision} on one line. */
const CHOICE_SEPARATOR = " :: ";

const HEADER_PATTERN =
  /^<!-- engram:v1 phase=(\S+) runId=(\S+) createdAt=(\S+) -->$/;

/**
 * Reject a value the one-line grammar would mangle.
 *
 * The grammar is line-oriented on purpose — a digest is meant to be read by a human in a
 * diff — so a field carrying a newline or the reserved separator would round-trip to
 * something other than itself. Refusing loudly at render time is the alternative to
 * discovering it at parse time on the successor's side, where the only available response
 * is to fail the handoff.
 */
function assertRenderable(field: string, value: string, checkSeparator = false): void {
  if (value.includes("\n") || value.includes("\r")) {
    throw new DigestUnrenderableError(field, "it contains a line break");
  }
  if (checkSeparator && value.includes(CHOICE_SEPARATOR)) {
    throw new DigestUnrenderableError(
      field,
      `it contains the reserved separator "${CHOICE_SEPARATOR}"`,
    );
  }
}

function renderScratchRef(ref: ScratchRef): string {
  return `${ref.uri} ${ref.sha256} ${String(ref.bytes)} ${ref.kind}`;
}

/**
 * A digest as deterministic markdown.
 *
 * Deterministic in the strong sense: the same value renders to the same bytes on every
 * platform and in every process, because nothing here reads a clock, a locale or a
 * randomness source. That is what makes {@link parseDigest} a genuine inverse and what
 * makes a digest diffable across runs.
 */
export function renderDigest(digest: PhaseDigest): string {
  const lines: string[] = [];
  lines.push(`# Phase digest — ${digest.phase}`, "");
  lines.push(
    `<!-- engram:v1 phase=${digest.phase} runId=${digest.runId} createdAt=${digest.createdAt} -->`,
    "",
  );

  lines.push(H_INSIGHTS, "");
  for (const [index, insight] of digest.insights.entries()) {
    assertRenderable(`insights.${String(index)}`, insight);
    lines.push(`- ${insight}`);
  }
  lines.push("");

  lines.push(H_CHOICES, "");
  for (const [index, choice] of digest.modellingChoices.entries()) {
    assertRenderable(`modellingChoices.${String(index)}.description`, choice.description, true);
    assertRenderable(`modellingChoices.${String(index)}.rationale`, choice.rationale, true);
    lines.push(
      `- ${choice.description}${CHOICE_SEPARATOR}${choice.rationale}${CHOICE_SEPARATOR}${choice.madeBy}${CHOICE_SEPARATOR}${choice.timestamp}`,
    );
  }
  lines.push("");

  lines.push(H_NEXT_STEPS, "");
  for (const [index, step] of digest.nextSteps.entries()) {
    assertRenderable(`nextSteps.${String(index)}`, step);
    lines.push(`- ${step}`);
  }
  lines.push("");

  lines.push(H_DIAGNOSES, "");
  for (const [index, diagnosis] of digest.diagnoses.entries()) {
    assertRenderable(`diagnoses.${String(index)}.hypothesis`, diagnosis.hypothesis);
    assertRenderable(`diagnoses.${String(index)}.evidence`, diagnosis.evidence);
    lines.push(`- hypothesis: ${diagnosis.hypothesis}`);
    lines.push(`  evidence: ${diagnosis.evidence}`);
    if (diagnosis.evidenceRef !== undefined) {
      lines.push(`  evidenceRef: ${renderScratchRef(diagnosis.evidenceRef)}`);
    }
    if (diagnosis.score !== undefined) lines.push(`  score: ${String(diagnosis.score)}`);
  }
  lines.push("");

  return lines.join("\n");
}

function sectionLines(all: readonly string[], heading: string): string[] {
  const start = all.indexOf(heading);
  if (start === -1) return [];
  const body: string[] = [];
  for (let i = start + 1; i < all.length; i += 1) {
    const line = all[i];
    if (line.startsWith("## ")) break;
    body.push(line);
  }
  return body;
}

function bulletTexts(lines: readonly string[]): string[] {
  return lines.filter((line) => line.startsWith("- ")).map((line) => line.slice(2));
}

function parseChoices(lines: readonly string[]): unknown[] {
  return bulletTexts(lines).map((text) => {
    const parts = text.split(CHOICE_SEPARATOR);
    // Four fields; anything else is handed to Zod as-is so the failure names the field
    // rather than being swallowed by a hand-written "malformed line" message.
    return {
      description: parts[0],
      rationale: parts[1],
      madeBy: parts[2],
      timestamp: parts[3],
    };
  });
}

function parseScratchRef(text: string): unknown {
  const [uri, sha256, bytes, kind] = text.trim().split(/\s+/);
  return { uri, sha256, bytes: Number(bytes), kind };
}

function parseDiagnoses(lines: readonly string[]): unknown[] {
  const out: Record<string, unknown>[] = [];
  for (const line of lines) {
    if (line.startsWith("- hypothesis: ")) {
      out.push({ hypothesis: line.slice("- hypothesis: ".length) });
      continue;
    }
    const current = out.at(-1);
    if (current === undefined) continue;
    if (line.startsWith("  evidence: ")) current.evidence = line.slice("  evidence: ".length);
    else if (line.startsWith("  evidenceRef: ")) {
      current.evidenceRef = parseScratchRef(line.slice("  evidenceRef: ".length));
    } else if (line.startsWith("  score: ")) {
      current.score = Number(line.slice("  score: ".length));
    }
  }
  return out;
}

/**
 * The inverse of {@link renderDigest}, validated.
 *
 * Every failure — a missing header, a missing section, an empty section, a malformed
 * decision line — arrives as a {@link DigestInvalidError} carrying the Zod paths, because
 * the parser's job is to assemble a candidate object and hand it to the SAME schema
 * `writeDigest` used. A parser that decided for itself what was acceptable would be a
 * second, drifting validator.
 */
export function parseDigest(markdown: string, source = "<memory>"): PhaseDigest {
  const lines = markdown.split("\n").map((line) => line.replace(/\r$/, ""));
  const header = lines.map((line) => HEADER_PATTERN.exec(line)).find((m) => m !== null);

  const candidate = {
    phase: header?.[1],
    runId: header?.[2],
    createdAt: header?.[3],
    insights: bulletTexts(sectionLines(lines, H_INSIGHTS)),
    modellingChoices: parseChoices(sectionLines(lines, H_CHOICES)),
    nextSteps: bulletTexts(sectionLines(lines, H_NEXT_STEPS)),
    diagnoses: parseDiagnoses(sectionLines(lines, H_DIAGNOSES)),
  };

  const result = PhaseDigestSchema.safeParse(candidate);
  if (!result.success) throw invalid(source, result.error);
  return result.data;
}

// ── Read / write ────────────────────────────────────────────────────

export interface WrittenDigest {
  readonly path: string;
  readonly tokens: number;
  readonly markdown: string;
  readonly estimatorId: string;
}

/**
 * Validate, render, measure, and write `.bober/handoff/<phase>-digest.md`.
 *
 * In that order, and the order is the point. A draft that is missing a section never
 * reaches the disk, so a digest file existing is itself evidence that four non-empty
 * sections existed — which is what lets `readDigest` treat a parse failure as corruption
 * rather than as an expected shape.
 *
 * The write is `atomicWriteFile` (temp + rename), shared with the archive, cache and
 * trace stores, so a crash mid-write cannot leave a successor reading half a digest.
 */
export async function writeDigest(
  projectRoot: string,
  draft: PhaseDigestDraft | PhaseDigest,
  estimator: TokenEstimator,
  options: { ceiling?: number } = {},
): Promise<WrittenDigest> {
  const parsed = PhaseDigestSchema.safeParse(draft);
  if (!parsed.success) throw invalid("<draft>", parsed.error);
  const markdown = renderDigest(parsed.data);
  const tokens = estimator.estimate(markdown);
  const ceiling = options.ceiling ?? DIGEST_TOKEN_CEILING;
  if (tokens > ceiling) throw new DigestTooLargeError(tokens, ceiling, estimator.id);
  const path = digestPath(projectRoot, parsed.data.phase);
  await atomicWriteFile(path, markdown);
  return { path, tokens, markdown, estimatorId: estimator.id };
}

/**
 * Read and validate the digest for a phase. FAILS CLOSED, three ways, with no fourth.
 *
 * There is deliberately no `readDigestIfPresent`. Offering one would create the call site
 * the non-goal forbids: "a missing digest is a failure, not a reason to fall back to the
 * transcript" is only enforceable if the absent case has no value-returning form.
 */
export async function readDigest(projectRoot: string, phase: Phase): Promise<PhaseDigest> {
  const path = digestPath(projectRoot, phase);
  const read = await readIfPresent(path);
  if (read.kind === "absent") throw new DigestMissingError(path, phase);
  if (read.kind === "unreadable") throw new DigestUnreadableError(path, read.code, read.message);
  return parseDigest(read.text, path);
}

// ── Selection ───────────────────────────────────────────────────────

/** One run under consideration, with whatever digest it produced. */
export interface RunCandidate {
  readonly id: string;
  readonly score: number;
  readonly digest: PhaseDigest | null;
}

export interface SelectionPolicy {
  /** Scores at or above this survive on the score alone. Default {@link DEFAULT_SELECTION_MIN_SCORE}. */
  minScore?: number;
}

export const DEFAULT_SELECTION_MIN_SCORE = 0.5;

/** True when at least one diagnosis carries BOTH a hypothesis and its evidence. */
export function hasEvidencedDiagnosis(digest: PhaseDigest | null): boolean {
  if (digest === null) return false;
  return digest.diagnoses.some(
    (d) => d.hypothesis.trim().length > 0 && d.evidence.trim().length > 0,
  );
}

/**
 * Which candidates survive a selection round.
 *
 * ── The rule, and why it is not "keep the best score" ──
 *
 * A run survives if its score clears `minScore` OR if its digest records at least one
 * evidence-backed diagnosis. The second clause is the whole of this criterion: a
 * strategically better direction very often scores WORSE on the round that discovers why
 * the previous direction was wrong, and pruning it on the number alone deletes the only
 * artifact that explains the regression. A bare number cannot carry a reason; a
 * hypothesis with its evidence can, and only that pair earns the reprieve.
 *
 * A candidate with neither — a low score and nothing to say about it — IS pruned. Without
 * that branch the function would be the identity, and any test of it would be vacuous.
 */
export function selectSurvivors(
  candidates: readonly RunCandidate[],
  policy: SelectionPolicy = {},
): RunCandidate[] {
  const minScore = policy.minScore ?? DEFAULT_SELECTION_MIN_SCORE;
  return candidates.filter(
    (candidate) => candidate.score >= minScore || hasEvidencedDiagnosis(candidate.digest),
  );
}

// ── Distillation from sealed archives ───────────────────────────────

/** What one sealed archive directory holds. Every file may legitimately be absent. */
export interface ArchiveReading {
  readonly nodeId: string;
  readonly branchKey: string | null;
  readonly dir: string;
  readonly sealed: boolean;
  readonly snapshot: FileRead;
  readonly stdout: FileRead;
  readonly outputs: FileRead;
}

/**
 * The `(nodeId, branchKey)` pairs `.bober/archive/<runId>/` records, sorted.
 *
 * `readdir` only. Opening an {@link ArchiveHandle} to enumerate would CREATE the directory
 * and its three placeholder files (`archive.ts`'s `open`), fabricating an archive for a
 * node that never ran — which would silently break the "one directory per executed node"
 * property this whole layer is downstream of.
 */
export async function listArchivedNodes(
  projectRoot: string,
  runId: string,
): Promise<Array<{ nodeId: string; branchKey: string | null }>> {
  let leaves: string[];
  try {
    leaves = await readdir(archiveRunDir(projectRoot, runId));
  } catch {
    return [];
  }
  return leaves.sort().map((leaf) => {
    const at = leaf.indexOf(ARCHIVE_BRANCH_SEPARATOR);
    return at === -1
      ? { nodeId: leaf, branchKey: null }
      : { nodeId: leaf.slice(0, at), branchKey: leaf.slice(at + 1) };
  });
}

/** Read one archived node's three files WITHOUT opening a writer against it. */
export async function readArchivedNode(
  projectRoot: string,
  runId: string,
  nodeId: string,
  branchKey: string | null,
): Promise<ArchiveReading> {
  const dir = archiveNodeDir(projectRoot, runId, nodeId, branchKey);
  const [snapshot, stdout, outputs, marker] = await Promise.all([
    readIfPresent(join(dir, ARCHIVE_SNAPSHOT_FILE)),
    readIfPresent(join(dir, ARCHIVE_STDOUT_FILE)),
    readIfPresent(join(dir, ARCHIVE_OUTPUTS_FILE)),
    readIfPresent(join(dir, ARCHIVE_SEALED_MARKER)),
  ]);
  return { nodeId, branchKey, dir, sealed: marker.kind === "present", snapshot, stdout, outputs };
}

/** Every archived node of a run, read in sorted leaf order. */
export async function readRunArchive(
  projectRoot: string,
  runId: string,
): Promise<ArchiveReading[]> {
  const nodes = await listArchivedNodes(projectRoot, runId);
  const out: ArchiveReading[] = [];
  for (const node of nodes) {
    out.push(await readArchivedNode(projectRoot, runId, node.nodeId, node.branchKey));
  }
  return out;
}

export interface DistillOptions {
  phase: Phase;
  runId: string;
  /** Injected, so a distilled digest is byte-stable in a test. */
  now: () => Date;
  /**
   * The one section an archive cannot supply.
   *
   * An archive is a record of what HAPPENED. "What to do next" is a judgement the
   * terminating agent makes, so it is an input here rather than something invented from
   * stdout — a distiller that guessed it would be writing fiction into the successor's
   * only source of truth.
   */
  nextSteps: readonly string[];
  madeBy?: AgentRole;
  /** Lines matching this become diagnoses. Default: the usual failure words. */
  errorPattern?: RegExp;
}

const DEFAULT_ERROR_PATTERN = /\b(error|failed|failure|exception)\b/i;

function leafOf(reading: ArchiveReading): string {
  return reading.branchKey === null
    ? reading.nodeId
    : `${reading.nodeId}${ARCHIVE_BRANCH_SEPARATOR}${reading.branchKey}`;
}

function outputKeys(read: FileRead): string[] {
  if (read.kind !== "present") return [];
  try {
    const value: unknown = JSON.parse(read.text);
    if (typeof value !== "object" || value === null || Array.isArray(value)) return [];
    return Object.keys(value).sort();
  } catch {
    return [];
  }
}

/**
 * Build a digest draft by READING the run's sealed archives.
 *
 * Strictly read-only: `readIfPresent` on the three known filenames, never `open()`, never
 * a write of any kind, and the `.sealed` marker is only ever inspected. The archive is the
 * raw material this layer distils and nothing downstream may rewrite the history it is
 * summarising.
 *
 * Returns a DRAFT. If the archive contains no failure evidence the `diagnoses` array comes
 * back empty and {@link writeDigest} refuses it by schema, naming `diagnoses` as the
 * failing path. That is the intended behaviour: a phase that cannot say what went wrong
 * has not finished thinking, and inventing a placeholder diagnosis to get past the
 * validator would defeat the entire selection rule above.
 */
export async function distillFromArchive(
  projectRoot: string,
  options: DistillOptions,
): Promise<PhaseDigestDraft> {
  const readings = await readRunArchive(projectRoot, options.runId);
  const timestamp = options.now().toISOString();
  const madeBy = options.madeBy ?? AgentRoleSchema.parse("generator");
  const pattern = options.errorPattern ?? DEFAULT_ERROR_PATTERN;

  const insights: string[] = [];
  const modellingChoices: Decision[] = [];
  const diagnoses: Diagnosis[] = [];

  for (const reading of readings) {
    const leaf = leafOf(reading);
    const keys = outputKeys(reading.outputs);
    insights.push(
      keys.length === 0
        ? `${leaf} archived no structured outputs.`
        : `${leaf} produced outputs: ${keys.join(", ")}.`,
    );
    modellingChoices.push({
      timestamp,
      description: `Ran node ${leaf} and archived it to ${reading.sealed ? "a sealed" : "an unsealed"} directory.`,
      rationale: `Distilled from ${reading.dir}; the archive is the raw material and was not modified.`,
      madeBy,
    });
    if (reading.stdout.kind !== "present") continue;
    for (const line of reading.stdout.text.split("\n")) {
      const trimmed = line.trim();
      if (trimmed.length === 0 || !pattern.test(trimmed)) continue;
      diagnoses.push({
        hypothesis: `${leaf} did not complete cleanly.`,
        evidence: trimmed,
      });
    }
  }

  return {
    phase: options.phase,
    runId: options.runId,
    createdAt: timestamp,
    insights,
    modellingChoices,
    nextSteps: [...options.nextSteps],
    diagnoses,
  };
}
