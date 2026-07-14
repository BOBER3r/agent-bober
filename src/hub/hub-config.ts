/**
 * kb-hub output vault path resolution.
 *
 * Reads config.hub.outVault from the raw config file (bypassing Zod which
 * strips unknown keys). Falls back to <parentOfProjectRoot>/kb-hub.
 * Never throws.
 */

import { dirname, join, resolve } from "node:path";

import { readJson } from "../utils/fs.js";

// ── Config candidates ─────────────────────────────────────────────────

const CONFIG_CANDIDATES = ["bober.config.json", ".bober/config.json"] as const;

// ── resolveOutVault ───────────────────────────────────────────────────

/**
 * Resolve the kb-hub output vault to an ABSOLUTE path.
 * Reads config.hub.outVault if present (resolved against projectRoot), else
 * falls back to <parentOfProjectRoot>/kb-hub. Never throws.
 *
 * @param projectRoot  Absolute path to the current project root.
 */
export async function resolveOutVault(projectRoot: string): Promise<string> {
  for (const candidate of CONFIG_CANDIDATES) {
    try {
      const raw = await readJson<{ hub?: { outVault?: unknown } }>(
        join(projectRoot, candidate),
      );
      const ov = raw.hub?.outVault;
      if (typeof ov === "string" && ov.length > 0) return resolve(projectRoot, ov);
      break; // config existed but no outVault → fall to default
    } catch {
      /* not found / invalid JSON → try next candidate */
    }
  }
  return join(dirname(projectRoot), "kb-hub");
}

// ── priorityMdPath ────────────────────────────────────────────────────

/** Target priority.md path inside the resolved out vault. */
export function priorityMdPath(outVault: string): string {
  return join(outVault, "priority.md");
}
