import { readFile, writeFile, readdir, unlink } from "node:fs/promises";
import { join } from "node:path";

import type { ZodError } from "zod";

import {
  SprintContractSchema,
  findPrecisionIssues,
  type SprintContract,
} from "../contracts/sprint-contract.js";
import { ensureDir } from "./helpers.js";

const CONTRACTS_DIR = ".bober/contracts";

function contractsDir(projectRoot: string): string {
  return join(projectRoot, CONTRACTS_DIR);
}

function contractPath(projectRoot: string, id: string): string {
  // Sanitize the id to be a safe filename
  const safeId = id.replace(/[^a-zA-Z0-9_-]/g, "_");
  return join(contractsDir(projectRoot), `${safeId}.json`);
}

function formatZodIssues(error: ZodError): string {
  return error.issues
    .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
    .join("\n");
}

/**
 * Save a sprint contract to disk.
 * Overwrites any existing contract with the same contractId.
 *
 * Validates the contract against the schema and the precision quality gate.
 * Throws on either failure — partial or vague contracts are not silently saved.
 */
export async function saveContract(
  projectRoot: string,
  contract: SprintContract,
): Promise<void> {
  await ensureDir(contractsDir(projectRoot));

  const validation = SprintContractSchema.safeParse(contract);
  if (!validation.success) {
    throw new Error(
      `Invalid contract:\n${formatZodIssues(validation.error)}`,
    );
  }

  // Quality gate: vague phrases the schema can't express via min-length alone.
  const precisionIssues = findPrecisionIssues(validation.data);
  if (precisionIssues.length > 0) {
    const formatted = precisionIssues
      .map((i) => `  - ${i.field}: ${i.message}`)
      .join("\n");
    throw new Error(
      `Contract "${contract.contractId}" failed precision gate:\n${formatted}`,
    );
  }

  const filePath = contractPath(projectRoot, contract.contractId);
  await writeFile(filePath, JSON.stringify(contract, null, 2), "utf-8");
}

/**
 * Load a sprint contract by id.
 * Throws if not found or invalid.
 */
export async function loadContract(
  projectRoot: string,
  id: string,
): Promise<SprintContract> {
  const filePath = contractPath(projectRoot, id);

  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err) {
    throw new Error(
      `Contract "${id}" not found: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (err) {
    throw new Error(
      `Invalid JSON in contract file for "${id}": ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }

  const result = SprintContractSchema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `Contract "${id}" failed validation:\n${formatZodIssues(result.error)}`,
    );
  }

  return result.data;
}

/**
 * A contract file on disk that {@link listContractsWithSkips} could not return.
 *
 * Carries enough to act on: which file, and why it did not parse.
 */
export interface SkippedContractFile {
  /** Basename within `.bober/contracts/`, e.g. `sprint-spec-foo-3.json`. */
  file: string;
  /** Why it was skipped — unreadable, bad JSON, or the failing schema paths. */
  reason: string;
}

/** What {@link listContractsWithSkips} returns: both halves of the directory. */
export interface ContractListing {
  /** Files that parsed, sorted by filename. */
  contracts: SprintContract[];
  /** Files that did not, sorted by filename. Never silently dropped. */
  skipped: SkippedContractFile[];
}

/**
 * List saved contracts AND the files that could not be read.
 *
 * ── Why both halves ─────────────────────────────────────────────────
 *
 * Skipping an unparseable file is the right call — one bad file must not
 * break listing for the rest — but skipping it SILENTLY is not, because every
 * caller then reports a corpus smaller than the one on disk with nothing to
 * indicate the gap. Measured on this repository: 248 contract files, of which
 * 52 fail `SprintContractSchema` and 44 of those are settled, so a settled
 * count read through the old `listContracts` under-reported by 44 with no
 * signal at all.
 *
 * The failures are schema-evolution debt, not corruption: 36 files use the
 * pre-`contractId` shape (`id`/`feature`/`expectedChanges`, prose
 * `verificationMethod`), 12 predate the precision fields (`nonGoals`,
 * `stopConditions`, `definitionOfDone`) being required, and 4 carry values
 * that later left their enum (`estimatedDuration: "high"`,
 * `verificationMethod: "command"`). They are deliberately NOT rewritten:
 * back-filling a required `definitionOfDone` onto a sprint that ran before the
 * field existed would invent planning rationale nobody wrote, and this
 * repository's schema exists to refuse invented precision. Reporting the gap
 * is honest; papering over it is not.
 */
export async function listContractsWithSkips(
  projectRoot: string,
): Promise<ContractListing> {
  const dir = contractsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet — no contracts, and nothing was skipped.
    return { contracts: [], skipped: [] };
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith(".json"))
    .sort();

  const contracts: SprintContract[] = [];
  const skipped: SkippedContractFile[] = [];

  for (const file of jsonFiles) {
    const filePath = join(dir, file);

    let content: string;
    try {
      content = await readFile(filePath, "utf-8");
    } catch (err) {
      skipped.push({
        file,
        reason: `unreadable: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    let parsed: unknown;
    try {
      parsed = JSON.parse(content);
    } catch (err) {
      skipped.push({
        file,
        reason: `invalid JSON: ${err instanceof Error ? err.message : String(err)}`,
      });
      continue;
    }

    const result = SprintContractSchema.safeParse(parsed);
    if (result.success) {
      contracts.push(result.data);
    } else {
      skipped.push({
        file,
        reason: `failed schema validation:\n${formatZodIssues(result.error)}`,
      });
    }
  }

  return { contracts, skipped };
}

/**
 * List all saved contracts, sorted by filename.
 *
 * Files that fail validation are skipped — to surface validation errors for a
 * single known id, use `loadContract`, and to see WHICH files were skipped and
 * why, use {@link listContractsWithSkips}, of which this is the
 * contracts-only projection. Callers that report a count to a human should
 * prefer that one: this signature cannot distinguish "no such contract" from
 * "the file is there but does not parse".
 */
export async function listContracts(
  projectRoot: string,
): Promise<SprintContract[]> {
  return (await listContractsWithSkips(projectRoot)).contracts;
}

/**
 * Update an existing contract (save with the same contractId).
 */
export async function updateContract(
  projectRoot: string,
  contract: SprintContract,
): Promise<void> {
  await saveContract(projectRoot, contract);
}

/**
 * Delete all contract files in `.bober/contracts/` whose parsed `specId`
 * matches the given specId. Other specs' contracts are left untouched.
 *
 * Silently ignores missing directories, unreadable files, and non-JSON
 * files so that a partial state never aborts a re-plan.
 */
export async function clearContractsForSpec(
  projectRoot: string,
  specId: string,
): Promise<void> {
  const dir = contractsDir(projectRoot);
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory absent — nothing to clear.
    return;
  }

  for (const file of entries.filter((f) => f.endsWith(".json"))) {
    const filePath = join(dir, file);
    try {
      const raw = await readFile(filePath, "utf-8");
      const body = JSON.parse(raw) as { specId?: string };
      if (body.specId === specId) {
        await unlink(filePath).catch(() => {});
      }
    } catch {
      // Skip unreadable or non-JSON files.
    }
  }
}
