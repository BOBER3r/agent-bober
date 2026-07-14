/**
 * Research digest builder — aggregates in-window research runs into a
 * dual markdown+JSON artifact for the Telegram bot (sibling spec) to push.
 *
 * Clock discipline: `now`/`since` are injected ISO strings — never new Date() here.
 * Non-sensitive summary content only (titles/summaries; no raw body values).
 *
 * bober: collectRunsFromVault reads vault research notes (1:1 dated artifacts)
 *        rather than hub Findings (content-deduped, historyless, path-less).
 *        Swap if a dedicated digest store is ever introduced.
 */

import { join } from "node:path";
import { writeFile } from "node:fs/promises";

import { ensureDir } from "../state/helpers.js";
import { listNotes, readNote } from "../vault/note-io.js";

// ── Types ─────────────────────────────────────────────────────────────

/** One research run entry in a digest. */
export interface DigestRun {
  /** Job title — note frontmatter.title ("Research — <question>"). */
  title: string;
  /** Non-sensitive one-line summary derived from frontmatter.question/title only. */
  topFinding: string;
  /** ISO — note frontmatter.generatedAt. */
  generatedAt: string;
  /** Absolute note path — the source artifact link. */
  source: string;
}

/** The full digest structure written to both .md and .json. */
export interface Digest {
  since: string;
  now: string;
  generatedAt: string; // = now
  runs: DigestRun[];
}

/** Injectable dependencies for buildDigest — keeps it testable without real vault. */
export interface DigestDeps {
  /** Injected collector — returns in-window runs. Fake in unit tests; real in CLI. */
  collectRuns: (since: string, now: string) => Promise<DigestRun[]>;
  /**
   * Absolute path to the digests directory.
   * e.g. <root>/.bober/research/digests — injected; temp dir in tests.
   */
  digestsDir: string;
}

// ── Pure markdown render ──────────────────────────────────────────────

/**
 * Render a Digest into a markdown string.
 *
 * PURE: no IO, no Date.now(), no side effects.
 * Mirrors src/hub/priority-md.ts: builds lines[] then joins with "\n".
 *
 * Empty-window rule (sc-5-3): when runs.length === 0, the body explicitly
 * states no new research was produced in the window.
 */
export function renderDigestMarkdown(digest: Digest): string {
  const lines: string[] = [];
  lines.push("# Research Digest");
  lines.push("");
  lines.push(`**Window:** ${digest.since} → ${digest.now}`);
  lines.push(`**Generated:** ${digest.generatedAt}`);
  lines.push("");

  if (digest.runs.length === 0) {
    lines.push("_No new research was produced in this window._");
    lines.push("");
    return lines.join("\n");
  }

  lines.push(`**Runs:** ${digest.runs.length}`);
  lines.push("");

  for (const run of digest.runs) {
    lines.push(`- **${run.title}** — ${run.topFinding} ([source](${run.source}))`);
  }

  lines.push("");
  return lines.join("\n");
}

// ── buildDigest: collect → render both → write both ──────────────────

/**
 * Collect in-window research runs via deps.collectRuns, render both markdown
 * and JSON artifacts, write them to deps.digestsDir, and return the result.
 *
 * File naming: `now.slice(0, 10)` → YYYY-MM-DD (matches note-writer.ts:24).
 * JSON format: JSON.stringify(digest, null, 2) + "\n" (mirrors fleet/index.ts:69).
 *
 * Empty window: still writes both files with an explicit no-new-research body.
 * Never throws on empty collectRuns — caller receives both paths.
 */
export async function buildDigest(
  since: string,
  now: string,
  deps: DigestDeps,
): Promise<{ digest: Digest; mdPath: string; jsonPath: string }> {
  const runs = await deps.collectRuns(since, now);
  const digest: Digest = { since, now, generatedAt: now, runs };

  // Date derived from injected `now` — never wall-clock (mirrors note-writer.ts:24)
  const date = now.slice(0, 10); // YYYY-MM-DD

  await ensureDir(deps.digestsDir);

  const mdPath = join(deps.digestsDir, `${date}.md`);
  const jsonPath = join(deps.digestsDir, `${date}.json`);

  await writeFile(mdPath, renderDigestMarkdown(digest), "utf-8");
  // Mirror fleet/index.ts:69: JSON.stringify(obj, null, 2) + "\n"
  await writeFile(jsonPath, JSON.stringify(digest, null, 2) + "\n", "utf-8");

  return { digest, mdPath, jsonPath };
}

// ── Real vault-note collector (bound only by the CLI) ─────────────────

/**
 * Real collectRuns implementation: reads research vault notes under
 * <vaultRoot>/research/, filters by frontmatter.generatedAt ∈ [since, now],
 * and maps each matching note to a DigestRun.
 *
 * Source selection: vault notes are 1:1 dated run artifacts (runner.ts:186-190
 * writes a new file per run). Hub Findings are content-deduped by
 * sha256(domain|title|kind) and silently undercount a window — not suitable.
 *
 * Non-sensitive: topFinding is frontmatter.question/title only — never raw body.
 *
 * Window compare: ISO lexicographic (safe because all timestamps are
 * toISOString() fixed-width — finding-store.ts:101-104).
 */
export async function collectRunsFromVault(
  vaultRoot: string,
  since: string,
  now: string,
): Promise<DigestRun[]> {
  const researchDir = join(vaultRoot, "research");

  let paths: string[];
  try {
    paths = await listNotes(researchDir);
  } catch {
    // Directory may not exist yet (first run, empty vault) — return empty, no error
    return [];
  }

  const runs: DigestRun[] = [];

  for (const p of paths) {
    const note = await readNote(p);
    const generatedAt = note.frontmatter["generatedAt"];

    // Skip notes whose generatedAt is absent or not a string
    if (typeof generatedAt !== "string") continue;

    // ISO lexicographic window filter
    if (generatedAt < since || generatedAt > now) continue;

    // title: prefer frontmatter.title, fall back to "Research — <question>", then path
    const rawTitle = note.frontmatter["title"];
    const rawQuestion = note.frontmatter["question"];
    const title =
      typeof rawTitle === "string"
        ? rawTitle
        : typeof rawQuestion === "string"
          ? `Research — ${rawQuestion}`
          : p;

    // topFinding: frontmatter.question (non-sensitive; never raw body values)
    const topFinding =
      typeof rawQuestion === "string" ? rawQuestion : title;

    runs.push({ title, topFinding, generatedAt, source: p });
  }

  return runs;
}
