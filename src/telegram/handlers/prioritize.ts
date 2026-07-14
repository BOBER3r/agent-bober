/**
 * handlers/prioritize.ts — Scoped hub-priority commands (/today, /priority, /decide X vs Y).
 *
 * Pure adapter: parse an ephemeral Scope from the command text, call the injected hub
 * query, render ranked finding titles through the sendSafe funnel.
 * No persistence, no LLM reasoning in this module (nonGoal #5: hub owns all model calls).
 *
 * The production default (defaultPrioritize) invokes the hub CLI in a subprocess via execa
 * so the process isolation is complete — the adapter never constructs an LLM client.
 * Tests pass an injected fake HubQuery to avoid subprocess spawning entirely.
 */
import { execa } from "execa";
import type { Scope } from "../../hub/scope.js";
import { parseScopeFromCommand } from "../router.js";
import { findProjectRoot } from "../../utils/fs.js";
import { resolveCliEntry } from "../../fleet/runner.js";

// ── Types ─────────────────────────────────────────────────────────────

/** Minimal hub-query result. Only title is rendered by this adapter (nonGoal #3). */
export type HubResult = { title: string };

/**
 * Injected hub-query function.
 * Production default: invokes the hub CLI via execa — the subprocess fully owns
 * any LLM calls, keeping the adapter thin (nonGoal #5).
 * Tests: pass a fake returning fixture HubResult objects without any subprocess.
 */
export type HubQuery = (scope: Scope) => Promise<HubResult[]>;

/**
 * Type alias for the `prioritize` parameter in bot.ts.
 * Mirrors InboxCapture for the capture parameter.
 */
export type PrioritizeFn = HubQuery;

// ── defaultPrioritize ─────────────────────────────────────────────────

/**
 * Production HubQuery — invokes the hub CLI in a subprocess via execa.
 * The subprocess fully owns the LLM and any model calls so the adapter
 * never constructs an LLM client (nonGoal #5).
 *
 * Scope → CLI command mapping:
 *   general   → node <cli> hub priority
 *   filtered  → node <cli> hub priority [--due N] [--domain D] [--tag T]
 *   decision  → node <cli> hub decide "optionA vs optionB"
 *
 * Parses `N. <title>` stdout lines into HubResult objects.
 * Exit code ≠ 0 throws (callers see the error in the Telegram reply via sendSafe).
 *
 * bober: one child process per bot command; swap for in-process
 *        rankFindings + collectFindings if subprocess startup latency
 *        exceeds acceptable Telegram response time under load.
 */
export async function defaultPrioritize(scope: Scope): Promise<HubResult[]> {
  const projectRoot = (await findProjectRoot()) ?? process.cwd();
  const cliEntry = resolveCliEntry();

  let cliArgs: string[];
  if (scope.mode === "decision") {
    cliArgs = [cliEntry, "hub", "decide", `${scope.optionA} vs ${scope.optionB}`];
  } else if (scope.mode === "filtered") {
    cliArgs = [cliEntry, "hub", "priority"];
    if (scope.dueWithinDays !== undefined) {
      cliArgs.push("--due", String(scope.dueWithinDays));
    }
    if (scope.domain !== undefined) {
      cliArgs.push("--domain", scope.domain);
    }
    if (scope.tag !== undefined) {
      cliArgs.push("--tag", scope.tag);
    }
  } else {
    // general
    cliArgs = [cliEntry, "hub", "priority"];
  }

  const result = await execa(process.execPath, cliArgs, {
    cwd: projectRoot,
    reject: false,
    all: true,
  });

  if (result.exitCode !== 0) {
    const output = result.all ?? result.stderr ?? "";
    throw new Error(
      `hub priority failed (exit ${result.exitCode ?? -1}): ${output.slice(0, 300)}`,
    );
  }

  // Parse "N. <title>" lines from stdout — the hub CLI prints exactly this format (hub.ts:152-154).
  const lines = (result.stdout ?? "").split("\n");
  const findings: HubResult[] = [];
  for (const line of lines) {
    const match = /^\d+\.\s(.+)$/.exec(line.trim());
    if (match) findings.push({ title: match[1]!.trim() });
  }
  return findings;
}

// ── handlePrioritize ──────────────────────────────────────────────────

/**
 * Handle /today, /priority, and /decide X vs Y commands.
 *
 * 1. Parses an ephemeral Scope from (name, args) via parseScopeFromCommand.
 * 2. Calls the injected hub query with that scope.
 * 3. Returns a numbered list of finding titles in the hub's returned order.
 *
 * ORDER PRESERVED VERBATIM — the hub already ranked the findings;
 * this adapter must NOT re-sort (nonGoal #1).
 *
 * Returns a string for the caller to pass to sendSafe — no transport access here.
 * Unknown commands (parseScopeFromCommand returns null) return the Unknown-command stub.
 */
export async function handlePrioritize(
  name: string,
  args: string,
  query: HubQuery = defaultPrioritize,
): Promise<string> {
  const scope = parseScopeFromCommand(name, args);
  if (scope === null) return `Unknown command: /${name}`;
  const findings = await query(scope);
  if (findings.length === 0) return "No findings to prioritize.";
  return findings.map((f, i) => `${i + 1}. ${f.title}`).join("\n");
}
