// ── chat-session.ts ───────────────────────────────────────────────────
//
// ChatSession: the main turn loop for `bober chat`.
// Per turn: classify → answer (or slash-dispatch) → persist.

import * as readline from "node:readline";

import type { LLMClient } from "../providers/types.js";
import { loadLessonIndex, loadLesson } from "../state/memory.js";
import { ConversationStore } from "./conversation-store.js";
import { RosterReader } from "./roster-reader.js";
import { TurnClassifier } from "./turn-classifier.js";
import { Answerer } from "./answerer.js";
import { dispatch } from "./slash-commands.js";
import { RunSpawner } from "./run-spawner.js";
import { CompletionTailer } from "./completion-tailer.js";
import type { CompletionEvent } from "./completion-tailer.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ChatSessionOptions {
  llm: LLMClient;
  projectRoot: string;
  sessionId?: string;
  /** Override readline interface for testing (omit to use stdin/stdout). */
  rl?: readline.Interface;
  /** Injected RunSpawner for testing (omit to use a real instance). */
  spawner?: RunSpawner;
  /** Injected clock for deterministic runId generation in tests. */
  now?: () => number;
  /** Injected CompletionTailer for testing (omit to use a real instance). */
  tailer?: CompletionTailer;
  /**
   * Memory namespace for the active team. Omit (or pass "") for the default
   * programming team, which resolves to the current .bober/memory/ path.
   * Sprint 2: threaded through buildMemoryDistill so a named team reads its own subdir.
   */
  memoryNamespace?: string;
}

// ── Memory distill helper ─────────────────────────────────────────────

/**
 * Compose a compact memory distill string from the team's namespaced .bober/memory/ path.
 * Returns empty string if no lessons are recorded.
 * namespace undefined or "" reads the default .bober/memory/ path (programming team / back-compat).
 */
async function buildMemoryDistill(projectRoot: string, namespace?: string): Promise<string> {
  try {
    const index = await loadLessonIndex(projectRoot, { limit: 10 }, namespace);
    if (index.length === 0) return "";

    const lines: string[] = ["Recent lessons learned:"];
    for (const record of index) {
      try {
        const lesson = await loadLesson(projectRoot, record.lessonId, namespace);
        lines.push(`- [${lesson.severity}] ${lesson.summary}`);
      } catch {
        lines.push(`- ${record.summarySnippet}`);
      }
    }
    return lines.join("\n");
  } catch {
    return "";
  }
}

// ── ChatSession ───────────────────────────────────────────────────────

export class ChatSession {
  private readonly llm: LLMClient;
  private readonly projectRoot: string;
  private readonly sessionId: string;
  private readonly store: ConversationStore;
  private readonly roster: RosterReader;
  private readonly classifier: TurnClassifier;
  private readonly answerer: Answerer;
  private readonly spawner: RunSpawner;
  private readonly tailer: CompletionTailer;
  private readonly nowFn: () => number;
  // bober: using "opus" as default model; the CLI wires in config.chat?.model via createClient
  private readonly model: string = "opus";
  /** Memory namespace for the active team; undefined means the default .bober/memory/ path. */
  private readonly memoryNamespace: string | undefined;

  constructor(opts: ChatSessionOptions) {
    this.llm = opts.llm;
    this.projectRoot = opts.projectRoot;
    this.sessionId = opts.sessionId ?? "default";
    this.memoryNamespace = opts.memoryNamespace || undefined;
    this.store = new ConversationStore(this.projectRoot, this.sessionId);
    this.roster = new RosterReader(this.projectRoot);
    this.classifier = new TurnClassifier(this.llm, this.model);
    this.answerer = new Answerer(this.llm, this.model);
    this.nowFn = opts.now ?? (() => Date.now());
    this.spawner =
      opts.spawner ??
      new RunSpawner({
        projectRoot: this.projectRoot,
        sessionId: this.sessionId,
      });
    this.tailer =
      opts.tailer ??
      new CompletionTailer(this.projectRoot, this.sessionId);
  }

  /** Generate a session-scoped runId using the injected clock. */
  private nextRunId(): string {
    return `run-${this.nowFn()}`;
  }

  /**
   * Handle a single turn: slash-dispatch or classify→answer→persist.
   * Returns the assistant reply string, or null for /exit.
   */
  async handleTurn(input: string): Promise<string | null> {
    // ── Poll for run completions (prelude — runs before slash or LLM path) ─
    let completions: CompletionEvent[] = [];
    try {
      completions = await this.tailer.poll();
    } catch {
      // Poll errors must never break the turn
    }

    // ── Slash commands (deterministic, no LLM) ─────────────────────────
    const slashResult = await dispatch(
      input,
      this.roster,
      (runId) => this.handleStop(runId),
    );
    if (slashResult.handled) {
      if (slashResult.exit) return null;
      let output = slashResult.output ?? "";
      // Weave completion notices into slash-command reply as well
      if (completions.length > 0) {
        const notices = completions
          .map((c) => `[run ${c.runId ?? "unknown"} finished: ${c.phase}]`)
          .join("\n");
        output = `${notices}\n\n${output}`;
      }
      // Persist slash command turns for transparency
      await this.store.append({ role: "user", content: input, ts: new Date().toISOString() });
      await this.store.append({ role: "assistant", content: output, ts: new Date().toISOString() });
      return output;
    }

    // ── LLM path: read context ────────────────────────────────────────
    const [states, memoryDistill, recentHistory] = await Promise.all([
      this.roster.read(),
      buildMemoryDistill(this.projectRoot, this.memoryNamespace),
      this.store.loadRecent(20),
    ]);
    const rosterSummary = this.roster.summarize(states);

    // ── Classify ──────────────────────────────────────────────────────
    const action = await this.classifier.classify(input);

    let reply: string;

    if (action.action === "answer") {
      reply = await this.answerer.answer(input, rosterSummary, memoryDistill, recentHistory);
    } else if (action.action === "spawn") {
      const runId = this.nextRunId();
      const ack = await this.spawner.spawn(action.task, runId);
      reply = ack.spawnError
        ? `Failed to launch run ${runId}: ${ack.spawnError}`
        : `Launched run ${runId} for: ${action.task}. Use /runs to track it.`;
    } else if (action.action === "steer") {
      if (action.op === "inspect") {
        reply = this.roster.summarize(states);
      } else {
        // op === "stop", action.runId: string
        reply = await this.handleStop(action.runId);
      }
    } else {
      // Unknown action — should not happen given the classifier union
      reply = `Unrecognised action. For now, try /help for available commands.`;
    }

    // ── Weave completion notices ───────────────────────────────────────
    if (completions.length > 0) {
      const notices = completions
        .map((c) => `[run ${c.runId ?? "unknown"} finished: ${c.phase}]`)
        .join("\n");
      reply = `${notices}\n\n${reply}`;
    }

    // ── Persist ───────────────────────────────────────────────────────
    const now = new Date().toISOString();
    await this.store.append({ role: "user", content: input, ts: now });
    await this.store.append({ role: "assistant", content: reply, ts: now });

    return reply;
  }

  /**
   * Stop a run by resolving it against the current disk roster, then calling
   * RunSpawner.stop. Shared by /stop <runId> (deterministic slash path) and
   * classifier steer:stop (natural-language path). Never reaches the LLM.
   */
  private async handleStop(runId: string): Promise<string> {
    // Resolve against disk roster at stop-time (sc-4-7 — not from spawn-time memory)
    const states = await this.roster.read();
    const target = states.find((s) => s.runId === runId && s.status === "running");
    if (!target) return `No such running run: ${runId}`;

    const result = await this.spawner.stop(runId, "Stopped via chat");
    return result.killedPid !== undefined
      ? `Stopped run ${runId} (killed pid ${result.killedPid}).`
      : `Stopped run ${runId} (no live process found; marked aborted).`;
  }

  /**
   * Start an interactive REPL loop reading from stdin.
   * Use handleTurn() directly in tests instead.
   */
  async start(): Promise<void> {
    const rl = readline.createInterface({
      input: process.stdin,
      output: process.stdout,
      terminal: false,
    });

    process.stdout.write(
      "bober chat — type a question, /help for commands, /exit to quit\n> ",
    );

    for await (const line of rl) {
      const input = line.trim();
      if (!input) {
        process.stdout.write("> ");
        continue;
      }

      try {
        const reply = await this.handleTurn(input);
        if (reply === null) {
          process.stdout.write("Goodbye.\n");
          rl.close();
          return;
        }
        process.stdout.write(`${reply}\n> `);
      } catch (err) {
        process.stderr.write(
          `Error: ${err instanceof Error ? err.message : String(err)}\n> `,
        );
      }
    }
  }
}
