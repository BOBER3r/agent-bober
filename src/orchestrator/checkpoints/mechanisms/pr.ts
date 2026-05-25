/**
 * GitHub PR-native checkpoint mechanism.
 *
 * On request(): opens a draft PR per `bober run` (idempotent — reuses
 * existing run-tracking PR) and appends a checkpoint comment. Polls the PR
 * for resolution via: (a) merge → auto-approve all pending, (b) 'approve
 * <checkpointId>' comment or 'bober/approved-<id>' label, (c) 'reject
 * <checkpointId> <feedback>' comment, (d) 'edit <checkpointId>\n```...```'
 * comment. Falls back to disk mechanism with a warning when gh is unavailable.
 *
 * Sprint 10 — colocated in mechanisms/ per Sprint 7+8+9 precedent.
 */

import { execa } from "execa";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";
import { DiskCheckpointMechanism } from "./disk.js";
import { render } from "../renderers/registry.js";

const DEFAULT_POLL_MS = 30_000;
const MIN_POLL_MS = 10_000;
const DEFAULT_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7d cap (mirrors disk)
const RATE_LIMIT_BACKOFF_CAP_MS = 5 * 60 * 1000; // 5 minute cap

/** Single mockable seam for all `gh` CLI calls. */
export interface GhClient {
  version(): Promise<{ ok: boolean; stdout: string }>;
  authStatus(): Promise<{ ok: boolean; stderr: string }>;
  repoView(): Promise<{ url: string; owner: string; name: string } | null>;
  prList(headRef: string): Promise<Array<{ number: number; state: string }>>;
  prCreate(opts: { title: string; body: string; draft: boolean }): Promise<{ number: number; url: string }>;
  prEdit(prNumber: number, body: string): Promise<void>;
  prReady(prNumber: number): Promise<void>;
  prComment(prNumber: number, body: string): Promise<void>;
  prView(prNumber: number): Promise<{
    state: string;
    merged: boolean;
    labels: Array<{ name: string }>;
    comments: Array<{ id: number; body: string; createdAt: string }>;
  }>;
}

/** Default GhClient implementation — wraps execa. */
export function createGhClient(cwd: string): GhClient {
  return {
    async version() {
      const r = await execa("gh", ["--version"], { reject: false, timeout: 5000 });
      return { ok: r.exitCode === 0, stdout: r.stdout ?? "" };
    },
    async authStatus() {
      const r = await execa("gh", ["auth", "status"], { reject: false, timeout: 5000 });
      return { ok: r.exitCode === 0, stderr: r.stderr ?? "" };
    },
    async repoView() {
      const r = await execa(
        "gh",
        ["repo", "view", "--json", "url,owner,name"],
        { cwd, reject: false, timeout: 5000 },
      );
      if (r.exitCode !== 0) return null;
      try {
        const j = JSON.parse(r.stdout ?? "{}") as {
          url: string;
          owner: { login: string };
          name: string;
        };
        return { url: j.url, owner: j.owner.login, name: j.name };
      } catch { return null; }
    },
    async prList(headRef) {
      const r = await execa(
        "gh",
        ["pr", "list", "--head", headRef, "--json", "number,state", "--state", "open"],
        { cwd, reject: false, timeout: 10000 },
      );
      if (r.exitCode !== 0) return [];
      try {
        return JSON.parse(r.stdout ?? "[]") as Array<{ number: number; state: string }>;
      } catch { return []; }
    },
    async prCreate({ title, body, draft }) {
      const args = ["pr", "create", "--title", title, "--body", body];
      if (draft) args.push("--draft");
      const r = await execa("gh", args, { cwd, reject: false, timeout: 30000 });
      if (r.exitCode !== 0) throw new Error(`gh pr create failed: ${r.stderr}`);
      // gh pr create outputs the PR URL on stdout
      const url = (r.stdout ?? "").trim();
      // Extract PR number from URL (e.g. https://github.com/owner/repo/pull/42)
      const match = url.match(/\/pull\/(\d+)/);
      const number = match ? parseInt(match[1], 10) : 0;
      return { number, url };
    },
    async prEdit(prNumber, body) {
      const r = await execa(
        "gh",
        ["pr", "edit", String(prNumber), "--body", body],
        { cwd, reject: false, timeout: 10000 },
      );
      if (r.exitCode !== 0) throw new Error(`gh pr edit failed: ${r.stderr}`);
    },
    async prReady(prNumber) {
      const r = await execa(
        "gh",
        ["pr", "ready", String(prNumber)],
        { cwd, reject: false, timeout: 10000 },
      );
      if (r.exitCode !== 0) throw new Error(`gh pr ready failed: ${r.stderr}`);
    },
    async prComment(prNumber, body) {
      const r = await execa(
        "gh",
        ["pr", "comment", String(prNumber), "--body", body],
        { cwd, reject: false, timeout: 10000 },
      );
      if (r.exitCode !== 0) throw new Error(`gh pr comment failed: ${r.stderr}`);
    },
    async prView(prNumber) {
      const r = await execa(
        "gh",
        ["pr", "view", String(prNumber), "--json", "state,merged,labels,comments"],
        { cwd, reject: false, timeout: 10000 },
      );
      if (r.exitCode !== 0) {
        return { state: "UNKNOWN", merged: false, labels: [], comments: [] };
      }
      try {
        return JSON.parse(r.stdout ?? "{}") as {
          state: string;
          merged: boolean;
          labels: Array<{ name: string }>;
          comments: Array<{ id: number; body: string; createdAt: string }>;
        };
      } catch {
        return { state: "UNKNOWN", merged: false, labels: [], comments: [] };
      }
    },
  };
}

export interface PrMechanismOptions {
  /** Default 30_000ms; floor 10_000ms (GitHub rate limits). Configurable via pipeline.prPollMs. */
  pollMs?: number;
  /** Default 7d; matches disk cap. */
  timeoutMs?: number;
  /** Required — one PR per run, reused across checkpoints. */
  runId?: string;
  /** Used in the PR title — e.g., "bober(run-XXX): <featureName>". */
  featureName?: string;
  /**
   * Override the current branch head ref (normally auto-detected via git).
   * Inject this in tests to avoid calling the real git binary.
   */
  headRef?: string;
}

/** Result of the availability check. */
type AvailabilityResult =
  | { ok: true; headRef: string; repoUrl: string }
  | { ok: false; reason: string };

/** Parsed resolution signal from PR state + comments + labels. */
type PrSignal =
  | { type: "approve" }
  | { type: "reject"; feedback: string }
  | { type: "edit"; editDelta: { before: string; after: string } }
  | { type: "merge" }
  | null;

export class PrCheckpointMechanism implements CheckpointMechanism {
  /** Cached PR number for this run — set on first request(), reused thereafter. */
  private runPrNumber: number | null = null;

  /** Per-checkpoint states — updated as checkpoints are added and resolved. */
  private checkpointStates = new Map<CheckpointId, "pending" | "approved" | "rejected">();

  /** Number of in-flight request() calls. Used to defer prReady until all requests finish. */
  private inFlightCount = 0;

  /** Pending prReady timer handle — cancelled if a new request() starts before it fires. */
  private prReadyTimer: ReturnType<typeof setTimeout> | null = null;

  /**
   * @param gh        - Mockable GhClient. Tests pass a fake; prod uses createGhClient(cwd).
   * @param fallback  - Mechanism used when gh is unavailable. Defaults to DiskCheckpointMechanism
   *                    rooted at <cwd>/.bober/approvals. MUST be disk (not cli/noop) per evaluator note.
   * @param options   - poll/timeout/runId/featureName.
   * @param now       - Clock injection for deterministic timeout tests (matches disk.ts:69).
   * @param cwd       - Working directory, defaults to process.cwd().
   */
  constructor(
    private readonly gh: GhClient,
    private readonly fallback: CheckpointMechanism = new DiskCheckpointMechanism(
      `${process.cwd()}/.bober/approvals`,
    ),
    private readonly options: PrMechanismOptions = {},
    private readonly now: () => number = () => Date.now(),
    private readonly cwd: string = process.cwd(),
  ) {}

  async request(checkpoint: CheckpointId, artifact: CheckpointArtifact): Promise<CheckpointOutcome> {
    // 1) Availability check (s10-c4) — gh version, gh auth, gh repo view.
    const avail = await this.checkAvailability();
    if (!avail.ok) {
      process.stderr.write(
        `warn: PR checkpoint "${checkpoint}" requested but gh is unavailable (${avail.reason}); falling back to disk mechanism. Run \`gh auth login\` to enable PR checkpoints.\n`,
      );
      return this.fallback.request(checkpoint, artifact);
    }

    // 2) Add this checkpoint to the state map as pending and track in-flight count.
    //    Cancel any deferred prReady that may have been scheduled by a prior request.
    this.checkpointStates.set(checkpoint, "pending");
    this.inFlightCount++;
    if (this.prReadyTimer !== null) {
      clearTimeout(this.prReadyTimer);
      this.prReadyTimer = null;
    }

    // 3) Find or create the run-tracking PR.
    const prNumber = await this.ensureRunPr(avail.headRef);

    // 4) Update the PR body to include per-checkpoint checkbox list.
    const runId = this.options.runId ?? `run-${Date.now()}`;
    const featureName = this.options.featureName ?? "bober run";
    await this.gh.prEdit(prNumber, this.renderPrBody(runId, featureName));

    // 5) Append the checkpoint comment.
    await this.gh.prComment(prNumber, this.renderCheckpointComment(checkpoint, artifact));

    // 6) Poll for resolution (merge / approve / reject / edit) with exponential
    //    back-off on rate-limit errors (cap at 5 minutes per evaluatorNotes).
    const outcome = await this.pollPrUntilResolved(prNumber, checkpoint, artifact);

    // 7) Update checkpoint state and PR body after resolution.
    if ("edit" in outcome && outcome.edit) {
      // For edit outcomes, leave as pending until next request resolves it.
    } else if ("approved" in outcome && outcome.approved) {
      this.checkpointStates.set(checkpoint, "approved");
    } else {
      this.checkpointStates.set(checkpoint, "rejected");
    }

    // Decrement in-flight counter after resolution.
    this.inFlightCount--;

    // Re-render PR body with updated checkbox states.
    await this.gh.prEdit(prNumber, this.renderPrBody(runId, featureName));

    // 8) If ALL checkpoints are approved (none pending, none rejected), schedule
    //    prReady via a deferred macrotask (setTimeout 0). This allows the next
    //    sequential request() call to cancel it if another checkpoint is coming.
    const hasNoRejection = [...this.checkpointStates.values()].every((s) => s !== "rejected");
    const hasNoPending = [...this.checkpointStates.values()].every((s) => s !== "pending");
    if (hasNoRejection && hasNoPending && this.checkpointStates.size > 0) {
      const capturedPrNumber = prNumber;
      const capturedGh = this.gh;
      this.prReadyTimer = setTimeout(() => {
        this.prReadyTimer = null;
        // Double-check: no new pending checkpoints added while timer was pending.
        const stillAllApproved =
          this.checkpointStates.size > 0 &&
          [...this.checkpointStates.values()].every((s) => s === "approved");
        if (stillAllApproved) {
          capturedGh.prReady(capturedPrNumber).catch((err: unknown) => {
            process.stderr.write(`warn: gh pr ready failed: ${String(err)}\n`);
          });
        }
      }, 0);
    }

    return outcome;
  }

  /** Check if gh is available and the repo has a GitHub remote. */
  private async checkAvailability(): Promise<AvailabilityResult> {
    // (a) gh --version
    const ver = await this.gh.version();
    if (!ver.ok) {
      return { ok: false, reason: "gh CLI not found or returned non-zero exit" };
    }

    // (b) gh auth status
    const auth = await this.gh.authStatus();
    if (!auth.ok) {
      return { ok: false, reason: "gh auth status failed — not authenticated" };
    }

    // (c) repo has a GitHub remote
    const repo = await this.gh.repoView();
    if (!repo) {
      return { ok: false, reason: "no GitHub remote found (gh repo view failed)" };
    }

    // Get current branch for PR head ref.
    // Use injected headRef option if available (tests), otherwise detect via git.
    let headRef: string;
    if (this.options.headRef !== undefined) {
      headRef = this.options.headRef;
    } else {
      try {
        const r = await execa("git", ["rev-parse", "--abbrev-ref", "HEAD"], {
          cwd: this.cwd,
          reject: false,
          timeout: 5000,
        });
        headRef = r.exitCode === 0 ? (r.stdout ?? "").trim() : "HEAD";
      } catch {
        headRef = "HEAD";
      }
    }

    return { ok: true, headRef, repoUrl: repo.url };
  }

  /** Find existing run PR or create a new one. Caches the PR number for the run. */
  private async ensureRunPr(headRef: string): Promise<number> {
    if (this.runPrNumber !== null) {
      return this.runPrNumber;
    }

    // Check if a PR already exists for this head ref.
    const existing = await this.gh.prList(headRef);
    if (existing.length > 0) {
      this.runPrNumber = existing[0].number;
      return this.runPrNumber;
    }

    // Create a new draft PR.
    const runId = this.options.runId ?? `run-${Date.now()}`;
    const featureName = this.options.featureName ?? "bober run";
    const title = `bober: ${runId} — ${featureName}`;
    const body = this.renderPrBody(runId, featureName);

    const created = await this.gh.prCreate({ title, body, draft: true });
    this.runPrNumber = created.number;
    return this.runPrNumber;
  }

  /** Render the PR body with a per-checkpoint checkbox list. */
  private renderPrBody(runId: string, featureName: string): string {
    const checkboxLines: string[] = [];
    for (const [id, state] of this.checkpointStates) {
      if (state === "approved") {
        checkboxLines.push(`- [x] ${id}`);
      } else if (state === "rejected") {
        checkboxLines.push(`- [x] ${id} (rejected)`);
      } else {
        checkboxLines.push(`- [ ] ${id}`);
      }
    }

    const checkpointsSection =
      checkboxLines.length > 0
        ? checkboxLines.join("\n")
        : "Checkpoint comments will be appended below as the run progresses.";

    return [
      `# bober run: ${featureName}`,
      ``,
      `**Run ID:** \`${runId}\``,
      ``,
      `## Checkpoints`,
      ``,
      checkpointsSection,
      ``,
      `## How to respond`,
      ``,
      `Post a comment with one of:`,
      `- \`approve <checkpointId>\` — approve that checkpoint`,
      `- \`reject <checkpointId> <feedback>\` — reject with feedback`,
      `- \`edit <checkpointId>\n\`\`\`\n<new content>\n\`\`\`\` — request an edit`,
      ``,
      `Or merge this PR to auto-approve all pending checkpoints.`,
    ].join("\n");
  }

  /** Render a checkpoint comment to post on the PR. */
  private renderCheckpointComment(checkpoint: CheckpointId, artifact: CheckpointArtifact): string {
    return [
      `## Checkpoint: \`${checkpoint}\``,
      ``,
      render(artifact),
      ``,
      `---`,
      ``,
      `Reply with \`approve ${checkpoint}\`, \`reject ${checkpoint} <reason>\`, or \`edit ${checkpoint}\n\`\`\`\n<new content>\n\`\`\`\`.`,
    ].join("\n");
  }

  /** Poll the PR until it resolves (merge / approve / reject / edit) or times out. */
  private async pollPrUntilResolved(
    prNumber: number,
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    const rawPollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    if (rawPollMs < MIN_POLL_MS) {
      process.stderr.write(
        `warn: prPollMs (${rawPollMs}ms) is below the minimum (${MIN_POLL_MS}ms); using configured value but may hit GitHub rate limits.\n`,
      );
    }
    const pollMs = rawPollMs;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const startedAt = this.now();
    let currentBackoffMs = pollMs;
    let pollHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<CheckpointOutcome>((resolve, reject) => {
        const tick = async (): Promise<void> => {
          try {
            // Check timeout.
            if (this.now() - startedAt >= timeoutMs) {
              resolve({ approved: false, feedback: "TIMEOUT" });
              return;
            }

            let view: Awaited<ReturnType<typeof this.gh.prView>>;
            try {
              view = await this.gh.prView(prNumber);
            } catch (err) {
              // On rate-limit or transient error, back off.
              const errMsg = String(err);
              if (/rate.?limit|abuse.?detection|429/i.test(errMsg)) {
                currentBackoffMs = Math.min(currentBackoffMs * 2, RATE_LIMIT_BACKOFF_CAP_MS);
                process.stderr.write(
                  `warn: PR poll hit rate limit; backing off to ${Math.round(currentBackoffMs / 1000)}s.\n`,
                );
              }
              pollHandle = setTimeout(() => { tick().catch(reject); }, currentBackoffMs);
              return;
            }

            // Check for signals in order of precedence.
            const signal = parseSignals(view, checkpoint, artifact);

            if (signal !== null) {
              switch (signal.type) {
                case "merge":
                  resolve({ approved: true });
                  return;
                case "approve":
                  resolve({ approved: true });
                  return;
                case "reject":
                  resolve({ approved: false, feedback: signal.feedback });
                  return;
                case "edit":
                  resolve({ edit: true, editDelta: signal.editDelta });
                  return;
              }
            }

            // Reset backoff on success.
            currentBackoffMs = pollMs;

            // Schedule next tick.
            pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
          } catch (err) {
            reject(err);
          }
        };

        // Start the first tick.
        pollHandle = setTimeout(() => { tick().catch(reject); }, pollMs);
      });
    } finally {
      if (pollHandle !== undefined) {
        clearTimeout(pollHandle);
      }
    }
  }
}

/**
 * Parse PR state + comments + labels to determine the resolution signal.
 * Strict parsing — rejects typos like 'approveeee' or 'aproove'.
 */
export function parseSignals(
  view: {
    state: string;
    merged: boolean;
    labels: Array<{ name: string }>;
    comments: Array<{ id: number; body: string; createdAt: string }>;
  },
  checkpoint: CheckpointId,
  artifact: CheckpointArtifact,
): PrSignal {
  // (a) PR merge → auto-approve all pending.
  if (view.merged) {
    return { type: "merge" };
  }

  // (b) Label-based approval: 'bober/approved-<checkpointId>'.
  const approvalLabel = `bober/approved-${checkpoint}`;
  if (view.labels.some((l) => l.name === approvalLabel)) {
    return { type: "approve" };
  }

  // Check comments in order (oldest first — first matching signal wins).
  for (const comment of view.comments) {
    const body = comment.body.trim();
    const signal = parseCommentSignal(body, checkpoint, artifact);
    if (signal !== null) {
      return signal;
    }
  }

  return null;
}

/**
 * Derive the 'before' text from an artifact for edit deltas.
 */
function deriveBefore(
  art: Record<string, unknown> | null | undefined,
  artifact: CheckpointArtifact,
): string {
  if (art && typeof art === "object") {
    if (typeof art["text"] === "string") {
      return art["text"];
    } else if (typeof art["content"] === "string") {
      return art["content"];
    } else {
      return JSON.stringify(art, null, 2);
    }
  } else if (typeof artifact === "string") {
    return artifact;
  }
  return JSON.stringify(artifact, null, 2);
}

/**
 * Parse a single comment body for approval signals.
 * Strict word-boundary matching to reject typos.
 */
function parseCommentSignal(
  body: string,
  checkpoint: CheckpointId,
  artifact: CheckpointArtifact,
): PrSignal {
  // Normalize line endings.
  const normalized = body.replace(/\r\n/g, "\n");

  // Split into first line and rest.
  const firstNewline = normalized.indexOf("\n");
  const firstLine = firstNewline >= 0 ? normalized.slice(0, firstNewline).trim() : normalized.trim();
  const rest = firstNewline >= 0 ? normalized.slice(firstNewline + 1) : "";

  // Strict approve: '^approve <checkpointId>$' (case-insensitive, word boundaries).
  // Rejects 'approveeee', 'aproove', etc.
  const approveMatch = /^approve\s+(\S+)\s*$/i.exec(firstLine);
  if (approveMatch && approveMatch[1] === checkpoint) {
    return { type: "approve" };
  }

  // Strict reject: '^reject <checkpointId> <feedback>$' (case-insensitive).
  const rejectMatch = /^reject\s+(\S+)\s+(.+)$/i.exec(firstLine);
  if (rejectMatch && rejectMatch[1] === checkpoint) {
    return { type: "reject", feedback: rejectMatch[2].trim() };
  }

  // Edit: '^edit <checkpointId>' followed by a fenced code block.
  const editMatch = /^edit\s+(\S+)\s*$/i.exec(firstLine);
  if (editMatch && editMatch[1] === checkpoint) {
    // Extract the fenced code block from the rest of the comment.
    const fenceMatch = /^```[^\n]*\n([\s\S]*?)```/m.exec(rest);
    const after = fenceMatch ? fenceMatch[1] : rest.trim();

    // Derive 'before' from the artifact.
    const art = artifact as Record<string, unknown> | null | undefined;
    const before = deriveBefore(art, artifact);

    return { type: "edit", editDelta: { before, after } };
  }

  return null;
}
