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
import { CarefulSidecar } from "./careful-sidecar.js";
import { CompletionTailer } from "./completion-tailer.js";
import type { CompletionEvent } from "./completion-tailer.js";
import { ApprovalReader } from "./approval-reader.js";
import { ApprovalCursor } from "./approval-cursor.js";
import { writeRunState } from "../state/run-state.js";
import {
  saveApproved,
  saveRejected,
  pendingExists,
} from "../state/approval-state.js";
import { appendGuidance, hasRunDir } from "../state/guidance.js";
import { setPaused, clearPaused } from "../state/pause.js";
import type { ApprovedMarker, RejectedMarker } from "../state/approval-state.js";
import { resolveApprover } from "../cli/commands/approve.js";
import { cleanupTerminalRun } from "./steer-cleanup.js";

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
  /** Injected ApprovalReader for testing (omit to use a real instance). */
  approvalReader?: ApprovalReader;
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
  private readonly approvalReader: ApprovalReader;
  private readonly approvalCursor: ApprovalCursor;
  private readonly nowFn: () => number;
  // bober: using "opus" as default model; the CLI wires in config.chat?.model via createClient
  private readonly model: string = "opus";
  /** Memory namespace for the active team; undefined means the default .bober/memory/ path. */
  private readonly memoryNamespace: string | undefined;
  /** Phase 2: persists the per-session careful-mode toggle. */
  private readonly carefulSidecar: CarefulSidecar;

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
    this.approvalReader =
      opts.approvalReader ?? new ApprovalReader(this.projectRoot);
    this.approvalCursor = new ApprovalCursor(this.projectRoot, this.sessionId);
    this.carefulSidecar = new CarefulSidecar(this.projectRoot, this.sessionId);
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

    // ── Cleanup hygiene for runs that just went terminal (Sprint 6) ────────
    for (const c of completions) {
      if (c.runId) {
        try {
          await cleanupTerminalRun(this.projectRoot, c.runId);
        } catch {
          // best-effort — a cleanup failure must never break the turn
        }
      }
    }

    // ── Poll for pending approvals (prelude) ──────────────────────────────
    let approvalNotice = "";
    try {
      const pending = await this.approvalReader.read();
      if (pending.length > 0) {
        const fresh = await this.approvalCursor.filterNew(pending);
        if (fresh.length > 0) {
          // Reflect correlated markers onto running RunStates (idempotent)
          const states = await this.roster.read();
          for (const m of fresh) {
            if (m.runId) {
              const state = states.find(
                (s) => s.runId === m.runId && s.status === "running",
              );
              if (state) {
                await writeRunState(this.projectRoot, {
                  ...state,
                  status: "input-required",
                  pendingCheckpointId: m.checkpointId,
                  pendingPrompt: m.prompt,
                  pendingSince: m.requestedAt,
                });
              }
            }
          }
          // Build the notice string
          const notices = fresh
            .map(
              (m) =>
                `[run ${m.runId ?? "unknown"} waiting at ${m.checkpointId}: ${m.prompt}]`,
            )
            .join("\n");
          approvalNotice = notices;
        }
      }
    } catch {
      // Approval read errors must never break the turn
    }

    // ── Slash commands (deterministic, no LLM) ─────────────────────────
    const slashResult = await dispatch(
      input,
      this.roster,
      (runId) => this.handleStop(runId),
      (arg) => this.handleCareful(arg),
      (id) => this.handleApprove(id),
      (id, fb) => this.handleReject(id, fb),
      (runId, text) => this.handleTell(runId, text),
      (runId) => this.handlePause(runId),
      (runId) => this.handleResume(runId),
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
      // Weave approval notices into slash-command reply
      if (approvalNotice) {
        output = `${approvalNotice}\n\n${output}`;
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
      const careful = await this.carefulSidecar.isCareful();
      const ack = await this.spawner.spawn(action.task, runId, { careful });
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
    } else if (action.action === "approve" || action.action === "reject") {
      const target = await this.resolveCheckpoint(action.checkpointId);
      if (target.kind === "ambiguous") {
        reply = target.message;
      } else if (action.action === "approve") {
        reply = await this.handleApprove(target.id);
      } else {
        reply = await this.handleReject(target.id, action.feedback ?? "");
      }
    } else if (action.action === "tell") {
      reply = await this.handleTell(action.runId, action.text);
    } else if (action.action === "pause") {
      reply = await this.handlePause(action.runId);
    } else if (action.action === "resume") {
      reply = await this.handleResume(action.runId);
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
    // Weave approval notices into LLM reply
    if (approvalNotice) {
      reply = `${approvalNotice}\n\n${reply}`;
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
   * Handle /careful [on|off].
   * - "on"  → set careful true, return confirmation
   * - "off" → set careful false, return confirmation
   * - undefined/other → report current state
   */
  private async handleCareful(arg: string | undefined): Promise<string> {
    if (arg === "on") {
      await this.carefulSidecar.setCareful(true);
      return "Careful mode ON — new runs will pause at curated gates.";
    } else if (arg === "off") {
      await this.carefulSidecar.setCareful(false);
      return "Careful mode OFF — new runs will run in autopilot.";
    } else {
      const current = await this.carefulSidecar.isCareful();
      return `Careful mode is currently ${current ? "ON" : "OFF"}. Use /careful on or /careful off to toggle.`;
    }
  }

  /**
   * Approve a pending checkpoint: guard with pendingExists, write the marker,
   * clear the correlated RunState pending fields, and return an ack string.
   * Returns a "no pending checkpoint" message and writes nothing if the pending
   * file does not exist (sc-3-4).
   */
  private async handleApprove(checkpointId: string): Promise<string> {
    if (!(await pendingExists(this.projectRoot, checkpointId))) {
      return `No pending checkpoint found: ${checkpointId}`;
    }
    const marker: ApprovedMarker = {
      approvedAt: new Date().toISOString(),
      approverId: resolveApprover(),
    };
    await saveApproved(this.projectRoot, checkpointId, marker);
    await this.clearPending(checkpointId);
    return `Approved checkpoint ${checkpointId}. The run will resume.`;
  }

  /**
   * Reject a pending checkpoint: guard with pendingExists, write the marker
   * carrying the feedback string, clear the correlated RunState, and return ack.
   * Returns a "no pending checkpoint" message and writes nothing if absent (sc-3-4).
   */
  private async handleReject(checkpointId: string, feedback: string): Promise<string> {
    if (!(await pendingExists(this.projectRoot, checkpointId))) {
      return `No pending checkpoint found: ${checkpointId}`;
    }
    const marker: RejectedMarker = {
      rejectedAt: new Date().toISOString(),
      rejecterId: resolveApprover(),
      feedback,
    };
    await saveRejected(this.projectRoot, checkpointId, marker);
    await this.clearPending(checkpointId);
    return `Rejected checkpoint ${checkpointId}. Feedback sent for rework.`;
  }

  /**
   * Queue free-text guidance for a run at the next pipeline boundary.
   * Shared by /tell <runId> <text> (deterministic slash path) and
   * classifier tell (natural-language path). Never reaches the LLM.
   *
   * Guards: unknown run (not in roster) → clear error, writes nothing.
   * Path-traversal: appendGuidance validates runId via safeSegment first.
   * Does NOT require careful mode; guidance can be queued for any known run.
   */
  private async handleTell(runId: string, text: string): Promise<string> {
    // Guard: check run exists in the roster (any status — not just running)
    const exists = await hasRunDir(this.projectRoot, runId);
    if (!exists) {
      return `No such run: ${runId}`;
    }
    try {
      await appendGuidance(this.projectRoot, runId, text);
    } catch (err) {
      // Surface path-traversal or other appendGuidance errors clearly
      return `Failed to queue guidance: ${err instanceof Error ? err.message : String(err)}`;
    }
    return `Queued guidance for run ${runId}.`;
  }

  /**
   * Soft-pause a run at the next checkpoint boundary.
   *
   * Distinct from handleStop: this does NOT send a kill signal — the process
   * stays alive and will hold at the next cooperative-pause gate in the pipeline.
   *
   * Guards: run must be found in the roster with status "running".
   * Side effects: writes paused.json marker + flips chat-owned RunState to
   * 'paused' (with pausedAt timestamp) via writeRunState.
   */
  private async handlePause(runId: string): Promise<string> {
    const states = await this.roster.read();
    const target = states.find((s) => s.runId === runId && s.status === "running");
    if (!target) return `No such running run: ${runId}`;
    await setPaused(this.projectRoot, runId);
    await writeRunState(this.projectRoot, {
      ...target,
      status: "paused",
      pausedAt: new Date().toISOString(),
    });
    return `Paused run ${runId} at the next boundary — the process stays alive (use /resume ${runId} to continue). This is NOT /stop.`;
  }

  /**
   * Resume a soft-paused run.
   *
   * Clears the paused.json marker (best-effort) and flips RunState back
   * to 'running' (dropping the pausedAt field). The pipeline's cooperative
   * gate polls isPaused, so removing the marker allows the gate to advance.
   */
  private async handleResume(runId: string): Promise<string> {
    await clearPaused(this.projectRoot, runId);
    const states = await this.roster.read();
    const target = states.find((s) => s.runId === runId && s.status === "paused");
    if (target) {
      // Destructure out pausedAt so it is NOT serialized back to disk.
      const { pausedAt, ...rest } = target;
      void pausedAt;
      await writeRunState(this.projectRoot, { ...rest, status: "running" });
    }
    return `Resumed run ${runId}.`;
  }

  /**
   * Clear pending fields from the RunState correlated to this checkpoint.
   * Inverse of the Sprint 2 reflection block: finds the input-required RunState
   * matching this checkpointId, drops the three pending fields, and sets
   * status back to "running". Idempotent — no-op if no correlated state exists.
   */
  private async clearPending(checkpointId: string): Promise<void> {
    const states = await this.roster.read();
    const state = states.find(
      (s) => s.status === "input-required" && s.pendingCheckpointId === checkpointId,
    );
    if (!state) return;
    // Destructure out the optional pending fields so they are NOT serialized.
    const { pendingCheckpointId, pendingPrompt, pendingSince, ...rest } = state;
    // Suppress unused-variable warnings — these are intentionally destructured out.
    void pendingCheckpointId;
    void pendingPrompt;
    void pendingSince;
    await writeRunState(this.projectRoot, { ...rest, status: "running" });
  }

  /**
   * Resolve a checkpoint id for NL approve/reject paths.
   * - If an id is provided, use it directly.
   * - If exactly one pending marker exists, use it.
   * - If zero or multiple pending markers exist (without a named id), return
   *   an ambiguous result so the caller can ask the user instead of guessing.
   */
  private async resolveCheckpoint(
    id?: string,
  ): Promise<{ kind: "id"; id: string } | { kind: "ambiguous"; message: string }> {
    if (id) return { kind: "id", id };
    const pending = await this.approvalReader.read();
    if (pending.length === 1) return { kind: "id", id: pending[0]!.checkpointId };
    if (pending.length === 0) {
      return { kind: "ambiguous", message: "No pending checkpoints to act on." };
    }
    const ids = pending.map((p) => p.checkpointId).join(", ");
    return {
      kind: "ambiguous",
      message: `Multiple pending checkpoints — which one? ${ids}`,
    };
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
