import { readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

import { fileExists } from "../utils/fs.js";

// ── Types ──────────────────────────────────────────────────────────

export interface AgentDefinition {
  /** Agent name from frontmatter. */
  name: string;
  /** One-line description from frontmatter. */
  description: string;
  /** Tool names listed in frontmatter (e.g. ["Read", "Write", "Bash"]). */
  tools: string[];
  /** Preferred model from frontmatter (e.g. "opus", "sonnet"). */
  model: string;
  /** The full markdown body after frontmatter — used as system prompt. */
  systemPrompt: string;
}

// ── Cache ──────────────────────────────────────────────────────────

const cache = new Map<string, AgentDefinition>();

// ── Frontmatter parser ─────────────────────────────────────────────

/**
 * Parse simple YAML frontmatter from an agent .md file.
 * Handles both flow sequences `[A, B]` and block sequences `- A\n- B`.
 */
function parseFrontmatter(raw: string): {
  meta: Record<string, string | string[]>;
  body: string;
} {
  const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) {
    return { meta: {}, body: raw };
  }

  const [, yamlBlock, body] = match;
  const meta: Record<string, string | string[]> = {};

  let currentKey: string | null = null;
  let currentList: string[] | null = null;

  for (const line of yamlBlock.split("\n")) {
    const trimmed = line.trim();

    // Block sequence item (e.g. "  - Read")
    if (trimmed.startsWith("- ") && currentKey && currentList) {
      currentList.push(trimmed.slice(2).trim());
      continue;
    }

    // Flush any pending list
    if (currentKey && currentList) {
      meta[currentKey] = currentList;
      currentKey = null;
      currentList = null;
    }

    // Key-value pair
    const kvMatch = trimmed.match(/^(\w[\w-]*):\s*(.*)$/);
    if (!kvMatch) continue;

    const [, key, value] = kvMatch;

    if (!value) {
      // Start of a block sequence (value on next lines)
      currentKey = key;
      currentList = [];
      continue;
    }

    // Flow sequence (e.g. "[Read, Write, Bash]")
    const flowMatch = value.match(/^\[([^\]]*)\]$/);
    if (flowMatch) {
      meta[key] = flowMatch[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean);
      continue;
    }

    // Scalar value
    meta[key] = value;
  }

  // Flush trailing list
  if (currentKey && currentList) {
    meta[currentKey] = currentList;
  }

  return { meta, body };
}

// ── Loader ─────────────────────────────────────────────────────────

/**
 * Resolve the path to an agent definition file.
 *
 * Resolution order:
 * 1. `<projectRoot>/agents/<agentName>.md` (project-local override)
 * 2. Bundled default from the package's `agents/` directory
 */
async function resolveAgentPath(
  agentName: string,
  projectRoot?: string,
): Promise<string | null> {
  // 1. Project-local
  if (projectRoot) {
    const localPath = join(projectRoot, "agents", `${agentName}.md`);
    if (await fileExists(localPath)) {
      return localPath;
    }
  }

  // 2. Bundled with the package
  const currentDir = dirname(fileURLToPath(import.meta.url));
  // src/orchestrator/ -> package root is ../../
  const packageRoot = join(currentDir, "..", "..");
  const bundledPath = join(packageRoot, "agents", `${agentName}.md`);
  if (await fileExists(bundledPath)) {
    return bundledPath;
  }

  return null;
}

/**
 * Load an agent definition from its .md file.
 *
 * @param agentName  The agent name (e.g. "bober-planner", "bober-generator").
 * @param projectRoot  Optional project root for local overrides.
 * @returns The parsed AgentDefinition.
 * @throws If the agent file cannot be found.
 */
export async function loadAgentDefinition(
  agentName: string,
  projectRoot?: string,
): Promise<AgentDefinition> {
  const cacheKey = `${projectRoot ?? ""}:${agentName}`;
  const cached = cache.get(cacheKey);
  if (cached) return cached;

  const agentPath = await resolveAgentPath(agentName, projectRoot);
  if (!agentPath) {
    throw new Error(
      `Agent definition not found: "${agentName}". ` +
        `Looked in ${projectRoot ? `${projectRoot}/agents/ and ` : ""}the bundled agents/ directory.`,
    );
  }

  const raw = await readFile(agentPath, "utf-8");
  const { meta, body } = parseFrontmatter(raw);

  const definition: AgentDefinition = {
    name: typeof meta.name === "string" ? meta.name : agentName,
    description:
      typeof meta.description === "string" ? meta.description : "",
    tools: Array.isArray(meta.tools) ? meta.tools : [],
    model: typeof meta.model === "string" ? meta.model : "sonnet",
    systemPrompt: body.trim(),
  };

  cache.set(cacheKey, definition);
  return definition;
}

/**
 * Clear the agent definition cache. Useful for testing.
 */
export function clearAgentCache(): void {
  cache.clear();
}
