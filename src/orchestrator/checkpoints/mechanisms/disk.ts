/**
 * Disk-marker blocking checkpoint mechanism.
 *
 * Writes .bober/approvals/<checkpointId>.pending.json containing a SUMMARY of
 * the artifact (NOT the full artifact — perf budget 100ms), polls the directory
 * until <id>.approved.json or <id>.rejected.json appears, deletes the pending
 * file, and returns the matching CheckpointOutcome. Times out at a configurable
 * cap (default 24h, max 7d) writing a TIMEOUT marker.
 *
 * Sprint 9 — colocated in mechanisms/ per Sprint 7+8 precedent.
 */

import { readFile, writeFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";
import { render } from "../renderers/registry.js";

const DEFAULT_POLL_MS = 2000;
const DEFAULT_TIMEOUT_MS = 24 * 60 * 60 * 1000; // 24 hours
const MAX_TIMEOUT_MS = 7 * 24 * 60 * 60 * 1000; // 7 days cap

export interface DiskMechanismOptions {
  /** Default 2000ms; configurable via pipeline.approvalPollMs */
  pollMs?: number;
  /** Default 24h; capped at 7d via MAX_TIMEOUT_MS */
  timeoutMs?: number;
  /** Optional runId stamped into the pending file */
  runId?: string;
}

/**
 * Extract a minimal artifact stub for the pending file.
 * Only picks the `type` field — the full rendered summary goes into `prompt`.
 * Never stringifies the whole artifact (perf budget / large-artifact safety).
 */
function artifactStub(artifact: CheckpointArtifact): { type?: string } {
  const a = artifact as Record<string, unknown> | null | undefined;
  if (!a || typeof a !== "object") return {};
  const stub: { type?: string } = {};
  if (typeof a["type"] === "string") stub.type = a["type"];
  return stub;
}

export class DiskCheckpointMechanism implements CheckpointMechanism {
  /**
   * @param approvalsDir - Absolute path to .bober/approvals directory.
   * @param options      - Polling + timeout + runId options.
   * @param now          - Clock injection for deterministic timeout tests.
   *                       Defaults to Date.now.
   */
  constructor(
    private readonly approvalsDir: string,
    private readonly options: DiskMechanismOptions = {},
    // Optional clock injection for deterministic timeout tests
    private readonly now: () => number = () => Date.now(),
  ) {}

  async request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    const pollMs = this.options.pollMs ?? DEFAULT_POLL_MS;
    const timeoutMs = Math.min(
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
      MAX_TIMEOUT_MS,
    );

    await mkdir(this.approvalsDir, { recursive: true });

    const pendingPath = join(this.approvalsDir, `${checkpoint}.pending.json`);
    const approvedPath = join(this.approvalsDir, `${checkpoint}.approved.json`);
    const rejectedPath = join(this.approvalsDir, `${checkpoint}.rejected.json`);
    const timeoutPath = join(this.approvalsDir, `${checkpoint}.timeout.json`);

    // Clean up stale markers from a prior run (race-condition safety).
    await unlink(approvedPath).catch(() => {});
    await unlink(rejectedPath).catch(() => {});
    await unlink(timeoutPath).catch(() => {});

    const requestedAt = new Date(this.now()).toISOString();
    const timeoutAt = new Date(this.now() + timeoutMs).toISOString();

    // 1) Write the pending marker (SUMMARY only — perf budget 100ms).
    //    `artifact` holds only type metadata; full rendering goes into `prompt`.
    const pending = {
      checkpointId: checkpoint,
      runId: this.options.runId,
      artifact: artifactStub(artifact),
      prompt: render(artifact),
      requestedAt,
      timeoutAt,
    };
    await writeFile(
      pendingPath,
      JSON.stringify(pending, null, 2) + "\n",
      "utf-8",
    );

    // 2) Poll until resolution OR timeout.
    const startedAt = this.now();
    let pollHandle: ReturnType<typeof setTimeout> | undefined;

    try {
      return await new Promise<CheckpointOutcome>((resolve, reject) => {
        const tick = async (): Promise<void> => {
          try {
            // Enumerate the directory once per poll — atomic-ish check.
            const entries = new Set(
              await readdir(this.approvalsDir).catch(() => [] as string[]),
            );

            if (entries.has(`${checkpoint}.approved.json`)) {
              const raw = await readFile(approvedPath, "utf-8");
              const parsed = JSON.parse(raw) as { editDelta?: unknown };
              // Cleanup — delete pending + approved markers.
              await unlink(pendingPath).catch(() => {});
              await unlink(approvedPath).catch(() => {});
              if (parsed.editDelta !== undefined) {
                resolve({ approved: true, editDelta: parsed.editDelta });
              } else {
                resolve({ approved: true });
              }
              return;
            }

            if (entries.has(`${checkpoint}.rejected.json`)) {
              const raw = await readFile(rejectedPath, "utf-8");
              const parsed = JSON.parse(raw) as { feedback: string };
              // Cleanup — delete pending + rejected markers.
              await unlink(pendingPath).catch(() => {});
              await unlink(rejectedPath).catch(() => {});
              resolve({ approved: false, feedback: parsed.feedback });
              return;
            }

            // Check timeout.
            if (this.now() - startedAt >= timeoutMs) {
              await writeFile(
                timeoutPath,
                JSON.stringify({
                  checkpointId: checkpoint,
                  timedOutAt: new Date(this.now()).toISOString(),
                }) + "\n",
                "utf-8",
              );
              await unlink(pendingPath).catch(() => {});
              resolve({ approved: false, feedback: "TIMEOUT" });
              return;
            }

            // Schedule next tick.
            pollHandle = setTimeout(() => {
              tick().catch(reject);
            }, pollMs);
          } catch (err) {
            reject(err);
          }
        };

        // Start the first tick.
        pollHandle = setTimeout(() => {
          tick().catch(reject);
        }, pollMs);
      });
    } finally {
      // Cleanup — never leak timers.
      if (pollHandle !== undefined) {
        clearTimeout(pollHandle);
      }
    }
  }
}
