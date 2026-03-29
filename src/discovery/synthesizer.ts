/**
 * LLM-powered principles synthesizer.
 *
 * synthesizePrinciples() takes a DiscoveryReport produced by scanProject()
 * and makes a single LLM call to produce a comprehensive principles.md
 * document tailored to the scanned project.
 *
 * The returned markdown is ready to write to .bober/principles.md.
 */

import type { BoberConfig } from "../config/schema.js";
import { createClient } from "../providers/factory.js";
import { resolveModel } from "../orchestrator/model-resolver.js";
import type { DiscoveryReport } from "./types.js";

// ── Required headings ─────────────────────────────────────────────

const REQUIRED_HEADINGS = [
  "## Code Style",
  "## TypeScript Conventions",
  "## Testing Standards",
  "## Git Workflow",
  "## Error Handling",
  "## File Organization",
  "## Dependencies and Imports",
] as const;

// ── Prompt builders ───────────────────────────────────────────────

function buildSystemPrompt(): string {
  return `You are analyzing a codebase to produce project principles for an AI development harness.

Your output will be read by AI code generators (like Claude Code) as binding rules they must follow.
Every rule you write must be:
- Specific and actionable — a code generator can follow it without ambiguity
- Grounded in the actual codebase evidence provided — do not invent conventions
- Concrete, never vague — NEVER write phrases like "follow best practices", "maintain code quality", "write clean code", or any similar platitude

You are writing binding rules, not recommendations. Write in imperative mood ("Use X", "Never do Y").`;
}

function formatPackageScripts(report: DiscoveryReport): string {
  const ps = report.packageScripts;
  if (!ps) return "  (no package.json detected)";

  const lines: string[] = [];
  lines.push(`  Package manager: ${ps.packageManager ?? "unknown"}`);
  lines.push(`  All scripts: ${Object.keys(ps.allScripts).join(", ")}`);

  const cats = Object.entries(ps.categorized);
  if (cats.length > 0) {
    lines.push("  Detected command mappings:");
    for (const [category, mapping] of cats) {
      if (mapping) {
        lines.push(`    ${category}: ${mapping.runCommand} (script: "${mapping.scriptName}", raw: "${mapping.command}")`);
      }
    }
  }

  return lines.join("\n");
}

function formatCIChecks(report: DiscoveryReport): string {
  const ci = report.ciChecks;
  if (!ci || ci.workflows.length === 0) return "  (no CI workflows detected)";

  const lines: string[] = [];
  for (const workflow of ci.workflows) {
    lines.push(`  Workflow: ${workflow.file}`);
    for (const step of workflow.steps) {
      const name = step.name ? `"${step.name}"` : "(unnamed)";
      lines.push(`    - [${step.category}] ${name}: ${step.runCommand}`);
    }
  }

  if (ci.allRunCommands.length > 0) {
    lines.push(`  All CI run commands: ${ci.allRunCommands.join(", ")}`);
  }

  return lines.join("\n");
}

function formatGitConventions(report: DiscoveryReport): string {
  const git = report.gitConventions;
  if (!git) return "  (no git history detected)";

  const lines: string[] = [];
  lines.push(`  Uses conventional commits: ${git.usesConventionalCommits}`);
  lines.push(`  Most common commit prefix: ${git.mostCommonPrefix ?? "(none detected)"}`);
  lines.push(`  Has linear history (no merge commits): ${git.hasLinearHistory}`);
  lines.push(`  Merge commit ratio: ${(git.mergeCommitRatio * 100).toFixed(0)}%`);

  if (git.branchPatterns.length > 0) {
    lines.push(`  Branch naming patterns: ${git.branchPatterns.join(", ")}`);
  }

  if (git.recentMessages.length > 0) {
    const sample = git.recentMessages.slice(0, 10);
    lines.push("  Recent commit messages (sample):");
    for (const msg of sample) {
      lines.push(`    - ${msg}`);
    }
  }

  return lines.join("\n");
}

function formatCodeConventions(report: DiscoveryReport): string {
  const cc = report.codeConventions;
  if (!cc) return "  (no source files scanned)";

  const lines: string[] = [];
  lines.push(`  Files sampled: ${cc.filesSampled}`);

  // File naming
  lines.push(`  File naming: dominant style is "${cc.fileNaming.dominant}"`);
  const namingCounts = Object.entries(cc.fileNaming.counts)
    .filter(([, count]) => count > 0)
    .map(([style, count]) => `${style}=${count}`)
    .join(", ");
  if (namingCounts) {
    lines.push(`    Counts by style: ${namingCounts}`);
  }

  // Imports
  lines.push(`  Import style: ${cc.importStyle.relativeCount} relative, ${cc.importStyle.absoluteCount} absolute/alias`);
  lines.push(`  Uses .js extensions in imports: ${cc.importStyle.usesJsExtensions}`);
  if (cc.importStyle.examples.length > 0) {
    lines.push("  Import examples:");
    for (const ex of cc.importStyle.examples) {
      lines.push(`    ${ex.trim()}`);
    }
  }

  // Exports
  lines.push(`  Export style: dominant is "${cc.exportStyle.dominant}" (named=${cc.exportStyle.namedExportCount}, default=${cc.exportStyle.defaultExportCount})`);

  // TypeScript
  if (cc.typescriptPatterns) {
    const ts = cc.typescriptPatterns;
    lines.push(`  TypeScript usage:`);
    lines.push(`    interface declarations: ${ts.interfaceCount}`);
    lines.push(`    type alias declarations: ${ts.typeAliasCount}`);
    lines.push(`    enum declarations: ${ts.enumCount}`);
    lines.push(`    "any" usages: ${ts.anyCount}`);
    lines.push(`    @ts-ignore/@ts-expect-error usages: ${ts.tsIgnoreCount}`);
  }

  return lines.join("\n");
}

function formatTestConventions(report: DiscoveryReport): string {
  const tc = report.testConventions;
  if (!tc) return "  (no test files detected)";

  const lines: string[] = [];
  lines.push(`  Framework: ${tc.framework}`);
  lines.push(`  Mocking library: ${tc.mockingLibrary}`);
  lines.push(`  File naming pattern: ${tc.filePattern}`);
  lines.push(`  Tests colocated with source: ${tc.colocated}`);
  lines.push(`  Test file count: ${tc.testFileCount}`);
  lines.push(`  Has coverage config: ${tc.hasCoverageConfig}`);

  if (tc.testDirs.length > 0) {
    lines.push(`  Test directories: ${tc.testDirs.join(", ")}`);
  }

  return lines.join("\n");
}

function formatDocumentation(report: DiscoveryReport): string {
  const docs = report.documentation;
  if (!docs || docs.files.length === 0) return "  (no documentation files found)";

  const lines: string[] = [];
  for (const file of docs.files) {
    const truncated = file.truncated ? " (truncated)" : "";
    lines.push(`  File: ${file.path}${truncated}`);
    // Include a short excerpt (first 300 chars) to give the LLM flavour
    const excerpt = file.content.slice(0, 300).replace(/\n/g, "\n    ");
    lines.push(`    ${excerpt}`);
    if (file.truncated) {
      lines.push("    [... content truncated ...]");
    }
  }

  return lines.join("\n");
}

function formatDetectedStack(report: DiscoveryReport): string {
  const ds = report.detectedStack;
  if (!ds) return "  (stack detection failed)";

  const active: string[] = [];
  if (ds.hasTypescript) active.push("TypeScript");
  if (ds.hasReact) active.push("React");
  if (ds.hasNext) active.push("Next.js");
  if (ds.hasVite) active.push("Vite");
  if (ds.hasVitest) active.push("Vitest");
  if (ds.hasJest) active.push("Jest");
  if (ds.hasPlaywright) active.push("Playwright");
  if (ds.hasEslint) active.push("ESLint");
  if (ds.hasPython) active.push("Python");
  if (ds.hasRust) active.push("Rust");
  if (ds.hasNestjs) active.push("NestJS");
  if (ds.hasFastify) active.push("Fastify");
  if (ds.hasExpress) active.push("Express");

  const lines: string[] = [];
  lines.push(`  Primary language: ${ds.primaryLanguage}`);
  lines.push(`  Detected technologies: ${active.length > 0 ? active.join(", ") : "(none)"}`);

  return lines.join("\n");
}

function buildUserMessage(
  report: DiscoveryReport,
  projectRoot: string,
): string {
  const date = new Date().toISOString().slice(0, 10);

  const sections: string[] = [];

  sections.push(`# Codebase Analysis Report
Project root: ${projectRoot}
Scanned at: ${report.scannedAt}
Package manager: ${report.packageManager ?? "unknown"}`);

  sections.push(`## Package Scripts and Detected Commands
${formatPackageScripts(report)}`);

  sections.push(`## CI/CD Workflows
${formatCIChecks(report)}`);

  sections.push(`## Git Conventions
${formatGitConventions(report)}`);

  sections.push(`## Code Conventions
${formatCodeConventions(report)}`);

  sections.push(`## Test Conventions
${formatTestConventions(report)}`);

  sections.push(`## Documentation Excerpts
${formatDocumentation(report)}`);

  sections.push(`## Detected Stack
${formatDetectedStack(report)}`);

  sections.push(`---

# Instructions

Using the codebase analysis above, produce a comprehensive \`principles.md\` document.

**Content requirements — you MUST follow all of these:**

1. Include file path examples for each convention discovered.
   Example: "Components use PascalCase naming — see src/components/UserProfile.tsx"
   Example: "Imports use relative paths with .js extensions — see src/utils/fs.ts"

2. Note any inconsistencies with the majority pattern.
   Example: "Most files use camelCase but src/utils/parse-config.ts uses kebab-case"
   Example: "Named exports dominate but some utility files use default exports"

3. NEVER use vague phrases like "follow best practices", "maintain code quality",
   "write clean code", "be consistent", "use idiomatic code", or similar platitudes.
   Every rule must be specific and actionable.

4. Produce specific actionable rules that a code generator can follow without ambiguity.
   BAD: "Handle errors properly"
   GOOD: "All async functions must catch errors and either rethrow with context or return null — never swallow errors silently"

5. Base every rule on the actual evidence in the report above. Do not invent conventions
   that are not supported by the scanned data.

**Output format — produce EXACTLY this structure:**

\`\`\`markdown
# Project Principles
> Auto-discovered by agent-bober on ${date}

## Code Style
[rules]

## TypeScript Conventions
[rules]

## Testing Standards
[rules]

## Git Workflow
[rules]

## Error Handling
[rules]

## File Organization
[rules]

## Dependencies and Imports
[rules]
\`\`\`

Output ONLY the markdown document — no preamble, no explanation, no text outside the code fence.`);

  return sections.join("\n\n");
}

// ── Response parsing ──────────────────────────────────────────────

/**
 * Strip markdown code fences from a response if present.
 *
 * Handles:
 * - ```markdown ... ```
 * - ```md ... ```
 * - ``` ... ```
 * - No fences (returned as-is)
 */
function stripCodeFences(text: string): string {
  const trimmed = text.trim();

  // Match opening fence with optional language tag, capture content, closing fence
  const fenceMatch = /^```(?:markdown|md)?\s*\n([\s\S]*?)\n?```\s*$/.exec(trimmed);
  if (fenceMatch) {
    return fenceMatch[1].trim();
  }

  return trimmed;
}

/**
 * Validate the synthesized markdown contains required structure.
 * Returns true if valid; false otherwise. Never throws.
 */
export function validatePrinciplesMarkdown(markdown: string): boolean {
  if (!markdown.includes("# Project Principles")) {
    return false;
  }

  for (const heading of REQUIRED_HEADINGS) {
    if (!markdown.includes(heading)) {
      return false;
    }
  }

  return true;
}

// ── Public API ────────────────────────────────────────────────────

/**
 * Make a single LLM call to synthesize a DiscoveryReport into a
 * comprehensive principles.md markdown document.
 *
 * If the LLM response fails validation (missing headings), the raw
 * response is returned anyway — never throws on validation failure.
 *
 * @param report  DiscoveryReport produced by scanProject().
 * @param projectRoot  Absolute path to the project root (used in prompt).
 * @param config  Full BoberConfig — uses planner provider/model/endpoint.
 * @returns Markdown string starting with "# Project Principles".
 */
export async function synthesizePrinciples(
  report: DiscoveryReport,
  projectRoot: string,
  config: BoberConfig,
): Promise<string> {
  const client = createClient(
    config.planner.provider ?? null,
    config.planner.endpoint ?? null,
    config.planner.providerConfig,
    config.planner.model,
  );

  const model = resolveModel(config.planner.model);

  const systemPrompt = buildSystemPrompt();
  const userMessage = buildUserMessage(report, projectRoot);

  const response = await client.chat({
    model,
    system: systemPrompt,
    messages: [
      { role: "user", content: userMessage },
    ],
    // No tools — single chat call
    tools: [],
    maxTokens: 16384,
  });

  const raw = response.text;
  const stripped = stripCodeFences(raw);

  // Validation — if it fails, return stripped anyway (never throw)
  // This ensures callers always get something useful even if the model
  // deviated from the requested format.
  if (!validatePrinciplesMarkdown(stripped)) {
    return stripped || raw;
  }

  return stripped;
}
