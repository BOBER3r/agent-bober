/**
 * Renderer for `pipeline-summary` artifacts.
 *
 * Shows: spec title, success status, completed/failed sprints, duration (formatted),
 * and current sprint. No hard line cap (typically small).
 *
 * Pure function — no I/O. Receives a PipelineResult-shaped object.
 *
 * Sprint 11 — colocated in renderers/ per mechanisms/ precedent.
 */

import { applyLineCap } from "./_util.js";

interface SpecLike {
  title?: string;
  specId?: string;
}

interface PipelineSummaryArtifact {
  type?: string;
  success?: boolean;
  completedSprints?: unknown[];
  failedSprints?: unknown[];
  duration?: number;
  spec?: SpecLike;
  currentSprint?: string;
  totalIterationsUsed?: number;
}

/**
 * Format a duration in milliseconds as a human-readable string.
 */
function formatDuration(ms: number): string {
  const totalSeconds = Math.floor(ms / 1000);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  const seconds = totalSeconds % 60;
  if (hours > 0) return `${hours}h ${minutes}m ${seconds}s`;
  if (minutes > 0) return `${minutes}m ${seconds}s`;
  return `${seconds}s`;
}

/**
 * Render a `pipeline-summary` artifact as markdown.
 */
export function renderPipelineSummary(artifact: unknown): string {
  const a = (artifact ?? {}) as PipelineSummaryArtifact;
  const spec = a.spec ?? {};
  const completedSprints = a.completedSprints ?? [];
  const failedSprints = a.failedSprints ?? [];
  const success = a.success === true ? "SUCCESS" : a.success === false ? "FAILED" : "UNKNOWN";
  const durationStr = typeof a.duration === "number" ? formatDuration(a.duration) : "unknown";

  const lines: string[] = [
    `## Pipeline Summary`,
    ``,
    `**Spec:** ${spec.title ?? "(untitled)"}`,
    `**Result:** **${success}**`,
    `**Duration:** ${durationStr}`,
    ``,
    `### Sprint results`,
    `- **Completed:** ${completedSprints.length}`,
    `- **Failed:** ${failedSprints.length}`,
    `- **Total:** ${completedSprints.length + failedSprints.length}`,
    ``,
  ];

  if (a.currentSprint) {
    lines.push(`**Current sprint:** ${a.currentSprint}`);
    lines.push(``);
  }

  if (typeof a.totalIterationsUsed === "number") {
    lines.push(`**Total iterations used:** ${a.totalIterationsUsed}`);
    lines.push(``);
  }

  return applyLineCap(lines.join("\n"), 150);
}
