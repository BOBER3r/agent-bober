import { FactStore, factsDbPath } from "../state/facts.js";
import { FactStoreFindingSource, HUB_SCOPE } from "./finding-source.js";
import type { Finding } from "./finding.js";

// ── collectFindings ───────────────────────────────────────────────────

/**
 * Open each sibling repo's derived FactStore READ-ONLY, read its findings,
 * pool them into one Finding[] deduplicated by Finding.id (keep first,
 * stable order). PURE: no LLM, no network. A missing/corrupt sibling is
 * skipped, never fatal.
 *
 * @param repoPaths  Absolute repo-root paths (each has a derived facts.db).
 * @param scope      FactStore scope to read from (defaults to HUB_SCOPE).
 */
export function collectFindings(
  repoPaths: string[],
  scope: string = HUB_SCOPE,
): Finding[] {
  const pooled: Finding[] = [];
  const seen = new Set<string>();

  for (const repo of repoPaths) {
    let store: FactStore | undefined;
    try {
      store = new FactStore(factsDbPath(repo), { readonly: true });
      for (const f of new FactStoreFindingSource(store, scope).read()) {
        if (seen.has(f.id)) continue; // dedup by Finding.id (keep first)
        seen.add(f.id);
        pooled.push(f);
      }
    } catch {
      // missing or corrupt sibling -> skip, never fatal
    } finally {
      store?.close();
    }
  }

  return pooled;
}
