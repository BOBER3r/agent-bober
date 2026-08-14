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

import { readFile, readdir, unlink, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";
import { render } from "../renderers/registry.js";
import { writeFileAtomic } from "../../../state/helpers.js";

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

/**
 * Read and parse a resolution marker.
 *
 * Returns undefined when the marker cannot be read or parsed *yet* — the caller
 * treats that as "not resolved" and retries on the next poll instead of failing
 * the checkpoint. Two things make a marker briefly unreadable even though its
 * directory entry already exists:
 *
 *   - a non-atomic writer publishes the entry before its bytes (open(2) creates
 *     the name, and payloads over 512 KiB land in several chunks), so a poll
 *     landing mid-write reads zero bytes or a prefix. Every writer in this repo
 *     now publishes via writeFileAtomic, but a hand-edited marker or a
 *     third-party tool still can tear;
 *   - a concurrent resolver can unlink the marker between our readdir and our
 *     readFile.
 *
 * Waiting is the fail-closed outcome for a gate that authorises effects: a
 * marker that never becomes readable degrades to TIMEOUT — which denies the
 * checkpoint — rather than being approved or throwing out of request().
 */
async function readMarker<T>(
  path: string,
  warned: Set<string>,
): Promise<T | undefined> {
  // Warn at most once per marker, so a genuinely stuck marker is diagnosable
  // rather than looking like a silent hang until the timeout fires.
  const warnOnce = (reason: string): void => {
    if (warned.has(path)) return;
    warned.add(path);
    process.stderr.write(`warn: checkpoint marker ${path} ${reason}; retrying.\n`);
  };

  let raw: string;
  try {
    raw = await readFile(path, "utf-8");
  } catch (err) {
    // ENOENT is benign: a concurrent resolver removed the marker between our
    // readdir and this read. Anything else (permissions, I/O) would otherwise
    // be indistinguishable from "still waiting for the approver".
    if ((err as { code?: unknown } | null)?.code !== "ENOENT") {
      warnOnce(`could not be read (${err instanceof Error ? err.message : String(err)})`);
    }
    return undefined;
  }
  try {
    return JSON.parse(raw) as T;
  } catch {
    warnOnce("is not readable JSON yet");
    return undefined;
  }
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
    await writeFileAtomic(
      pendingPath,
      JSON.stringify(pending, null, 2) + "\n",
    );

    // 2) Poll until resolution OR timeout.
    const startedAt = this.now();
    let pollHandle: ReturnType<typeof setTimeout> | undefined;
    // Markers already warned about, so a retrying poll does not spam stderr.
    const warnedMarkers = new Set<string>();

    try {
      return await new Promise<CheckpointOutcome>((resolve, reject) => {
        const tick = async (): Promise<void> => {
          try {
            // Enumerate the directory once per poll — atomic-ish check.
            const entries = new Set(
              await readdir(this.approvalsDir).catch(() => [] as string[]),
            );

            if (entries.has(`${checkpoint}.approved.json`)) {
              const parsed = await readMarker<{ editDelta?: unknown }>(
                approvedPath,
                warnedMarkers,
              );
              // undefined = torn or vanished mid-write; fall through and retry.
              if (parsed !== undefined) {
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
            }

            if (entries.has(`${checkpoint}.rejected.json`)) {
              const parsed = await readMarker<{ feedback: string }>(
                rejectedPath,
                warnedMarkers,
              );
              if (parsed !== undefined) {
                // Cleanup — delete pending + rejected markers.
                await unlink(pendingPath).catch(() => {});
                await unlink(rejectedPath).catch(() => {});
                resolve({ approved: false, feedback: parsed.feedback });
                return;
              }
            }

            // Check timeout.
            if (this.now() - startedAt >= timeoutMs) {
              await writeFileAtomic(
                timeoutPath,
                JSON.stringify({
                  checkpointId: checkpoint,
                  timedOutAt: new Date(this.now()).toISOString(),
                }) + "\n",
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
