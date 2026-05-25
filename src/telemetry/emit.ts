/**
 * Opt-in local-only telemetry event emitter (Sprint 28).
 *
 * When config.telemetry.enabled === true, appends one newline-terminated JSON
 * line to .bober/telemetry/<YYYY-MM-DD>.jsonl. When disabled (default), emit()
 * is a no-op and performs ZERO file IO.
 *
 * File is created with mode 0600 on first append via fs.open(O_WRONLY|O_APPEND|
 * O_CREAT). Mirrors the Sprint 13 audit pattern verbatim (see audit.ts:86 for
 * the rationale on why fs.appendFile is NOT used).
 *
 * NETWORK EGRESS: forbidden by design. No import of node:http, node:https,
 * node:net, node:tls, undici, or fetch — enforced by ESLint no-restricted-imports
 * rule scoped to src/telemetry/** in eslint.config.js.
 *
 * PRIVACY: event payloads MUST be IDs / counts / enum outcomes only. NEVER pass
 * user-content strings (feedbackText, prompts, file contents, MCP response
 * bodies). Reviewers grep `emit(` across src/ to enforce this discipline.
 *
 * Sprint 28 — src/telemetry/emit.ts
 */

import { open, mkdir } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { BoberConfig } from "../config/schema.js";
import { logger } from "../utils/logger.js";

export type TelemetryEventType =
  | "checkpoint-approved"
  | "checkpoint-rejected"
  | "checkpoint-edited"
  | "sprint-pass"
  | "sprint-fail-retry"
  | "incident-resolved"
  | "incident-aborted"
  | "agent-spawn"
  | "agent-error";

/** Allowed payload fields. NO string values from user input. */
export interface TelemetryEventData {
  runId?: string;
  incidentId?: string;
  specId?: string;
  sprintId?: string;
  contractId?: string;
  agentName?: string;
  checkpointId?: string;
  iteration?: number;
  durationMs?: number;
  outcome?: string;      // ENUM only (e.g., "passed", "failed")
  retryCount?: number;
  errorKind?: string;    // ENUM only (e.g., "timeout", "rate-limit")
}

const writeChain = new Map<string, Promise<void>>();

function telemetryDir(projectRoot: string): string {
  return join(projectRoot, ".bober", "telemetry");
}

function telemetryPath(projectRoot: string): string {
  const date = new Date().toISOString().slice(0, 10); // YYYY-MM-DD
  return join(telemetryDir(projectRoot), `${date}.jsonl`);
}

/** Emit a telemetry event. No-op when telemetry.enabled !== true. */
export async function emit(
  projectRoot: string,
  config: BoberConfig,
  eventType: TelemetryEventType,
  data: TelemetryEventData = {},
): Promise<void> {
  if (config.telemetry?.enabled !== true) return;

  const event = {
    timestamp: new Date().toISOString(),
    eventType,
    ...data,
  };

  const filePath = telemetryPath(projectRoot);

  const prev = writeChain.get(filePath) ?? Promise.resolve();
  const next = prev
    .then(async () => {
      await mkdir(telemetryDir(projectRoot), { recursive: true });
      const flags = constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT;
      const fh = await open(filePath, flags, 0o600);
      try {
        // Guarantee mode 0600 even if umask would have reduced it.
        await fh.chmod(0o600);
        await fh.write(JSON.stringify(event) + "\n");
      } finally {
        await fh.close();
      }
    })
    .catch((err: unknown) => {
      logger.warn(
        `[telemetry] Failed to emit ${eventType}: ${err instanceof Error ? err.message : String(err)}`,
      );
    });
  writeChain.set(filePath, next);
  return next;
}
