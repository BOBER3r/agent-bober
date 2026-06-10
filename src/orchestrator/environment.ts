import { execFileSync } from "node:child_process";
import type { Buffer } from "node:buffer";
import { arch, platform, release } from "node:os";

import { fileExists } from "../utils/fs.js";
import { logger } from "../utils/logger.js";

/**
 * Detected host environment, surfaced to agents so they (a) target the right
 * OS/shell and (b) only invoke tooling that is actually installed — instead of
 * guessing (e.g. DeepSeek hallucinating a `bash` tool or GNU-only flags on macOS).
 */
export interface HostEnvironment {
  /** Raw node platform string (darwin | linux | win32 | ...). */
  platform: string;
  /** Friendly OS name (macOS | Linux | Windows | <platform>). */
  osName: string;
  /** OS kernel release. */
  osRelease: string;
  /** CPU architecture (arm64 | x64 | ...). */
  arch: string;
  /** Login shell from $SHELL, if known. */
  shell: string | undefined;
  /** Node.js version (process.version). */
  nodeVersion: string;
  /** Detected project package manager (npm | pnpm | yarn | bun | undefined). */
  packageManager: string | undefined;
  /** Names of common dev CLIs found on PATH. */
  installedTools: string[];
}

// Common developer CLIs worth probing. Found ones are surfaced to agents.
const CANDIDATE_TOOLS = [
  "git", "gh", "docker", "docker-compose", "kubectl",
  "node", "npm", "pnpm", "yarn", "bun", "deno",
  "python3", "pip3", "cargo", "rustc", "go", "java", "mvn", "gradle",
  "ruby", "php", "dotnet",
  "psql", "mysql", "redis-cli", "sqlite3", "mongosh",
  "make", "cmake", "gcc", "clang",
  "terraform", "aws", "gcloud", "vercel", "netlify",
  "jq", "rg", "fd", "curl", "wget",
];

function friendlyOsName(p: string): string {
  switch (p) {
    case "darwin":
      return "macOS";
    case "linux":
      return "Linux";
    case "win32":
      return "Windows";
    default:
      return p;
  }
}

/**
 * Probe PATH for the candidate CLIs in a single `which` invocation (one child
 * process, not one per tool). `which` prints a line per found binary and exits
 * non-zero when some are missing — we read stdout regardless.
 */
function detectInstalledTools(): string[] {
  // `which` is unavailable on bare Windows; skip probing there.
  if (platform() === "win32") return [];
  try {
    const out = execFileSync("which", CANDIDATE_TOOLS, {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return parseWhichOutput(out);
  } catch (err) {
    // Non-zero exit (some tools missing) still carries stdout with the found ones.
    const stdout = (err as { stdout?: string | Buffer }).stdout;
    if (stdout) return parseWhichOutput(stdout.toString());
    logger.debug(
      `Tool detection failed: ${err instanceof Error ? err.message : String(err)}`,
    );
    return [];
  }
}

function parseWhichOutput(out: string): string[] {
  const found = new Set<string>();
  for (const line of out.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    const base = trimmed.split("/").pop();
    if (base && CANDIDATE_TOOLS.includes(base)) found.add(base);
  }
  // Preserve CANDIDATE_TOOLS order for stable output.
  return CANDIDATE_TOOLS.filter((t) => found.has(t));
}

async function detectPackageManager(
  projectRoot: string,
): Promise<string | undefined> {
  const candidates: Array<[string, string]> = [
    ["pnpm-lock.yaml", "pnpm"],
    ["yarn.lock", "yarn"],
    ["bun.lockb", "bun"],
    ["package-lock.json", "npm"],
  ];
  for (const [lockfile, manager] of candidates) {
    if (await fileExists(`${projectRoot}/${lockfile}`)) return manager;
  }
  return undefined;
}

let cached: HostEnvironment | undefined;

/**
 * Detect the host environment. Tool/OS detection is process-stable, so the
 * result is cached after the first call (package-manager detection re-runs only
 * when the cache is cold). Pass a projectRoot for package-manager detection.
 */
export async function detectEnvironment(
  projectRoot: string,
): Promise<HostEnvironment> {
  if (cached) return cached;
  cached = {
    platform: platform(),
    osName: friendlyOsName(platform()),
    osRelease: release(),
    arch: arch(),
    shell: process.env["SHELL"],
    nodeVersion: process.version,
    packageManager: await detectPackageManager(projectRoot),
    installedTools: detectInstalledTools(),
  };
  return cached;
}

/** Reset the cache (tests). */
export function resetEnvironmentCache(): void {
  cached = undefined;
}

/**
 * Render the environment + the role's exact harness tools as a markdown block
 * for injection into an agent's system prompt.
 *
 * @param env         Detected host environment.
 * @param toolNames   The exact harness tool names available to this role (e.g.
 *                    ["read_file","glob","grep"]). Used to stop models inventing
 *                    tools (e.g. a non-existent "bash" for read-only roles).
 * @param projectRoot Absolute path to the project root. Surfaced so models stop
 *                    guessing it — non-Claude models otherwise invent an absolute
 *                    path with the wrong home dir, which the path sandbox rejects.
 */
export function formatEnvironmentContext(
  env: HostEnvironment,
  toolNames: string[],
  projectRoot?: string,
): string {
  const lines: string[] = [];
  lines.push("# Host Environment");
  lines.push(
    `- OS: ${env.osName} (${env.platform} ${env.osRelease}, ${env.arch})`,
  );
  if (env.shell) lines.push(`- Shell: ${env.shell}`);
  lines.push(`- Node: ${env.nodeVersion}`);
  if (env.packageManager)
    lines.push(`- Package manager: ${env.packageManager}`);
  if (projectRoot) lines.push(`- Project root (absolute): ${projectRoot}`);
  if (env.installedTools.length > 0) {
    lines.push(`- Installed CLIs on PATH: ${env.installedTools.join(", ")}`);
  }

  const hasBash = toolNames.includes("bash");
  if (hasBash && env.platform === "darwin") {
    lines.push(
      "",
      "When using the `bash` tool, write macOS-compatible commands (BSD userland, " +
        "not GNU coreutils — e.g. avoid `sed -i` without a backup suffix, `readlink -f`). " +
        "Prefer the installed CLIs listed above.",
    );
  }

  lines.push("");
  lines.push("# Your Tools");
  lines.push(
    `You have EXACTLY these tools: ${toolNames.join(", ")}. ` +
      `Do NOT call any other tool name. There is no general "bash"/"shell" tool ` +
      `unless it is listed above. If you need to do something a listed tool can't, ` +
      `state that in your output rather than inventing a tool.`,
  );

  const hasPathTool = toolNames.some((t) =>
    ["read_file", "write_file", "edit_file", "glob", "grep"].includes(t),
  );
  if (hasPathTool) {
    lines.push(
      "",
      "For file/path tool arguments, pass paths RELATIVE to the project root " +
        "(e.g. `src`, `src/index.ts`, `src/**/*.ts`). Do NOT construct absolute " +
        "paths — you do not know the real home directory and a wrong guess is " +
        "rejected by the path sandbox.",
    );
  }

  return lines.join("\n");
}
