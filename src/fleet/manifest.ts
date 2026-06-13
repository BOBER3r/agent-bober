import { readFile } from "node:fs/promises";
import { z } from "zod";

// ── Schemas ──────────────────────────────────────────────────────────

export const FleetChildSchema = z.object({
  folder: z.string().min(1),
  task: z.string().min(1),
  config: z.record(z.string(), z.unknown()).optional(),
});
export type FleetChild = z.infer<typeof FleetChildSchema>;

export const FleetManifestSchema = z.object({
  rootDir: z.string().default("."),
  concurrency: z.number().int().min(1).default(3),
  children: z.array(FleetChildSchema).min(1),
});
export type FleetManifest = z.infer<typeof FleetManifestSchema>;

// ── Loader ───────────────────────────────────────────────────────────

export async function load(manifestPath: string): Promise<FleetManifest> {
  let raw: string;
  try {
    raw = await readFile(manifestPath, "utf-8");
  } catch (err) {
    throw new Error(
      `Failed to read fleet manifest at "${manifestPath}": ${(err as Error).message}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `Fleet manifest at "${manifestPath}" is not valid JSON: ${(err as Error).message}`,
      { cause: err },
    );
  }

  return FleetManifestSchema.parse(parsed);
}
