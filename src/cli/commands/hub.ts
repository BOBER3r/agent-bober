/**
 * `bober hub list` — print findings held in the project's own FactStore.
 * `bober hub priority` — rank findings across siblings and write priority.md.
 * `bober hub decide <expr>` — rank findings under decision scope ("X vs Y").
 *
 * Error handling: handlers MUST NOT throw. Set process.exitCode=1 and return.
 * Pattern mirrors src/cli/commands/facts.ts and src/cli/commands/blackboard.ts.
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import chalk from "chalk";
import type { Command } from "commander";

import { findProjectRoot, readJson, fileExists, ensureDir } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { resolveRoleProviders } from "../../config/role-providers.js";
import { createClient } from "../../providers/factory.js";
import { loadTeam } from "../../teams/registry.js";
import { FactStore, factsDbPath, ensureFactsDir } from "../../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "../../hub/finding-source.js";
import type { FindingSource } from "../../hub/finding-source.js";
import type { Finding } from "../../hub/finding.js";
import { resolveSiblingRepos } from "../../hub/repo-resolver.js";
import { collectFindings } from "../../hub/collector.js";
import { type Scope, parseScope } from "../../hub/scope.js";
import { rankFindings } from "../../hub/judge.js";
import { renderPriorityMd } from "../../hub/priority-md.js";
import { resolveOutVault, priorityMdPath } from "../../hub/hub-config.js";
import type { LLMClient } from "../../providers/types.js";

// ── Config candidates ─────────────────────────────────────────────────

const CONFIG_CANDIDATES = ["bober.config.json", ".bober/config.json"] as const;

// ── Root resolver ─────────────────────────────────────────────────────

async function resolveRoot(): Promise<string> {
  const root = await findProjectRoot();
  return root ?? process.cwd();
}

// ── Namespace resolver ────────────────────────────────────────────────

/**
 * Resolve the active memory namespace from the default team.
 * Falls back to undefined (current .bober/memory/ path) if config is missing.
 * Never throws — config absence is not fatal for hub commands.
 */
async function resolveDefaultNamespace(
  projectRoot: string,
): Promise<string | undefined> {
  try {
    const config = await loadConfig(projectRoot);
    return loadTeam(config, undefined).memoryNamespace || undefined;
  } catch {
    return undefined;
  }
}

// ── Configured repos resolver ─────────────────────────────────────────

/**
 * Read the raw config file (bypassing Zod which strips unknown keys) and
 * extract hub.repos if present. Falls back to undefined so the resolver
 * can discover kb-* siblings instead. Never throws.
 * schema.ts is NOT edited in this sprint — hub is not yet a typed field.
 */
async function resolveConfiguredRepos(projectRoot: string): Promise<string[] | undefined> {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = await readJson<{ hub?: { repos?: unknown } }>(join(projectRoot, candidate));
      const repos = raw.hub?.repos;
      if (Array.isArray(repos)) {
        return repos.filter((r): r is string => typeof r === "string");
      }
      return undefined;
    } catch {
      // file not found, not valid JSON, or no hub section — try next
    }
  }
  return undefined;
}

// ── Scope label helper ────────────────────────────────────────────────

function buildScopeLabel(scope: Scope): string {
  if (scope.mode === "general") return "general";
  if (scope.mode === "decision") return `decide: ${scope.optionA} vs ${scope.optionB}`;
  // filtered
  const parts: string[] = ["filtered"];
  if (scope.domain !== undefined) parts.push(`domain=${scope.domain}`);
  if (scope.tag !== undefined) parts.push(`tag=${scope.tag}`);
  if (scope.dueWithinDays !== undefined) parts.push(`due<=${scope.dueWithinDays}d`);
  return parts.join(", ");
}

// ── runHubList ────────────────────────────────────────────────────────

/**
 * DI core for `hub list` — accepts an injected FindingSource so tests can
 * drive it against an in-memory store without spawning the CLI.
 * Prints one line per finding with title, kind, urgency, and severity.
 */
export function runHubList(source: FindingSource): void {
  const findings = source.read();
  if (findings.length === 0) {
    process.stdout.write(chalk.gray("No findings found.\n"));
    return;
  }
  for (const f of findings) {
    process.stdout.write(
      `${f.title}  [${f.kind}]  urgency=${f.urgency}  severity=${f.severity}\n`,
    );
  }
}

// ── runHubPriority ────────────────────────────────────────────────────

/**
 * DI core for `hub priority` / `hub decide`. Injected llm + resolved outVault
 * keep tests offline. Ranks (judge order), renders, writes <outVault>/priority.md,
 * prints ranked summary to stdout.
 *
 * Missing outVault dir → clear stderr + process.exitCode=1, NEVER throws.
 */
export async function runHubPriority(
  findings: Finding[],
  scope: Scope,
  llm: LLMClient,
  outVault: string,
  now: Date,
): Promise<void> {
  if (!(await fileExists(outVault))) {
    process.stderr.write(
      chalk.red(
        `kb-hub vault not found at ${outVault} — create it or set hub.outVault in bober.config.json\n`,
      ),
    );
    process.exitCode = 1;
    return;
  }
  const ranked = await rankFindings(findings, scope, llm, now);
  const label = buildScopeLabel(scope);
  const md = renderPriorityMd(ranked, label, now);
  const target = priorityMdPath(outVault);
  // dirname(target) === outVault (already exists) — ensureDir is a harmless no-op
  // kept for symmetry with writeLabNote (lab-note.ts:232) and defensive safety.
  await ensureDir(dirname(target));
  await writeFile(target, md, "utf-8");
  for (let i = 0; i < ranked.length; i++) {
    process.stdout.write(`${i + 1}. ${ranked[i]!.title}\n`);
  }
}

// ── registerHubCommand ────────────────────────────────────────────────

export function registerHubCommand(program: Command): void {
  const hubCmd = program
    .command("hub")
    .description("Unified cross-domain priority hub");

  // ── list ────────────────────────────────────────────────────────

  hubCmd
    .command("list")
    .description("Print findings held in the project's own FactStore")
    .action(async () => {
      const projectRoot = await resolveRoot();
      try {
        const ns = await resolveDefaultNamespace(projectRoot);
        await ensureFactsDir(projectRoot, ns);
        const store = new FactStore(factsDbPath(projectRoot, ns));
        try {
          // own findings come first (own store takes priority in dedup)
          const own = new FactStoreFindingSource(store, HUB_SCOPE).read();
          const configuredRepos = await resolveConfiguredRepos(projectRoot);
          const siblings = await resolveSiblingRepos(projectRoot, configuredRepos);
          const sibFindings = collectFindings(siblings, HUB_SCOPE);
          // merge: own first, then sibling findings not already seen
          const seen = new Set(own.map((f) => f.id));
          const merged = [...own];
          for (const f of sibFindings) {
            if (!seen.has(f.id)) {
              seen.add(f.id);
              merged.push(f);
            }
          }
          runHubList({ read: () => merged });
        } finally {
          store.close();
        }
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `Failed to list findings: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── priority ─────────────────────────────────────────────────────

  hubCmd
    .command("priority")
    .description("Rank findings across siblings and write priority.md to the kb-hub vault")
    .option("--domain <domain>", "filter to one domain")
    .option("--due <days>", "filter to findings due within N days")
    .option("--tag <tag>", "filter to a tag")
    .action(async (opts: { domain?: string; due?: string; tag?: string }) => {
      const projectRoot = await resolveRoot();
      try {
        const config = await loadConfig(projectRoot);
        const providers = resolveRoleProviders(config);
        const client = createClient(
          providers.chat,
          config.chat?.endpoint ?? null,
          config.chat?.providerConfig,
          config.chat?.model,
          "chat",
        );
        const configuredRepos = await resolveConfiguredRepos(projectRoot);
        const siblings = await resolveSiblingRepos(projectRoot, configuredRepos);
        const findings = collectFindings(siblings, HUB_SCOPE);
        const scope: Scope =
          opts.domain !== undefined || opts.due !== undefined || opts.tag !== undefined
            ? parseScope({
                mode: "filtered",
                domain: opts.domain,
                tag: opts.tag,
                dueWithinDays: opts.due !== undefined ? Number(opts.due) : undefined,
              })
            : parseScope({ mode: "general" });
        const outVault = await resolveOutVault(projectRoot);
        await runHubPriority(findings, scope, client, outVault, new Date());
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `hub priority failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });

  // ── decide <expr> ─────────────────────────────────────────────────

  hubCmd
    .command("decide <expr>")
    .description("Rank findings under decision scope (e.g. 'X vs Y') and write priority.md")
    .action(async (expr: string) => {
      const projectRoot = await resolveRoot();
      try {
        const parts = expr.split(/\s+vs\s+/i);
        if (parts.length !== 2 || !parts[0]!.trim() || !parts[1]!.trim()) {
          process.stderr.write(
            chalk.red(
              `hub decide: expected 'X vs Y' expression, got: ${expr}\n` +
                `Usage: bober hub decide "option A vs option B"\n`,
            ),
          );
          process.exitCode = 1;
          return;
        }
        const optionA = parts[0]!.trim();
        const optionB = parts[1]!.trim();

        const config = await loadConfig(projectRoot);
        const providers = resolveRoleProviders(config);
        const client = createClient(
          providers.chat,
          config.chat?.endpoint ?? null,
          config.chat?.providerConfig,
          config.chat?.model,
          "chat",
        );
        const configuredRepos = await resolveConfiguredRepos(projectRoot);
        const siblings = await resolveSiblingRepos(projectRoot, configuredRepos);
        const findings = collectFindings(siblings, HUB_SCOPE);
        const scope: Scope = parseScope({ mode: "decision", optionA, optionB });
        const outVault = await resolveOutVault(projectRoot);
        await runHubPriority(findings, scope, client, outVault, new Date());
      } catch (err) {
        process.stderr.write(
          chalk.red(
            `hub decide failed: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
