/**
 * Scanner: CI Checks
 *
 * Reads .github/workflows/*.yml and .gitlab-ci.yml.
 * Extracts "run:" commands from steps using a simple line-by-line parser.
 * No yaml dependency -- pure string parsing.
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { fileExists } from "../../utils/fs.js";
import type { CIChecksReport, CIWorkflow, CIStep, CICategory } from "../types.js";

// ── Category inference ────────────────────────────────────────────

const CATEGORY_KEYWORDS: Array<{ category: CICategory; keywords: string[] }> =
  [
    { category: "test", keywords: ["test", "vitest", "jest", "pytest", "mocha", "spec"] },
    { category: "lint", keywords: ["lint", "eslint", "tslint", "prettier", "stylelint"] },
    { category: "build", keywords: ["build", "compile", "tsc", "webpack", "vite", "rollup"] },
    { category: "deploy", keywords: ["deploy", "release", "publish", "docker", "k8s", "heroku", "vercel", "netlify"] },
  ];

function inferCategory(runCommand: string): CICategory {
  const lower = runCommand.toLowerCase();
  for (const { category, keywords } of CATEGORY_KEYWORDS) {
    if (keywords.some((kw) => lower.includes(kw))) {
      return category;
    }
  }
  return "other";
}

// ── YAML line-by-line parser ──────────────────────────────────────

/**
 * Extracts run commands from a YAML workflow file.
 *
 * Strategy:
 * 1. Look for lines that start with (optional whitespace) "run:" (inline)
 *    e.g.  `      run: npm test`
 * 2. Look for multiline run blocks:
 *    e.g.  `      run: |`
 *          `        npm test`
 *          `        npm run build`
 *
 * We also try to capture the nearest preceding "name:" to label the step.
 */
function parseWorkflowFile(content: string, relPath: string): CIWorkflow {
  const lines = content.split("\n");
  const steps: CIStep[] = [];

  let currentName: string | null = null;
  let inRunBlock = false;
  let runBlockIndent = 0;
  let currentRunLines: string[] = [];

  const flushRunBlock = () => {
    if (currentRunLines.length > 0) {
      const runCommand = currentRunLines.join("\n").trim();
      if (runCommand) {
        steps.push({
          name: currentName,
          runCommand,
          category: inferCategory(runCommand),
        });
      }
    }
    currentRunLines = [];
    inRunBlock = false;
    runBlockIndent = 0;
  };

  for (const line of lines) {
    const trimmed = line.trimStart();
    const indent = line.length - trimmed.length;

    // If we're in a multiline run block
    if (inRunBlock) {
      // If indentation decreased to or below the run: line's indent, the block ended
      if (indent <= runBlockIndent && trimmed.length > 0) {
        flushRunBlock();
        // Fall through to process this line normally
      } else {
        // Still in the block
        if (trimmed.length > 0) {
          currentRunLines.push(trimmed);
        }
        continue;
      }
    }

    // Detect "name:" lines to capture step names
    const nameMatch = /^\s*-?\s*name:\s*(.+)$/.exec(line);
    if (nameMatch) {
      currentName = nameMatch[1]?.trim() ?? null;
      continue;
    }

    // Detect "run:" line
    const runInlineMatch = /^\s*run:\s*(.+)$/.exec(line);
    if (runInlineMatch) {
      const value = runInlineMatch[1]?.trim() ?? "";
      // Check if it's a multiline block indicator (| or >)
      if (value === "|" || value === ">") {
        inRunBlock = true;
        runBlockIndent = indent;
        currentRunLines = [];
      } else {
        // Inline single-line run
        steps.push({
          name: currentName,
          runCommand: value,
          category: inferCategory(value),
        });
        currentName = null;
      }
      continue;
    }

    // Detect "run: |" or "run: >" on its own line pattern (no inline value)
    const runBlockMatch = /^\s*run:\s*[|>]?\s*$/.exec(line);
    if (runBlockMatch && !runInlineMatch) {
      inRunBlock = true;
      runBlockIndent = indent;
      currentRunLines = [];
      continue;
    }
  }

  // Flush any remaining run block
  if (inRunBlock && currentRunLines.length > 0) {
    flushRunBlock();
  }

  return { file: relPath, steps };
}

// ── Main scanner ──────────────────────────────────────────────────

export async function scanCIChecks(
  projectRoot: string,
): Promise<CIChecksReport> {
  const workflows: CIWorkflow[] = [];

  // Scan .github/workflows/
  const githubWorkflowsDir = join(projectRoot, ".github", "workflows");
  if (await fileExists(githubWorkflowsDir)) {
    try {
      const files = await readdir(githubWorkflowsDir);
      for (const file of files.filter((f) => f.endsWith(".yml") || f.endsWith(".yaml"))) {
        const filePath = join(githubWorkflowsDir, file);
        try {
          const content = await readFile(filePath, "utf-8");
          const relPath = `.github/workflows/${file}`;
          const workflow = parseWorkflowFile(content, relPath);
          if (workflow.steps.length > 0) {
            workflows.push(workflow);
          }
        } catch {
          // Skip unreadable files
        }
      }
    } catch {
      // Directory not readable
    }
  }

  // Scan .gitlab-ci.yml
  const gitlabCiPath = join(projectRoot, ".gitlab-ci.yml");
  if (await fileExists(gitlabCiPath)) {
    try {
      const content = await readFile(gitlabCiPath, "utf-8");
      const workflow = parseWorkflowFile(content, ".gitlab-ci.yml");
      if (workflow.steps.length > 0) {
        workflows.push(workflow);
      }
    } catch {
      // Skip
    }
  }

  const allRunCommands = [
    ...new Set(workflows.flatMap((w) => w.steps.map((s) => s.runCommand))),
  ];

  return { workflows, allRunCommands };
}
