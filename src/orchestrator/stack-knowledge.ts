import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { Stack } from "../config/schema.js";
import type { VulnClass } from "./security-audit-types.js";
import { resolveLensFocus } from "./eval-lenses.js";

// ── Types ──────────────────────────────────────────────────────────

/** Stack skills that ship a stack-specific security checklist. */
export type SecuritySkillName = "bober.solidity" | "bober.anchor" | "bober.react";

/**
 * StackKnowledgeInjector output — maps a declared/detected stack to the
 * matching skill checklist plus the generic vulnerability taxonomy, so the
 * security auditor prompt is stack-aware without a per-stack agent.
 * Shape mirrors arch-20260712-security-audit-agent-team-architecture.md:185-191.
 */
export interface StackSecurityContext {
  /** The stack value that was matched (or "unknown" when absent/unrecognised). */
  stackLabel: string;
  /** The skill actually read into promptFragment, or null when no checklist was used. */
  skillName: SecuritySkillName | null;
  /** The canonical vulnerability-class taxonomy — stable across stacks. */
  taxonomy: VulnClass[];
  /** Text to inject verbatim into the auditor's prompt. Never empty. */
  promptFragment: string;
}

// ── Taxonomy ───────────────────────────────────────────────────────

/**
 * Every VulnClass value (sprint-1 union, security-audit-types.ts:9-15).
 * The taxonomy does not vary by stack — it is the fixed classification
 * backbone every audit is organised against.
 */
export const ALL_VULN_CLASSES: VulnClass[] = [
  "injection",
  "authn-authz",
  "secret-handling",
  "input-validation",
  "path-traversal",
  "privilege-escalation",
];

// ── Stack detection ────────────────────────────────────────────────

const STACK_SKILL_MAP: ReadonlyArray<{ pattern: string; skillName: SecuritySkillName }> = [
  { pattern: "solidity", skillName: "bober.solidity" },
  { pattern: "anchor", skillName: "bober.anchor" },
  { pattern: "react", skillName: "bober.react" },
];

/**
 * Detect a stack label + candidate skill from a Stack object or a plain
 * string (accepted for test ergonomics per the sprint briefing).
 *
 * Precedence when `stack` is a `StackSchema` object: blockchain and language
 * fields are checked before frontend/backend/testing/database/other, since
 * blockchain-specific values (solidity, anchor) are more determinative of the
 * security checklist to use than a generic frontend framework.
 */
function detectStack(stack: Stack | string | undefined): {
  stackLabel: string;
  skillName: SecuritySkillName | null;
} {
  const candidates: string[] = [];

  if (typeof stack === "string") {
    if (stack.trim().length > 0) candidates.push(stack);
  } else if (stack && typeof stack === "object") {
    const ordered: Array<string | undefined> = [
      stack.blockchain,
      stack.language,
      stack.frontend,
      stack.backend,
      stack.testing,
      stack.database,
      ...(stack.other ?? []),
    ];
    for (const value of ordered) {
      if (typeof value === "string" && value.trim().length > 0) {
        candidates.push(value);
      }
    }
  }

  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const match = STACK_SKILL_MAP.find((m) => lower.includes(m.pattern));
    if (match) {
      return { stackLabel: candidate, skillName: match.skillName };
    }
  }

  return { stackLabel: candidates[0] ?? "unknown", skillName: null };
}

// ── Skill excerpt extraction ───────────────────────────────────────

/** Bounds on how much of a skill file is read into the prompt (never the whole ~400-line file). */
const MAX_EXCERPT_CHARS = 2500;
const HEAD_EXCERPT_LINES = 40;

const HEADING_RE = /^#{2,4}\s+/;

/**
 * Extract a bounded security-relevant excerpt from a skill file's content.
 *
 * Looks for a heading whose text mentions "security" or "vulnerab" (matches
 * bober.solidity's "## Security Checklist") and returns that section up to
 * the next heading of equal-or-shallower depth. When no such heading exists
 * (e.g. bober.anchor's security content lives under a differently-named
 * heading; bober.react has none at all), falls back to a bounded head
 * excerpt so the prompt still carries *some* stack context rather than
 * nothing.
 *
 * bober: keyword-based heading match is a heuristic ceiling — a per-skill
 * heading registry would find bober.anchor's actual checklist instead of
 * falling back to its head excerpt, but that is out of scope for this
 * sprint (single generic resolver, not per-stack special-casing).
 */
function extractSecurityExcerpt(fileContent: string): string {
  const lines = fileContent.split("\n");
  const securityIdx = lines.findIndex(
    (line) => HEADING_RE.test(line) && /security|vulnerab/i.test(line),
  );

  if (securityIdx !== -1) {
    const level = (lines[securityIdx].match(/^#+/) ?? ["##"])[0].length;
    let endIdx = lines.length;
    for (let i = securityIdx + 1; i < lines.length; i++) {
      const headingMatch = HEADING_RE.test(lines[i]) && (lines[i].match(/^#+/) ?? ["#"])[0].length <= level;
      if (headingMatch) {
        endIdx = i;
        break;
      }
    }
    return lines.slice(securityIdx, endIdx).join("\n").slice(0, MAX_EXCERPT_CHARS).trim();
  }

  return lines.slice(0, HEAD_EXCERPT_LINES).join("\n").slice(0, MAX_EXCERPT_CHARS).trim();
}

function defaultSkillsRoot(): string {
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // src/orchestrator/ -> package root is ../.. ; skills live at <packageRoot>/skills
  return join(currentDir, "..", "..", "skills");
}

/**
 * Read a skill's SKILL.md and extract its security excerpt.
 * Never throws — any fs error (missing file, permission, etc.) resolves to null.
 */
async function readSkillSecurityExcerpt(
  skillsRoot: string,
  skillName: SecuritySkillName,
): Promise<string | null> {
  try {
    const filePath = join(skillsRoot, skillName, "SKILL.md");
    const content = await readFile(filePath, "utf-8");
    return extractSecurityExcerpt(content);
  } catch {
    return null;
  }
}

// ── Resolver ───────────────────────────────────────────────────────

/**
 * Resolve the security prompt context for a declared/detected stack.
 *
 * Maps `stack` (a `StackSchema` object, or a plain string for test
 * ergonomics) to the matching stack skill's security checklist plus the
 * generic VulnClass taxonomy. Unknown/absent stacks — or a matched stack
 * whose skill file cannot be read — degrade to `{skillName: null}` with the
 * generic taxonomy fragment only. Never throws (API contract per
 * arch-20260712-security-audit-agent-team-architecture.md:261).
 *
 * @param stack       `config.project.stack`, or a plain string in tests.
 * @param skillsRoot  Override for the skills directory (test injection).
 *                    Defaults to the bundled package `skills/` directory.
 */
export async function resolveStackSecurityContext(
  stack: Stack | string | undefined,
  skillsRoot?: string,
): Promise<StackSecurityContext> {
  const { stackLabel, skillName: detectedSkill } = detectStack(stack);
  const genericFragment = resolveLensFocus("security");
  const taxonomy = [...ALL_VULN_CLASSES];

  if (!detectedSkill) {
    return { stackLabel, skillName: null, taxonomy, promptFragment: genericFragment };
  }

  const root = skillsRoot ?? defaultSkillsRoot();
  const excerpt = await readSkillSecurityExcerpt(root, detectedSkill);

  if (excerpt === null) {
    // Detected a stack keyword but the skill file is missing/unreadable —
    // degrade to the generic taxonomy rather than throw.
    return { stackLabel, skillName: null, taxonomy, promptFragment: genericFragment };
  }

  return {
    stackLabel,
    skillName: detectedSkill,
    taxonomy,
    promptFragment: `${excerpt}\n\n${genericFragment}`,
  };
}
