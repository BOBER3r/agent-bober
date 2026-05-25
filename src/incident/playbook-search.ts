/**
 * Playbook search — symptom-to-playbook matching (Sprint 25).
 *
 * Loads playbooks from .bober/playbooks/*.md (skipping README.md).
 * Each playbook frontmatter (name, classification, applicableSymptoms,
 * prerequisites) is parsed via a minimal YAML block parser — no external dep.
 *
 * searchPlaybooks(symptom) tokenises the symptom string, scores each
 * playbook's applicableSymptoms by token overlap, and returns matches
 * sorted by confidence descending.
 *
 * Confidence thresholds (exported constants):
 *   HIGH_CONFIDENCE_THRESHOLD  = 0.6  → diagnoser auto-follows playbook
 *   LOW_CONFIDENCE_THRESHOLD   = 0.3  → diagnoser surfaces as suggestion
 *
 * Sprint 25 — src/incident/playbook-search.ts
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

// ── Confidence thresholds ─────────────────────────────────────────────────────

/** A match at or above this threshold triggers automatic playbook execution. */
export const HIGH_CONFIDENCE_THRESHOLD = 0.6;

/** A match at or above this (and below HIGH) surfaces as a suggestion. */
export const LOW_CONFIDENCE_THRESHOLD = 0.3;

// ── Exported types ────────────────────────────────────────────────────────────

export interface Playbook {
  name: string;
  classification: "standard" | "emergency";
  applicableSymptoms: string[];
  prerequisites: string[];
  filePath: string;
  /** Raw step sections (## Step N: ...) extracted from the markdown body */
  stepSections: string[];
}

export interface PlaybookMatch {
  playbook: Playbook;
  /** Confidence in [0, 1]. Clamped to the range. */
  confidence: number;
  /** The tokens from the query that overlapped with a matched symptom phrase */
  matchedTokens: string[];
}

// ── Stop-word list ────────────────────────────────────────────────────────────

const STOPWORDS = new Set([
  "the", "is", "a", "an", "in", "on", "at", "of", "to", "for", "and", "or",
  "be", "are", "was", "were", "has", "have", "had", "been", "not", "by",
  "it", "its", "this", "that", "but", "with", "from", "as", "up",
]);

// ── Tokenizer ─────────────────────────────────────────────────────────────────

/**
 * Tokenise a string into lowercase, non-empty, non-stopword tokens.
 * Splits on whitespace and common punctuation.
 */
export function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .split(/[\s\-_/.,;:!?()[\]{}'"]+/)
    .filter((t) => t.length > 0 && !STOPWORDS.has(t));
}

// ── Minimal YAML frontmatter parser ──────────────────────────────────────────

interface ParsedFrontmatter {
  name?: string;
  classification?: string;
  applicableSymptoms?: string[];
  prerequisites?: string[];
}

/**
 * Parse the YAML frontmatter block between the first two `---` lines.
 * Handles only the simple types used in playbook files:
 *   - scalar: key: value
 *   - list: key:\n  - item\n  - item
 *
 * Returns null if no frontmatter block is found.
 */
function parseFrontmatter(content: string): ParsedFrontmatter | null {
  // Must start with ---
  const lines = content.split("\n");
  if (lines[0]?.trim() !== "---") return null;

  // Find closing ---
  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) return null;

  const yamlLines = lines.slice(1, closingIdx);
  const result: ParsedFrontmatter = {};
  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const raw of yamlLines) {
    const line = raw;
    // List item under a key
    if (line.startsWith("  - ") || line.startsWith("    - ")) {
      const item = line.replace(/^\s+-\s*/, "").trim();
      if (currentList !== null && currentKey !== null) {
        currentList.push(item);
      }
      continue;
    }
    // Flush previous list if any
    if (currentList !== null && currentKey !== null) {
      switch (currentKey) {
        case "applicableSymptoms":
          result.applicableSymptoms = currentList;
          break;
        case "prerequisites":
          result.prerequisites = currentList;
          break;
      }
      currentList = null;
      currentKey = null;
    }
    // Key: value or Key: (start of list)
    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;
    const key = line.slice(0, colonIdx).trim();
    const value = line.slice(colonIdx + 1).trim();
    if (value === "") {
      // Start of a list block
      currentKey = key;
      currentList = [];
    } else {
      // Scalar
      switch (key) {
        case "name":
          result.name = value;
          break;
        case "classification":
          result.classification = value;
          break;
        default:
          break;
      }
      currentKey = null;
      currentList = null;
    }
  }
  // Flush trailing list
  if (currentList !== null && currentKey !== null) {
    switch (currentKey) {
      case "applicableSymptoms":
        result.applicableSymptoms = currentList;
        break;
      case "prerequisites":
        result.prerequisites = currentList;
        break;
    }
  }

  return result;
}

/**
 * Extract step sections from the markdown body (after the frontmatter).
 * A step section starts with `## Step N:` and ends before the next `## Step` or EOF.
 */
function extractSteps(content: string): string[] {
  const lines = content.split("\n");

  // Skip frontmatter
  let bodyStart = 0;
  if (lines[0]?.trim() === "---") {
    for (let i = 1; i < lines.length; i++) {
      if (lines[i]?.trim() === "---") {
        bodyStart = i + 1;
        break;
      }
    }
  }

  const steps: string[] = [];
  let currentStep: string[] | null = null;

  for (let i = bodyStart; i < lines.length; i++) {
    const line = lines[i] ?? "";
    if (/^##\s+Step\s+\d+:/.test(line)) {
      if (currentStep !== null) {
        steps.push(currentStep.join("\n").trim());
      }
      currentStep = [line];
    } else if (currentStep !== null) {
      currentStep.push(line);
    }
  }
  if (currentStep !== null) {
    steps.push(currentStep.join("\n").trim());
  }
  return steps;
}

// ── loadPlaybooks ─────────────────────────────────────────────────────────────

/**
 * Load all playbooks from .bober/playbooks/*.md in the given projectRoot.
 * - Skips README.md
 * - Skips files with missing or malformed frontmatter (logs a warning)
 * - Returns [] gracefully when the directory does not exist
 */
export async function loadPlaybooks(projectRoot: string): Promise<Playbook[]> {
  const playbooksDir = join(projectRoot, ".bober", "playbooks");
  let entries: string[];
  try {
    entries = await readdir(playbooksDir);
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return [];
    throw err;
  }

  const mdFiles = entries.filter(
    (e) => e.endsWith(".md") && e.toLowerCase() !== "readme.md",
  );

  const playbooks: Playbook[] = [];
  for (const filename of mdFiles) {
    const filePath = join(playbooksDir, filename);
    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch {
      process.stderr.write(`[playbook-search] warning: could not read ${filePath}\n`);
      continue;
    }

    const fm = parseFrontmatter(content);
    if (fm === null) {
      process.stderr.write(`[playbook-search] warning: no frontmatter in ${filename}, skipping\n`);
      continue;
    }
    if (!fm.name || !fm.classification || !fm.applicableSymptoms?.length) {
      process.stderr.write(
        `[playbook-search] warning: malformed frontmatter in ${filename} (missing name/classification/applicableSymptoms), skipping\n`,
      );
      continue;
    }
    const classification = fm.classification as "standard" | "emergency";
    if (classification !== "standard" && classification !== "emergency") {
      process.stderr.write(
        `[playbook-search] warning: unknown classification '${fm.classification}' in ${filename}, skipping\n`,
      );
      continue;
    }

    playbooks.push({
      name: fm.name,
      classification,
      applicableSymptoms: fm.applicableSymptoms,
      prerequisites: fm.prerequisites ?? [],
      filePath,
      stepSections: extractSteps(content),
    });
  }

  return playbooks;
}

// ── Scoring helper ────────────────────────────────────────────────────────────

/**
 * Score a symptom query against a single symptom phrase.
 *
 * score = (number of overlapping tokens) / (number of tokens in the phrase)
 *
 * Clamped to [0, 1].
 */
function scoreAgainstPhrase(queryTokens: Set<string>, phrase: string): {
  score: number;
  matchedTokens: string[];
} {
  const phraseTokens = tokenize(phrase);
  if (phraseTokens.length === 0) return { score: 0, matchedTokens: [] };
  const matched = phraseTokens.filter((t) => queryTokens.has(t));
  const score = Math.min(1, matched.length / phraseTokens.length);
  return { score, matchedTokens: matched };
}

// ── searchPlaybooks ───────────────────────────────────────────────────────────

/**
 * Search the playbook library for playbooks matching the given symptom string.
 *
 * Algorithm:
 *   1. Tokenise the symptom string.
 *   2. For each playbook, score each of its applicableSymptoms phrases.
 *   3. Take the maximum score across phrases as the playbook's confidence.
 *   4. Return all playbooks with confidence > 0, sorted descending by confidence.
 *
 * @param symptom     The free-text symptom string from the incident.
 * @param projectRoot Absolute path to the project root. Defaults to process.cwd().
 */
export async function searchPlaybooks(
  symptom: string,
  projectRoot?: string,
): Promise<PlaybookMatch[]> {
  const root = projectRoot ?? process.cwd();
  const playbooks = await loadPlaybooks(root);
  return searchPlaybooksList(symptom, playbooks);
}

/**
 * Search a pre-loaded list of playbooks. Useful for testing without touching disk.
 */
export function searchPlaybooksList(
  symptom: string,
  playbooks: Playbook[],
): PlaybookMatch[] {
  const queryTokens = new Set(tokenize(symptom));
  if (queryTokens.size === 0) return [];

  const matches: PlaybookMatch[] = [];
  for (const playbook of playbooks) {
    let bestScore = 0;
    let bestMatchedTokens: string[] = [];

    for (const phrase of playbook.applicableSymptoms) {
      const { score, matchedTokens } = scoreAgainstPhrase(queryTokens, phrase);
      if (score > bestScore) {
        bestScore = score;
        bestMatchedTokens = matchedTokens;
      }
    }

    if (bestScore > 0) {
      matches.push({
        playbook,
        confidence: bestScore,
        matchedTokens: bestMatchedTokens,
      });
    }
  }

  // Sort descending by confidence; ties broken by name for determinism.
  matches.sort((a, b) =>
    b.confidence !== a.confidence
      ? b.confidence - a.confidence
      : a.playbook.name.localeCompare(b.playbook.name),
  );

  return matches;
}
