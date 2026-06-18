// ── fleet/manifest-write.ts ───────────────────────────────────────────
//
// writeManifestWithProvenance: shared helper for fleet expand and
// fleet expand-deep Step-4 writes. Emits a provenance sidecar,
// preserves the prior manifest as .bak on overwrite, and prints an
// informative non-blocking notice.

import { writeFile, rename, access, readFile } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { dirname, basename } from "node:path";
import { ensureDir } from "../state/helpers.js";
import type { FleetManifest } from "./manifest.js";

// ── Types ─────────────────────────────────────────────────────────────

export interface ManifestProvenance {
  command: string;
  goal: string;
  critique: boolean;
  childCount: number;
  timestamp: string;
}

export interface WriteManifestArgs {
  outPath: string;
  manifest: FleetManifest;
  provenance: Omit<ManifestProvenance, "timestamp">;
  log?: (msg: string) => void;
  now?: () => number;
}

// ── Relative-age formatter ────────────────────────────────────────────

// bober: simple string bucketing; upgrade to a full humanize lib if sub-minute
// precision is needed for UI display.
function formatRelativeAge(deltaMs: number): string {
  const totalSeconds = Math.floor(deltaMs / 1000);
  if (totalSeconds < 60) {
    return "just now";
  }
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) {
    return `${totalMinutes}m ago`;
  }
  const totalHours = Math.floor(totalMinutes / 60);
  if (totalHours < 24) {
    return `${totalHours}h ago`;
  }
  const totalDays = Math.floor(totalHours / 24);
  return `${totalDays}d ago`;
}

// ── Helper ────────────────────────────────────────────────────────────

/**
 * Atomically write a fleet manifest to outPath, emit a provenance sidecar,
 * and (on overwrite) preserve the prior manifest as <outPath>.bak and log
 * an informative notice.
 *
 * Steps:
 * 1. ensureDir(dirname(outPath))
 * 2. Check if outPath already exists
 * 3. If exists: tolerantly read+parse <outPath>.meta.json (missing/corrupt → null),
 *    rename outPath to <outPath>.bak, log notice
 * 4. Atomically write new manifest via tmp+rename
 * 5. Write provenance sidecar to <outPath>.meta.json
 */
export async function writeManifestWithProvenance(args: WriteManifestArgs): Promise<void> {
  const { outPath, manifest, provenance } = args;
  const log = args.log ?? console.log;
  const now = args.now ?? Date.now;

  const sidecarPath = `${outPath}.meta.json`;
  const bakPath = `${outPath}.bak`;
  const { command } = provenance;

  // Step 1: ensure output directory exists
  await ensureDir(dirname(outPath));

  // Step 2: check if the manifest already exists
  const alreadyExisted = await access(outPath).then(
    () => true,
    () => false,
  );

  // Step 3: if it exists, back it up and log a notice
  if (alreadyExisted) {
    // Tolerantly read prior sidecar — missing or corrupt must never abort the write
    let prior: ManifestProvenance | null;
    try {
      const raw = await readFile(sidecarPath, "utf-8");
      prior = JSON.parse(raw) as ManifestProvenance;
    } catch {
      prior = null;
    }

    // Move prior manifest to .bak BEFORE writing the new one
    await rename(outPath, bakPath);

    // Log informative notice
    if (prior !== null) {
      const ageMs = now() - Date.parse(prior.timestamp);
      const relAge = formatRelativeAge(ageMs);
      log(
        `[${command}] Replacing manifest from \`${prior.command}\` for goal "${prior.goal}" (${prior.childCount} children, ${relAge}) → kept as ${basename(outPath)}.bak`,
      );
    } else {
      log(
        `[${command}] Overwriting existing manifest at ${outPath} → kept as ${basename(outPath)}.bak`,
      );
    }
  }

  // Step 4: atomically write the new manifest via tmp+rename
  const rnd = randomBytes(4).toString("hex");
  const tmp = `${outPath}.${process.pid}.${Date.now()}.${rnd}.tmp`;
  await writeFile(tmp, JSON.stringify(manifest, null, 2), { encoding: "utf-8" });
  await rename(tmp, outPath);

  // Step 5: write provenance sidecar
  const sidecar: ManifestProvenance = {
    ...provenance,
    timestamp: new Date(now()).toISOString(),
  };
  await writeFile(sidecarPath, JSON.stringify(sidecar, null, 2), { encoding: "utf-8" });
}
