/**
 * PreflightContextInjector — ADR-9 Primary KPI Lever.
 *
 * Runs deterministic per-role graph queries before each agent spawn.
 * Formats results as markdown and prepends to the agent's first message.
 *
 * Key invariants:
 * - DETERMINISTIC: same contract + role → same output. No LLM in this path.
 * - NEVER BLOCKS SPAWN: 5s timeout + try/catch; returns firstMessage unchanged on failure.
 * - RESEARCHER-PHASE2 ISOLATION: NEVER uses contract.title/description/feature text.
 *   Uses ONLY overrides.questionKeywords.
 * - graph.enabled=false or engineHealth!='ready' → returns firstMessage unchanged.
 */

import { execa } from "execa";
import type { GraphClient } from "./client.js";
import type { GraphSection } from "./types.js";
import type { SprintContract } from "../contracts/sprint-contract.js";
import type { IncidentLog } from "./incidents.js";
import type { PrefetchSpec, GraphResult, NodeRef, ImpactReport, SearchHit } from "./types.js";
import { enforceBudget } from "./preflight-budgets.js";
import { graphPipelineLifecycle } from "./pipeline-lifecycle.js";
import type { GraphArtifactStore } from "./artifact-store.js";
import { appendHistory, type Phase } from "../state/history.js";

// ── Types ──────────────────────────────────────────────────────────

export type BoberAgentRole =
  | "planner"
  | "researcher-phase1"
  | "researcher-phase2"
  | "architect"
  | "curator"
  | "generator"
  | "evaluator";

/** Derived input for QUERY_BATCHES — computed from contract defensively. */
interface PreflightInput {
  symbols: string[];         // for impact/query targets (NodeRef[] would be ideal; strings used as fallback)
  keywords: string[];        // for Curator search
  questionKeywords: string[]; // for Researcher-Phase2 search — MUST be feature-free
  baselineSha: string;       // for Evaluator changes
}

/** Optional overrides for inject() callers (e.g. pipeline.ts Phase 2 call site). */
export interface InjectOverrides {
  questionKeywords?: string[];
  baselineSha?: string;
}

/**
 * Maps an agent role to the pipeline phase recorded in graph-preflight
 * telemetry (the `phase` field required by HistoryEntrySchema).
 */
const ROLE_TO_PHASE: Record<BoberAgentRole, Phase> = {
  planner: "planning",
  "researcher-phase1": "planning",
  "researcher-phase2": "planning",
  architect: "planning",
  curator: "curating",
  generator: "generating",
  evaluator: "evaluating",
};

// ── Query batch definitions ────────────────────────────────────────

/**
 * Per-role deterministic query batch factory functions.
 *
 * Each function receives a PreflightInput and returns a PrefetchSpec[].
 * The batch is deterministic: same input → same specs → same output.
 *
 * CRITICAL: 'researcher-phase2' uses ONLY input.questionKeywords.
 * It MUST NOT access contract.title, contract.description, or contract.feature.
 * The PreflightInput for this role is built exclusively from overrides.questionKeywords.
 */
export const QUERY_BATCHES: Record<BoberAgentRole, (c: PreflightInput) => PrefetchSpec[]> = {
  // planner and researcher-phase1 do not use graph tools — no preflight queries.
  planner: () => [],
  "researcher-phase1": () => [],
  architect: (c) => {
    const specs: PrefetchSpec[] = [
      { key: "overview", op: "overview", args: {} },
    ];
    for (let i = 0; i < c.symbols.length; i++) {
      specs.push({
        key: `imports-of-${i}`,
        op: "query",
        args: { pattern: "imports_of", target: symbolToNodeRef(c.symbols[i]!) },
      });
    }
    return specs;
  },

  curator: (c) => {
    const specs: PrefetchSpec[] = [];
    if (c.keywords.length > 0) {
      specs.push({
        key: "search",
        op: "search",
        args: { q: c.keywords.join(" ") },
      });
    }
    for (let i = 0; i < c.symbols.length; i++) {
      specs.push({
        key: `callers-of-${i}`,
        op: "query",
        args: { pattern: "callers_of", target: symbolToNodeRef(c.symbols[i]!) },
      });
      specs.push({
        key: `tests-for-curator-${i}`,
        op: "query",
        args: { pattern: "tests_for", target: symbolToNodeRef(c.symbols[i]!) },
      });
    }
    return specs;
  },

  generator: (c) => {
    const specs: PrefetchSpec[] = [];
    for (let i = 0; i < c.symbols.length; i++) {
      specs.push({
        key: `impact-${i}`,
        op: "impact",
        args: { target: symbolToNodeRef(c.symbols[i]!) },
      });
      specs.push({
        key: `tests-for-gen-${i}`,
        op: "query",
        args: { pattern: "tests_for", target: symbolToNodeRef(c.symbols[i]!) },
      });
    }
    return specs;
  },

  evaluator: (c) => [
    {
      key: "changes",
      op: "changes",
      args: { since: c.baselineSha || "HEAD~1" },
    },
  ],

  "researcher-phase2": (c) => {
    // ISOLATION GUARANTEE: uses ONLY c.questionKeywords.
    // c.symbols and c.keywords are ALWAYS empty for this role (enforced in inject()).
    const specs: PrefetchSpec[] = [
      { key: "overview", op: "overview", args: {} },
    ];
    if (c.questionKeywords.length > 0) {
      specs.push({
        key: "search",
        op: "search",
        args: { q: c.questionKeywords.join(" ") },
      });
    }
    return specs;
  },
};

// ── Helper: derive PreflightInput from a SprintContract ───────────

/**
 * Derive PreflightInput fields from a SprintContract.
 *
 * SprintContract does NOT have symbols/keywords/questionKeywords/baselineSha fields.
 * This function derives them defensively:
 *
 * - symbols: file basenames from estimatedFiles, stripped of extensions.
 *   These are the files the sprint will touch — a good proxy for affected symbols.
 * - keywords: unique tokens (length >= 4) from title + description, top 8.
 *   Used by Curator search to find relevant code.
 * - questionKeywords: ALWAYS empty here. Populated only via overrides.questionKeywords
 *   (for researcher-phase2 call sites that pass Phase 1 question tokens).
 * - baselineSha: defaults to "HEAD~1"; can be overridden via overrides.baselineSha.
 */
export function deriveFromContract(contract: SprintContract | null): PreflightInput {
  if (!contract) {
    return { symbols: [], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
  }

  // symbols: extract file basenames from estimatedFiles, remove extensions
  const symbols = contract.estimatedFiles
    .map((p) => {
      const parts = p.split("/");
      return parts[parts.length - 1] ?? p;
    })
    .map((b) => b.replace(/\.[tj]sx?$/, ""))
    .filter((s): s is string => s.length > 0);

  // keywords: unique tokens from title + description (minLen=4, top 8)
  const text = `${contract.title} ${contract.description}`;
  const keywords = uniqueTokens(text, { minLen: 4, max: 8 });

  return {
    symbols,
    keywords,
    questionKeywords: [], // NEVER derived from contract — must come from overrides
    baselineSha: "HEAD~1",
  };
}

/**
 * Extract unique meaningful tokens from text.
 * Lowercases, strips non-alphanumeric, deduplicates, limits by minLen and count.
 */
function uniqueTokens(text: string, opts: { minLen: number; max: number }): string[] {
  const seen = new Set<string>();
  const tokens: string[] = [];
  for (const word of text.toLowerCase().split(/[\s\-_/.,;:()[\]{}'"!?]+/)) {
    if (word.length >= opts.minLen && !seen.has(word)) {
      seen.add(word);
      tokens.push(word);
      if (tokens.length >= opts.max) break;
    }
  }
  return tokens;
}

/** Build a minimal NodeRef from a symbol name string (for query/impact targets). */
function symbolToNodeRef(symbol: string): NodeRef {
  return { id: symbol, kind: "function", file: symbol, line: 0, symbol };
}

// ── Stale banner construction ──────────────────────────────────────

/**
 * Build a stale-data banner by probing git for both SHAs and commit delta.
 *
 * Format: `_⚠ Graph indexed at SHA <X>; current HEAD is <Y> (N commits behind). Context may be outdated._`
 *
 * Both SHAs are shortened to 7 chars. Commits-behind is computed via
 * `git rev-list --count <lastSha>..<HEAD>`. Falls back gracefully if git
 * is unavailable or the manifest has no lastSyncedHeadSha.
 */
async function buildStaleBanner(
  projectRoot: string,
  artifactStore: GraphArtifactStore,
): Promise<string | null> {
  try {
    const manifest = await artifactStore.readManifest();
    const lastSha = manifest?.lastSyncedHeadSha;

    // Get current HEAD SHA
    const headResult = await execa("git", ["rev-parse", "HEAD"], {
      cwd: projectRoot,
      reject: false,
      timeout: 2000,
    });
    const currentSha = headResult.exitCode === 0 ? headResult.stdout.trim() : null;

    if (!lastSha && !currentSha) {
      return `_⚠ Graph data may be outdated. Context may be stale._`;
    }

    const shortLast = lastSha ? lastSha.slice(0, 7) : "unknown";
    const shortCurrent = currentSha ? currentSha.slice(0, 7) : "unknown";

    // Get commits-behind count
    let commitsBehind = 0;
    if (lastSha && currentSha && lastSha !== currentSha) {
      try {
        const revResult = await execa(
          "git",
          ["rev-list", "--count", `${lastSha}..HEAD`],
          { cwd: projectRoot, reject: false, timeout: 2000 },
        );
        if (revResult.exitCode === 0) {
          commitsBehind = parseInt(revResult.stdout.trim(), 10) || 0;
        }
      } catch {
        // Ignore git errors — we'll fall back to no commit count
      }
    }

    const behindStr = commitsBehind > 0 ? ` (${commitsBehind} commits behind)` : "";
    return `_⚠ Graph indexed at SHA ${shortLast}; current HEAD is ${shortCurrent}${behindStr}. Context may be outdated._`;
  } catch {
    return `_⚠ Graph data may be outdated. Context may be stale._`;
  }
}

// ── Markdown formatters ────────────────────────────────────────────

function formatNodeRefs(nodes: NodeRef[]): string {
  if (nodes.length === 0) return "_No results._";
  return nodes.map((n) => `- ${n.file}:${n.line} (${n.kind}) ${n.symbol}`).join("\n");
}

function formatSearchHits(hits: SearchHit[]): string {
  if (hits.length === 0) return "_No results._";
  return hits
    .map((h) => `- ${h.node.file}:${h.node.line} (${h.node.kind}) ${h.node.symbol} — score: ${h.score.toFixed(2)}`)
    .join("\n");
}

function formatImpactReport(report: ImpactReport): string {
  const lines: string[] = [];
  lines.push(`**Root:** ${report.root.file}:${report.root.line} (${report.root.kind}) ${report.root.symbol}`);
  if (report.affected.length > 0) {
    lines.push(`\n**Affected (${report.affected.length}):**`);
    lines.push(...report.affected.map((n) => `- ${n.file}:${n.line} (${n.kind}) ${n.symbol}`));
  }
  if (report.testsAffected.length > 0) {
    lines.push(`\n**Tests affected (${report.testsAffected.length}):**`);
    lines.push(...report.testsAffected.map((n) => `- ${n.file}:${n.line} (${n.kind}) ${n.symbol}`));
  }
  return lines.join("\n") || "_No impact data._";
}

/**
 * Format a single successful query result as a markdown `### Section` block.
 *
 * @param key   The PrefetchSpec key (used to derive section heading).
 * @param spec  The original PrefetchSpec (for metadata about op/args).
 * @param data  The raw graph result data.
 */
function formatResultSection(
  _key: string,
  spec: PrefetchSpec,
  data: unknown,
): string {
  const heading = headingForSpec(spec);
  const body = bodyForData(spec, data);
  return `### ${heading}\n\n${body}`;
}

function headingForSpec(spec: PrefetchSpec): string {
  switch (spec.op) {
    case "overview":
      return "Overview";
    case "search": {
      const args = spec.args as { q?: string };
      return `Search: "${args.q ?? ""}"`;
    }
    case "query": {
      const args = spec.args as { pattern?: string; target?: NodeRef };
      const symbol = args.target?.symbol ?? args.target?.id ?? "";
      switch (args.pattern) {
        case "callers_of":
          return `Callers of ${symbol}`;
        case "imports_of":
          return `Imports of ${symbol}`;
        case "tests_for":
          return `Tests covering ${symbol}`;
        case "callees_of":
          return `Callees of ${symbol}`;
        default:
          return `Query: ${args.pattern ?? "unknown"}`;
      }
    }
    case "impact": {
      const args = spec.args as { target?: NodeRef | string };
      const sym =
        typeof args.target === "string"
          ? args.target
          : (args.target as NodeRef | undefined)?.symbol ?? "unknown";
      return `Impact radius of ${sym}`;
    }
    case "changes": {
      const args = spec.args as { since?: string };
      return `Changes since ${args.since ?? "baseline"}`;
    }
    case "reviewContext":
      return "Review Context";
    default:
      return "Graph Result";
  }
}

function bodyForData(spec: PrefetchSpec, data: unknown): string {
  switch (spec.op) {
    case "overview":
    case "reviewContext":
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
    case "search":
      return formatSearchHits(data as SearchHit[]);
    case "query":
    case "changes":
      return formatNodeRefs(data as NodeRef[]);
    case "impact":
      return formatImpactReport(data as ImpactReport);
    default:
      return typeof data === "string" ? data : JSON.stringify(data, null, 2);
  }
}

// ── PreflightContextInjector ───────────────────────────────────────

/**
 * Builds and injects deterministic graph context into agent first messages.
 *
 * Constructor takes a GraphClient (may be null if engine not ready) and a
 * GraphSection config. inject() is the only public method.
 *
 * Usage in agent files:
 * ```typescript
 * const injector = new PreflightContextInjector(graphPipelineLifecycle.getGraphClient(), config.graph);
 * const msg = await injector.inject("curator", contract, userMessage);
 * ```
 */
export class PreflightContextInjector {
  constructor(
    private readonly client: GraphClient | null,
    private readonly config: GraphSection | undefined,
    private readonly incidents?: IncidentLog,
    private readonly projectRoot?: string,
    private readonly artifactStore?: GraphArtifactStore,
  ) {}

  /**
   * Inject pre-flight graph context into a first message.
   *
   * Fast-path: returns firstMessage UNCHANGED when:
   * - graph.enabled !== true
   * - client is null
   * - engineHealth !== 'ready'
   *
   * Timeout: 5000ms. On timeout or any error, logs an incident and returns
   * firstMessage unchanged. Agent spawn is NEVER blocked.
   *
   * Researcher-Phase2 isolation: NEVER uses contract.title/description/feature.
   * Uses ONLY overrides.questionKeywords. Passing a non-null contract for
   * researcher-phase2 is defensively handled — feature text is still NOT used.
   *
   * @param role         Agent role string.
   * @param contract     Sprint contract (or null for research phase / architect).
   * @param firstMessage The agent's first user message.
   * @param overrides    Optional overrides: questionKeywords, baselineSha.
   */
  async inject(
    role: BoberAgentRole,
    contract: SprintContract | null,
    firstMessage: string,
    overrides?: InjectOverrides,
  ): Promise<string> {
    // Fast-path: graph disabled → zero overhead and NO telemetry, matching the
    // opt-in philosophy (projects that never enable the graph pay nothing).
    if (!this.config?.enabled) {
      return firstMessage;
    }

    // From here the graph IS enabled, so every outcome — including skips — is
    // recorded. This is what makes "is the graph actually firing?" answerable
    // from .bober/history.jsonl rather than a matter of faith.
    const startedAt = Date.now();
    const health = graphPipelineLifecycle.engineHealth();

    // Enabled but no client wired in.
    if (!this.client) {
      await this.recordTelemetry(
        role, contract, "skipped-no-client", false, 0, Date.now() - startedAt, health, false,
      );
      return firstMessage;
    }

    // Enabled but engine not ready (starting/syncing/disabled).
    if (health !== "ready") {
      await this.recordTelemetry(
        role, contract, "skipped-engine-not-ready", false, 0, Date.now() - startedAt, health, false,
      );
      return firstMessage;
    }

    try {
      const result = await Promise.race([
        this.runInject(role, contract, firstMessage, overrides),
        new Promise<string>((_, reject) =>
          setTimeout(() => reject(new Error("preflight-timeout-5000ms")), 5000),
        ),
      ]);
      const charsAdded = result.length - firstMessage.length;
      const injected = charsAdded > 0;
      const partialFailure = result.includes("queries unavailable");
      const outcome = !injected
        ? "no-context"
        : partialFailure
          ? "degraded"
          : "injected";
      await this.recordTelemetry(
        role, contract, outcome, injected, charsAdded, Date.now() - startedAt, health, partialFailure,
      );
      return result;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      // Log incident; return ORIGINAL firstMessage so spawn proceeds.
      try {
        if (this.incidents) {
          await this.incidents.append({
            ts: new Date().toISOString(),
            event: "preflight-failure",
            role,
            detail: msg,
          });
        }
      } catch {
        // Swallow — incident write failure must not break spawn
      }
      await this.recordTelemetry(
        role, contract, /timeout/.test(msg) ? "timeout" : "error",
        false, 0, Date.now() - startedAt, health, false,
      );
      return firstMessage;
    }
  }

  /**
   * Record one `graph-preflight` telemetry event to .bober/history.jsonl.
   *
   * Resolves a project root by preferring the constructor-injected projectRoot,
   * then the active pipeline lifecycle singleton — so telemetry fires for every
   * role even though most call sites construct the injector with only
   * (client, config). Best-effort: any failure is swallowed so telemetry can
   * NEVER break an agent spawn.
   *
   * Each row answers the runtime question directly: did graph context get added
   * (`injected`), roughly how many tokens (`approxTokensAdded`), under what
   * `outcome`, and how long the preflight took (`elapsedMs`).
   */
  private async recordTelemetry(
    role: BoberAgentRole,
    contract: SprintContract | null,
    outcome: string,
    injected: boolean,
    charsAdded: number,
    elapsedMs: number,
    engineHealth: string,
    partialFailure: boolean,
  ): Promise<void> {
    try {
      // Root resolution is INSIDE the try: projectRootOrNull() may be absent on
      // a test double of the lifecycle singleton, and a thrown TypeError here
      // must NOT escape — telemetry can never break an agent spawn.
      const root = this.projectRoot ?? graphPipelineLifecycle.projectRootOrNull?.() ?? null;
      if (!root) return;
      await appendHistory(root, {
        timestamp: new Date().toISOString(),
        event: "graph-preflight",
        phase: ROLE_TO_PHASE[role],
        sprintId: contract?.contractId,
        details: {
          role,
          outcome,
          injected,
          charsAdded,
          // Rough heuristic (~4 chars/token); telemetry only, not billing.
          approxTokensAdded: Math.max(0, Math.round(charsAdded / 4)),
          budgetTokens: this.getBudgetForRole(role),
          engineHealth,
          elapsedMs,
          partialFailure,
        },
      });
    } catch {
      // Telemetry must NEVER break agent spawn.
    }
  }

  /** Core injection logic — called by inject() within the timeout race. */
  private async runInject(
    role: BoberAgentRole,
    contract: SprintContract | null,
    firstMessage: string,
    overrides?: InjectOverrides,
  ): Promise<string> {
    // Build the PreflightInput for this role.
    // CRITICAL: researcher-phase2 NEVER uses contract fields — isolation invariant.
    let input: PreflightInput;
    if (role === "researcher-phase2") {
      // Isolation: ALWAYS build from overrides.questionKeywords only.
      // Even if contract is non-null, we do NOT touch its title/description/feature.
      input = {
        symbols: [],
        keywords: [],
        questionKeywords: overrides?.questionKeywords ?? [],
        baselineSha: "",
      };
    } else if (contract) {
      input = deriveFromContract(contract);
      if (overrides?.questionKeywords) {
        input.questionKeywords = overrides.questionKeywords;
      }
      if (overrides?.baselineSha) {
        input.baselineSha = overrides.baselineSha;
      }
    } else {
      // null contract for non-Phase2 roles (e.g., Architect before planning)
      input = { symbols: [], keywords: [], questionKeywords: [], baselineSha: "HEAD~1" };
      if (overrides?.questionKeywords) {
        input.questionKeywords = overrides.questionKeywords;
      }
      if (overrides?.baselineSha) {
        input.baselineSha = overrides.baselineSha;
      }
    }

    // Get the query batch for this role
    const batchFactory = QUERY_BATCHES[role];
    const specs = batchFactory(input);

    // If no specs (e.g. no symbols and no keywords), return unchanged
    if (specs.length === 0) {
      return firstMessage;
    }

    // Execute the batch via GraphClient.prefetch
    const results = await this.client!.prefetch(specs);

    // Build markdown sections from successful results
    const sections: string[] = [];
    let anyFailed = false;

    for (const spec of specs) {
      const result = results[spec.key] as GraphResult<unknown> | undefined;
      if (!result) {
        anyFailed = true;
        continue;
      }
      if (result.ok) {
        const section = formatResultSection(spec.key, spec, result.data);
        sections.push(section);
      } else {
        anyFailed = true;
      }
    }

    // If ALL queries failed and we have no content, return a minimal note
    if (sections.length === 0) {
      const warning = "_⚠ Some graph queries unavailable; agent may need to fall back to grep where applicable._";
      return `${firstMessage}\n\n## Codebase Context (graph)\n\n${warning}`;
    }

    // Assemble markdown body
    let bodyMarkdown = sections.join("\n\n");
    if (anyFailed) {
      bodyMarkdown += "\n\n_⚠ Some graph queries unavailable; agent may need to fall back to grep where applicable._";
    }

    // Apply token budget
    const budget = this.getBudgetForRole(role);
    const { out: budgetedBody } = enforceBudget(bodyMarkdown, budget);

    // Build stale banner (if applicable and artifactStore available)
    let staleBanner = "";
    if (this.artifactStore && this.projectRoot) {
      try {
        const staleness = await this.artifactStore.staleness();
        if (staleness.stale) {
          const banner = await buildStaleBanner(this.projectRoot, this.artifactStore);
          if (banner) staleBanner = `${banner}\n\n`;
        }
      } catch {
        // Stale check failure must not break injection
      }
    }

    // Assemble final markdown: stale banner + header + body
    const contextSection = `${staleBanner}## Codebase Context (graph)\n\n${budgetedBody}`;

    // Prepend context section to firstMessage
    return `${contextSection}\n\n${firstMessage}`;
  }

  /** Look up the token budget for a given role from config, with fallback to defaults. */
  private getBudgetForRole(role: BoberAgentRole): number {
    const budgets = (this.config as { preflightBudgets?: Record<string, number> } | undefined)
      ?.preflightBudgets;

    if (!budgets) {
      // Fallback defaults (planner and researcher-phase1 have budget 0 — not gated roles)
      const DEFAULTS: Record<BoberAgentRole, number> = {
        planner: 0,
        "researcher-phase1": 0,
        architect: 4000,
        curator: 2000,
        generator: 1000,
        evaluator: 1500,
        "researcher-phase2": 3000,
      };
      return DEFAULTS[role];
    }

    // Map camelCase config key to role string
    const camelKey: Record<BoberAgentRole, string> = {
      planner: "planner",
      "researcher-phase1": "researcherPhase1",
      architect: "architect",
      curator: "curator",
      generator: "generator",
      evaluator: "evaluator",
      "researcher-phase2": "researcherPhase2",
    };
    const key = camelKey[role];
    const val = budgets[key];
    if (typeof val === "number" && val > 0) return val;

    // fallback defaults
    const DEFAULTS: Record<BoberAgentRole, number> = {
      planner: 0,
      "researcher-phase1": 0,
      architect: 4000,
      curator: 2000,
      generator: 1000,
      evaluator: 1500,
      "researcher-phase2": 3000,
    };
    return DEFAULTS[role];
  }
}

// ── Keyword extraction helper (exported for pipeline.ts call sites) ─

/**
 * Extract meaningful search keywords from a block of text (e.g. Phase 1 questions).
 *
 * Used by pipeline.ts to derive overrides.questionKeywords for researcher-phase2
 * from the Phase 1 questions array.
 *
 * Returns up to 10 unique tokens of length >= 5, lowercased.
 * Does NOT preserve the original text — the output is transformed tokens only,
 * which is safe to pass to researcher-phase2 (no feature text leak).
 */
export function extractKeywords(text: string): string[] {
  return uniqueTokens(text, { minLen: 5, max: 10 });
}
