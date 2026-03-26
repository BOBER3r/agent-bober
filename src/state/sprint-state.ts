import { readFile, writeFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import {
  SprintContractSchema,
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

/**
 * Save a sprint contract to disk.
 * Overwrites any existing contract with the same id.
 */
export async function saveContract(
  projectRoot: string,
  contract: SprintContract,
): Promise<void> {
  await ensureDir(contractsDir(projectRoot));

  const validation = SprintContractSchema.safeParse(contract);
  if (!validation.success) {
    const issues = validation.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Invalid contract:\n${issues}`);
  }

  const filePath = contractPath(projectRoot, contract.id);
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
    const issues = result.error.issues
      .map((i) => `  - ${i.path.join(".")}: ${i.message}`)
      .join("\n");
    throw new Error(`Contract "${id}" failed validation:\n${issues}`);
  }

  return result.data;
}

/**
 * List all saved contracts, sorted by filename.
 */
export async function listContracts(
  projectRoot: string,
): Promise<SprintContract[]> {
  const dir = contractsDir(projectRoot);

  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    // Directory doesn't exist yet — no contracts
    return [];
  }

  const jsonFiles = entries
    .filter((f) => f.endsWith(".json"))
    .sort();

  const contracts: SprintContract[] = [];

  for (const file of jsonFiles) {
    const filePath = join(dir, file);
    try {
      const content = await readFile(filePath, "utf-8");
      const parsed: unknown = JSON.parse(content);
      const result = SprintContractSchema.safeParse(parsed);
      if (result.success) {
        contracts.push(result.data);
      }
    } catch {
      // Skip malformed files
    }
  }

  return contracts;
}

/**
 * Update an existing contract (save with the same id).
 */
export async function updateContract(
  projectRoot: string,
  contract: SprintContract,
): Promise<void> {
  await saveContract(projectRoot, contract);
}
