/**
 * Supplements list -> FactStore. PURE deterministic reconcile.
 * NO LLM, NO network, NO Date.now() — `now` is injected.
 * Hand-rolled frontmatter parse mirrors lab-note.ts:120-148.
 * NEVER import src/vault.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { FactStore, writeFact, factsDbPath, ensureFactsDir } from "../state/facts.js";

// -- Types ---------------------------------------------------------------

/** A single supplement entry parsed from the markdown-frontmatter list. */
export interface SupplementEntry {
  name: string;
  dose: string | undefined;
}

/** Placeholder value when --dose is omitted (FactSchema requires value.min(1)). */
export const DEFAULT_DOSE = "unspecified";

// -- Pure parser ---------------------------------------------------------

/**
 * Parse a supplements markdown-frontmatter file into a list of entries.
 *
 * Expected format:
 * ```
 * ---
 * supplements:
 *   - Vitamin D | 1000 IU
 *   - Magnesium | 200 mg
 * ---
 * ```
 *
 * Replicates the hand-rolled fence-find loop from lab-note.ts:121-136.
 * NEVER imports src/vault/frontmatter.ts (lab-note.ts:9-12 precedent).
 * NEVER imports parseLabNote — it returns the lab flat-scalar shape and is list-unaware.
 */
export function parseSupplementsFile(raw: string): SupplementEntry[] {
  const lines = raw.split("\n");

  if (lines[0]?.trim() !== "---") {
    throw new Error("parseSupplementsFile: missing opening '---' fence");
  }

  let closingIdx = -1;
  for (let i = 1; i < lines.length; i++) {
    if (lines[i]?.trim() === "---") {
      closingIdx = i;
      break;
    }
  }
  if (closingIdx === -1) {
    throw new Error("parseSupplementsFile: missing closing '---' fence");
  }

  const yamlLines = lines.slice(1, closingIdx);
  const entries: SupplementEntry[] = [];
  let inSupplements = false;

  for (const line of yamlLines) {
    if (line.trim() === "supplements:") {
      inSupplements = true;
      continue;
    }
    if (!inSupplements) continue;

    // Detect list items: lines starting with optional whitespace, then `- `
    const listMatch = /^\s+-\s+(.+)$/.exec(line);
    if (listMatch === null) {
      // Non-indented non-empty line signals the end of the supplements list
      if (line.trim().length > 0 && !/^\s/.test(line)) {
        inSupplements = false;
      }
      continue;
    }

    const itemText = (listMatch[1] ?? "").trim();
    const pipeIdx = itemText.indexOf("|");
    if (pipeIdx >= 0) {
      const name = itemText.slice(0, pipeIdx).trim();
      const dose = itemText.slice(pipeIdx + 1).trim() || undefined;
      if (name.length > 0) entries.push({ name, dose });
    } else {
      if (itemText.length > 0) entries.push({ name: itemText, dose: undefined });
    }
  }

  return entries;
}

// -- FactInput builder ---------------------------------------------------

/**
 * Build a FactInput from a supplement name + optional dose.
 *
 * scope = "medical", subject = supplement name, predicate = "dose", value = dose ?? DEFAULT_DOSE.
 * `now` is injected (never reads the clock).
 *
 * bober: predicate "dose" makes each supplement its own subject row in FactStore;
 *        contrast with medications which use subject "patient", predicate "takes-medication".
 */
export function supplementToFact(
  name: string,
  dose: string | undefined,
  now: string,
) {
  return {
    scope: "medical",
    subject: name,
    predicate: "dose",
    value: dose ?? DEFAULT_DOSE,
    confidence: 1,
    sourceRunId: null,
    tValid: now,
    tCreated: now,
  };
}

// -- Deps interfaces -----------------------------------------------------

/** Injectable dependencies for runSupplementAdd — production callers pass undefined. */
export interface SupplementAddDeps {
  /** Override the FactStore (e.g. in-memory store in tests). */
  store?: FactStore;
  /** Override the current time ISO string (default: new Date().toISOString()). */
  now?: string;
}

// -- Cores ---------------------------------------------------------------

/**
 * Core logic for `bober medical supplements add <name> [--dose <d>]`.
 *
 * Reconciles one supplement into FactStore (scope "medical") via writeFact.
 * NO judge — deterministic ADD/UPDATE/NOOP path only.
 * `now` is stamped at this boundary; the pure reconcile path never reads the clock.
 *
 * .action() MUST NOT throw — errors are caught, process.exitCode is set to 1, and the
 * function returns. Pattern mirrors runImportLabs in medical.ts:203-212.
 */
export async function runSupplementAdd(
  projectRoot: string,
  name: string,
  opts: { dose?: string },
  deps: SupplementAddDeps = {},
): Promise<void> {
  // Stamp wall-clock ONCE at the CLI boundary (injected `now` used in tests).
  const now = deps.now ?? new Date().toISOString();
  // Track the store we own so we can close it in finally without closing injected stores.
  let ownedStore: FactStore | undefined;

  try {
    let store: FactStore;
    if (deps.store !== undefined) {
      store = deps.store;
    } else {
      await ensureFactsDir(projectRoot, "medical");
      ownedStore = new FactStore(factsDbPath(projectRoot, "medical"));
      store = ownedStore;
    }

    const input = supplementToFact(name, opts.dose, now);
    const action = await writeFact(store, input, { now });

    if (action === "add") {
      process.stdout.write(
        `Added supplement: ${name} (${opts.dose ?? DEFAULT_DOSE})\n`,
      );
    } else if (action === "update") {
      process.stdout.write(
        `Updated supplement: ${name} -> ${opts.dose ?? DEFAULT_DOSE}\n`,
      );
    } else {
      // "noop" (or "delete", which only occurs with a judge — never here)
      process.stdout.write(`Supplement unchanged: ${name}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `Failed to add supplement: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  } finally {
    ownedStore?.close();
  }
}

/**
 * Core logic for `bober medical supplements list [--file <path>]`.
 *
 * Reads the supplements markdown-frontmatter file and prints each entry to stdout.
 * Default file path: <projectRoot>/.bober/medical/supplements.md
 *
 * .action() MUST NOT throw — errors are caught and process.exitCode is set to 1.
 */
export async function runSupplementList(
  projectRoot: string,
  opts: { file?: string },
): Promise<void> {
  try {
    const filePath =
      opts.file ?? join(projectRoot, ".bober", "medical", "supplements.md");
    const raw = await readFile(filePath, "utf-8");
    const entries = parseSupplementsFile(raw);

    if (entries.length === 0) {
      process.stdout.write("No supplements found.\n");
      return;
    }

    for (const entry of entries) {
      process.stdout.write(`${entry.name}: ${entry.dose ?? DEFAULT_DOSE}\n`);
    }
  } catch (err) {
    process.stderr.write(
      `Failed to list supplements: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
