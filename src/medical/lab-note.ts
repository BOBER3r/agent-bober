/**
 * Lab-note vault writer — serializes parsed lab markers to YAML-frontmatter markdown notes.
 *
 * Status classification is deterministic JS: value vs reference range (ADR-3 spirit).
 *
 * PURE file I/O + deterministic helpers only.
 * NO network. NO LLM. NO Date.now(). All timestamps are injected parameters.
 *
 * bober: hand-rolled YAML-frontmatter subset (flat scalars only, no arrays/nested objects).
 *        Mirror of src/vault/frontmatter.ts approach — never import that module.
 *        Swap for a vetted YAML library if quoted strings or nested objects are required.
 */

import { writeFile } from "node:fs/promises";
import { join, dirname } from "node:path";

import type { ParsedLabMarker } from "./lab-types.js";
import { ensureDir } from "../utils/fs.js";

// -- Types ---------------------------------------------------------------

/** Deterministic lab status — derived in pure JS, never by an LLM (ADR-3 spirit). */
export type LabStatus = "low" | "normal" | "high" | "critical";

/** Report-level metadata supplied alongside a ParsedLabMarker at write time. */
export interface LabNoteMeta {
  panel: string;
  /** ISO 8601 collection timestamp — INJECTED, never Date.now(). */
  collectedAtIso: string;
  source: string;
}

/**
 * Structured contents of a lab note's YAML frontmatter.
 * All 10 keys are always present; ref_low / ref_high are undefined when absent.
 */
export interface LabNoteFrontmatter {
  marker: string;
  value: number;
  unit: string;
  ref_low: number | undefined;
  ref_high: number | undefined;
  /** Human-readable range string, e.g. "70-100", or "" when bounds are absent. */
  ref_range: string;
  /** ISO 8601 collection date (stored verbatim from collectedAtIso). */
  date: string;
  status: LabStatus;
  panel: string;
  source: string;
}

// -- Pure helpers --------------------------------------------------------

/**
 * Produce a URL-safe slug from an arbitrary string.
 * Precedent: src/incident/timeline.ts:117.
 */
export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Derive a deterministic lab status from value vs reference range.
 * Pure sync — no LLM, no network, no Date.now() (ADR-3 spirit).
 *
 * Priority: critical flag wins; else compare to bounds; missing bounds → "normal".
 */
export function deriveLabStatus(
  value: number,
  refLow?: number,
  refHigh?: number,
  critical?: boolean,
): LabStatus {
  if (critical === true) return "critical";
  if (refLow !== undefined && value < refLow) return "low";
  if (refHigh !== undefined && value > refHigh) return "high";
  return "normal";
}

// -- Hand-rolled YAML frontmatter ----------------------------------------

/** Matches an integer or float (with optional leading minus). */
const NUM_REGEX = /^-?\d+(\.\d+)?$/;

/**
 * Serialize a LabNoteFrontmatter to a YAML-frontmatter markdown string.
 * Produces `---\n<key: value lines>\n---\n`.
 * Flat scalar keys only; undefined numeric values are serialized as empty strings.
 *
 * Mirror of src/vault/frontmatter.ts:145-164 — DO NOT import that module.
 */
function serializeLabFrontmatter(fm: LabNoteFrontmatter): string {
  const lines: string[] = ["---"];
  lines.push(`marker: ${fm.marker}`);
  lines.push(`value: ${String(fm.value)}`);
  lines.push(`unit: ${fm.unit}`);
  lines.push(`ref_low: ${fm.ref_low !== undefined ? String(fm.ref_low) : ""}`);
  lines.push(`ref_high: ${fm.ref_high !== undefined ? String(fm.ref_high) : ""}`);
  lines.push(`ref_range: ${fm.ref_range}`);
  lines.push(`date: ${fm.date}`);
  lines.push(`status: ${fm.status}`);
  lines.push(`panel: ${fm.panel}`);
  lines.push(`source: ${fm.source}`);
  lines.push("---");
  return lines.join("\n") + "\n";
}

/**
 * Parse the YAML frontmatter from a raw lab-note markdown string.
 * Numeric fields (value, ref_low, ref_high) are coerced from their string representation.
 * ref_low / ref_high are undefined when the value is absent or empty.
 *
 * Throws if the opening or closing `---` fence is missing.
 *
 * Mirror of src/vault/frontmatter.ts:53-135 — DO NOT import that module.
 */
export function parseLabNote(raw: string): LabNoteFrontmatter {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== "---") {
    throw new Error("parseLabNote: missing opening '---' fence");
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i].trim() === "---") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    throw new Error("parseLabNote: missing closing '---' fence");
  }

  const yamlLines = lines.slice(1, closingIdx);
  const record: Record<string, string | number> = {};

  for (const line of yamlLines) {
    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === "") continue;
    const rawVal = line.slice(colonIdx + 1).trim();
    record[key] = NUM_REGEX.test(rawVal) ? Number(rawVal) : rawVal;
  }

  // -- Coerce and extract fields --
  const marker = String(record["marker"] ?? "");
  const valueRaw = record["value"];
  const value = typeof valueRaw === "number" ? valueRaw : Number(valueRaw ?? 0);
  const unit = String(record["unit"] ?? "");

  const refLowRaw = record["ref_low"];
  const ref_low: number | undefined =
    typeof refLowRaw === "number"
      ? refLowRaw
      : refLowRaw === "" || refLowRaw === undefined
        ? undefined
        : Number(refLowRaw);

  const refHighRaw = record["ref_high"];
  const ref_high: number | undefined =
    typeof refHighRaw === "number"
      ? refHighRaw
      : refHighRaw === "" || refHighRaw === undefined
        ? undefined
        : Number(refHighRaw);

  const ref_range = String(record["ref_range"] ?? "");
  const date = String(record["date"] ?? "");
  const status = String(record["status"] ?? "normal") as LabStatus;
  const panel = String(record["panel"] ?? "");
  const source = String(record["source"] ?? "");

  return { marker, value, unit, ref_low, ref_high, ref_range, date, status, panel, source };
}

// -- Note writer ---------------------------------------------------------

/**
 * Write one parsed lab marker to a YAML-frontmatter markdown note.
 *
 * Note path: `<vaultDir>/labs/<panel-slug>/<marker-slug>-<date>.md`
 * The date segment is the YYYY-MM-DD portion of collectedAtIso (colons stripped).
 *
 * Parent directories are created automatically. Returns the absolute path written.
 */
export async function writeLabNote(
  vaultDir: string,
  marker: ParsedLabMarker,
  meta: LabNoteMeta,
): Promise<string> {
  const status = deriveLabStatus(
    marker.value,
    marker.referenceLow,
    marker.referenceHigh,
    marker.critical,
  );

  const refRange =
    marker.referenceLow !== undefined && marker.referenceHigh !== undefined
      ? `${marker.referenceLow}-${marker.referenceHigh}`
      : "";

  const fm: LabNoteFrontmatter = {
    marker: marker.name,
    value: marker.value,
    unit: marker.unit,
    ref_low: marker.referenceLow,
    ref_high: marker.referenceHigh,
    ref_range: refRange,
    date: meta.collectedAtIso,
    status,
    panel: meta.panel,
    source: meta.source,
  };

  // Use only the YYYY-MM-DD portion so the filename contains no colons.
  const datePortion = meta.collectedAtIso.split("T")[0] ?? meta.collectedAtIso;

  const notePath = join(
    vaultDir,
    "labs",
    slugify(meta.panel),
    `${slugify(marker.name)}-${datePortion}.md`,
  );

  const serialized = serializeLabFrontmatter(fm);
  await ensureDir(dirname(notePath));
  await writeFile(notePath, serialized, "utf-8");

  return notePath;
}
