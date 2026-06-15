import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { z } from "zod";

import { ensureDir } from "./helpers.js";

// ── Constants ───────────────────────────────────────────────────────

const BOBER_DIR = ".bober";
const MEMORY_DIR = "memory";
const INDEX_FILE = "INDEX.md";
const QUARANTINE_FILE = "QUARANTINE.md";

// ── Namespace ────────────────────────────────────────────────────────

/**
 * Resolve the memory directory path for the given namespace.
 *
 * Mapping rule (centralized here — do NOT duplicate in callers):
 *   namespace undefined | "" | "programming"  →  .bober/memory/       (current path, no subdir)
 *   any other value                            →  .bober/memory/<ns>/
 *
 * The programming sentinel ("") comes from Sprint 1's built-in team (registry.ts:66).
 * Values are constrained to ^[a-z0-9_-]+$ by the Sprint 1 schema regex, so no
 * path-traversal sanitization is needed here (schema already guards config inputs).
 */
export function memoryDir(projectRoot: string, namespace?: string): string {
  const ns = namespace && namespace !== "programming" ? namespace : undefined;
  return ns
    ? join(projectRoot, BOBER_DIR, MEMORY_DIR, ns)
    : join(projectRoot, BOBER_DIR, MEMORY_DIR);
}

// ── Path Helpers ─────────────────────────────────────────────────────

export function lessonPath(projectRoot: string, lessonId: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), `${lessonId}.md`);
}

export function indexPath(projectRoot: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), INDEX_FILE);
}

export function quarantinePath(projectRoot: string, namespace?: string): string {
  return join(memoryDir(projectRoot, namespace), QUARANTINE_FILE);
}

// ── Quarantine helpers ───────────────────────────────────────────────

/**
 * Move lessonId lines from INDEX.md to QUARANTINE.md (line-level rewrite).
 *
 * - Reads INDEX.md and partitions non-blank lines: those whose second token
 *   (the lessonId) is in `quarantinedIds` are moved; the rest stay.
 * - Rewrites INDEX.md with the kept lines.
 * - Appends the moved lines to QUARANTINE.md (creating it if absent) with a
 *   deterministic provenance block: `<!-- quarantined: <reason> @ <now> -->`.
 * - NEVER touches per-lesson <lessonId>.md files.
 *
 * @param projectRoot - Absolute project root containing .bober/
 * @param quarantinedIds - Set of lessonIds to move out of INDEX.md
 * @param reason - Human-readable reason (e.g. "decay" | "conflict")
 * @param now - ISO 8601 wall-clock, injected by the CLI handler
 * @param namespace - Optional memory namespace
 */
export async function rewriteIndexForQuarantine(
  projectRoot: string,
  quarantinedIds: Set<string>,
  reason: string,
  now: string,
  namespace?: string,
): Promise<void> {
  const idxPath = indexPath(projectRoot, namespace);
  const qPath = quarantinePath(projectRoot, namespace);

  let indexContent: string;
  try {
    indexContent = await readFile(idxPath, "utf-8");
  } catch {
    // INDEX.md absent — nothing to rewrite
    return;
  }

  const allLines = indexContent.split("\n").filter((l) => l.trim().length > 0);

  const keptLines: string[] = [];
  const movedLines: string[] = [];

  for (const line of allLines) {
    const parts = line.split(" ");
    // parts[0] = "-", parts[1] = lessonId
    if (parts[0] === "-" && quarantinedIds.has(parts[1] ?? "")) {
      movedLines.push(line);
    } else {
      keptLines.push(line);
    }
  }

  if (movedLines.length === 0) {
    return;
  }

  // Rewrite INDEX.md with only the kept lines
  await writeFile(
    idxPath,
    keptLines.length > 0 ? keptLines.join("\n") + "\n" : "",
    "utf-8",
  );

  // Append moved lines to QUARANTINE.md with provenance
  await ensureDir(memoryDir(projectRoot, namespace));

  let quarantineContent = "";
  try {
    quarantineContent = await readFile(qPath, "utf-8");
  } catch {
    // QUARANTINE.md does not exist yet — start fresh
  }

  const provenance = `<!-- quarantined: ${reason} @ ${now} -->`;
  const appendBlock = [provenance, ...movedLines].join("\n") + "\n";

  await writeFile(qPath, quarantineContent + appendBlock, "utf-8");
}

// ── Schema ───────────────────────────────────────────────────────────

export const LessonEntrySchema = z.object({
  lessonId: z.string().min(1),
  createdAt: z.string().datetime(),
  category: z.string().min(1),
  tags: z.array(z.string()).default([]),
  summary: z.string().min(1),
  occurrences: z.number().int().positive(),
  severity: z.enum(["info", "warn", "high"]),
  sourceEntryRefs: z.array(z.string().min(1)).min(1),
});

export type LessonEntry = z.infer<typeof LessonEntrySchema>;

export interface LessonIndexRecord {
  lessonId: string;
  category: string;
  severity: string;
  occurrences: number;
  tags: string[];
  summarySnippet: string;
}

// ── Serialization ─────────────────────────────────────────────────────

/**
 * Serialize a LessonEntry to a markdown file with hand-rolled front-matter.
 * Arrays (tags, sourceEntryRefs) are emitted as YAML block sequences.
 */
function serializeLesson(lesson: LessonEntry): string {
  const tagsBlock =
    lesson.tags.length > 0
      ? `tags:\n${lesson.tags.map((t) => `  - ${t}`).join("\n")}`
      : `tags: []`;

  const refsBlock = `sourceEntryRefs:\n${lesson.sourceEntryRefs.map((r) => `  - ${r}`).join("\n")}`;

  const frontMatter = [
    `lessonId: ${lesson.lessonId}`,
    `createdAt: ${lesson.createdAt}`,
    `category: ${lesson.category}`,
    tagsBlock,
    `summary: ${lesson.summary}`,
    `occurrences: ${lesson.occurrences}`,
    `severity: ${lesson.severity}`,
    refsBlock,
  ].join("\n");

  const body = `Lesson: ${lesson.lessonId}\n\nCategory: ${lesson.category}\nSeverity: ${lesson.severity}\nOccurrences: ${lesson.occurrences}\n\nSummary:\n${lesson.summary}\n\nSource References:\n${lesson.sourceEntryRefs.map((r) => `- ${r}`).join("\n")}\n`;

  return `---\n${frontMatter}\n---\n\n${body}`;
}

/**
 * Build a single INDEX.md line for a lesson, following the MEMORY.md curated-index format:
 * - <lessonId> [<category>/<severity>] (x<occurrences>) tags: a,b — <summary first 80 chars>
 */
function buildIndexLine(lesson: LessonEntry): string {
  const tagsStr = lesson.tags.length > 0 ? lesson.tags.join(",") : "";
  const snippet = lesson.summary.slice(0, 80);
  const tagsSegment = tagsStr ? `tags: ${tagsStr}` : `tags:`;
  return `- ${lesson.lessonId} [${lesson.category}/${lesson.severity}] (x${lesson.occurrences}) ${tagsSegment} — ${snippet}`;
}

/**
 * Parse a single INDEX.md line into a LessonIndexRecord.
 * Returns null for lines that do not match the expected format.
 */
function parseIndexLine(line: string): LessonIndexRecord | null {
  // Expected: - <lessonId> [<category>/<severity>] (x<occurrences>) tags: a,b — <snippet>
  const match = line.match(
    /^- (\S+) \[([^/\]]+)\/([^\]]+)\] \(x(\d+)\) tags: ([^—]*)— (.*)$/,
  );
  if (!match) return null;

  const [, lessonId, category, severity, occStr, tagsRaw, summarySnippet] = match;
  const tags = tagsRaw.trim()
    ? tagsRaw
        .trim()
        .split(",")
        .map((t) => t.trim())
        .filter(Boolean)
    : [];

  return {
    lessonId: lessonId.trim(),
    category: category.trim(),
    severity: severity.trim(),
    occurrences: Number(occStr),
    tags,
    summarySnippet: summarySnippet.trim(),
  };
}

/**
 * Parse the front-matter block from a lesson markdown file.
 * Uses the hand-rolled regex approach from src/orchestrator/agent-loader.ts.
 * Returns null if the file does not have the expected front-matter delimiters.
 */
function parseLessonFrontMatter(
  raw: string,
): Record<string, string | string[]> | null {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) return null;

  const [, yamlBlock] = match;
  const meta: Record<string, string | string[]> = {};

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();

    // Block sequence item (e.g. "  - value")
    if (line.startsWith("  - ") && currentKey !== null && currentList !== null) {
      currentList.push(line.slice(4).trim());
      continue;
    }

    // Flush any pending list on a new key
    if (currentKey !== null && currentList !== null && !line.startsWith("  ")) {
      meta[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    if (trimmed.length === 0) continue;

    // Key: value or Key: (block sequence start)
    const kvMatch = trimmed.match(/^([\w-]+):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, value] = kvMatch;

    if (value === "[]") {
      // Explicit empty array
      meta[key] = [];
      continue;
    }

    if (!value) {
      // Start of a block sequence
      currentKey = key;
      currentList = [];
      continue;
    }

    // Scalar value
    meta[key] = value;
  }

  // Flush trailing list
  if (currentKey !== null && currentList !== null) {
    meta[currentKey] = currentList;
  }

  return meta;
}

// ── Persistence ──────────────────────────────────────────────────────

/**
 * Append (or update) a lesson to the .bober/memory/ store.
 * Writes <lessonId>.md with hand-rolled front-matter plus a human body.
 * Upserts exactly one INDEX.md line for this lessonId (replace if exists, else append).
 * Throws if the lesson fails schema validation (sourceEntryRefs must be non-empty).
 */
export async function appendLesson(
  projectRoot: string,
  lesson: LessonEntry,
  namespace?: string,
): Promise<void> {
  const validation = LessonEntrySchema.safeParse(lesson);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid lesson entry:\n${issues}`);
  }

  const dir = memoryDir(projectRoot, namespace);
  await ensureDir(dir);

  // Write the lesson markdown file
  await writeFile(lessonPath(projectRoot, lesson.lessonId, namespace), serializeLesson(lesson), "utf-8");

  // Upsert one INDEX.md line for this lessonId
  const idxPath = indexPath(projectRoot, namespace);
  let existingContent = "";
  try {
    existingContent = await readFile(idxPath, "utf-8");
  } catch {
    // INDEX.md does not exist yet — treat as empty
  }

  const lines = existingContent.split("\n").filter((l) => l.trim().length > 0);
  // Drop any prior line for this lessonId (match leading "- <lessonId> " token)
  const filtered = lines.filter((l) => {
    const parts = l.split(" ");
    // parts[0] = "-", parts[1] = lessonId
    return !(parts[0] === "-" && parts[1] === lesson.lessonId);
  });
  filtered.push(buildIndexLine(lesson));

  await writeFile(idxPath, filtered.join("\n") + "\n", "utf-8");
}

// ── Read ─────────────────────────────────────────────────────────────

/**
 * Load at most `limit` lesson index records from INDEX.md.
 * Never opens individual lesson files — parses only INDEX.md.
 * Returns an empty array if INDEX.md does not exist.
 */
export async function loadLessonIndex(
  projectRoot: string,
  { limit }: { limit: number },
  namespace?: string,
): Promise<LessonIndexRecord[]> {
  let content: string;
  try {
    content = await readFile(indexPath(projectRoot, namespace), "utf-8");
  } catch {
    // INDEX.md does not exist yet
    return [];
  }

  const lines = content.split("\n").filter((l) => l.trim().length > 0);
  const records: LessonIndexRecord[] = [];

  for (const line of lines) {
    const record = parseIndexLine(line);
    if (record !== null) {
      records.push(record);
    }
  }

  return records.slice(-limit);
}

/**
 * Load a single lesson by ID from its <lessonId>.md file.
 * Parses front-matter and validates against LessonEntrySchema.
 * Throws a descriptive error if the file does not exist or fails validation.
 */
export async function loadLesson(
  projectRoot: string,
  lessonId: string,
  namespace?: string,
): Promise<LessonEntry> {
  let raw: string;
  try {
    raw = await readFile(lessonPath(projectRoot, lessonId, namespace), "utf-8");
  } catch {
    throw new Error(`Lesson not found: ${lessonId} (path: ${lessonPath(projectRoot, lessonId, namespace)})`);
  }

  const meta = parseLessonFrontMatter(raw);
  if (meta === null) {
    throw new Error(`Lesson file for ${lessonId} has no valid front-matter`);
  }

  // Reconstruct lesson object from parsed meta — coerce numeric fields
  const candidate: Record<string, unknown> = {
    lessonId: meta["lessonId"],
    createdAt: meta["createdAt"],
    category: meta["category"],
    tags: meta["tags"] ?? [],
    summary: meta["summary"],
    occurrences: Number(meta["occurrences"]),
    severity: meta["severity"],
    sourceEntryRefs: meta["sourceEntryRefs"],
  };

  const result = LessonEntrySchema.safeParse(candidate);
  if (!result.success) {
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Lesson file for ${lessonId} failed validation:\n${issues}`);
  }

  return result.data;
}
