/** Online research retrieval — injectable client so tests never hit the network. */

// ── Types ─────────────────────────────────────────────────────────────

/** One retrieved web source. title + url form the citation. */
export interface RetrievalSource {
  title: string;
  url: string;
}

/**
 * Injectable retrieval client — duck-typed, offline-testable.
 * Tests pass a spy returning fixture data; production binds to a real search client.
 * (Mirrors FetchLike in src/medical/retrieval/medline-source.ts.)
 */
export interface RetrievalClient {
  search(query: string): Promise<RetrievalSource[]>;
}

// ── retrieve ──────────────────────────────────────────────────────────

/**
 * Retrieve sources for a query via the injected client.
 *
 * NOTE: this fn does NOT itself check egress — the runner gates the call (see runner.ts).
 * The runner checks isAllowed BEFORE calling retrieve; when off, retrieve is never invoked.
 *
 * Returns [] on any client error (fail-closed; never throws out).
 *
 * bober: injectable client interface; swap client impl for any web search provider
 *        without touching this function.
 */
export async function retrieve(query: string, client: RetrievalClient): Promise<RetrievalSource[]> {
  try {
    return await client.search(query);
  } catch {
    return [];
  }
}
