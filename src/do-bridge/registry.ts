import type { PromoterKey, Promoter } from "./types.js";

// ── Key serialization ─────────────────────────────────────────────────

/**
 * Serialize a PromoterKey to a Map-lookup string.
 * Domain+kind and domain-only never collide because kind is separated by
 * a space that domain-only registrations leave as an empty suffix.
 *
 * Examples:
 *   {domain:"coding", kind:"action"} → "coding action"
 *   {domain:"coding"}               → "coding "        (trailing space = domain-only)
 */
function serializeKey(key: PromoterKey): string {
  return `${key.domain} ${key.kind ?? ""}`;
}

// ── PromoterRegistry ──────────────────────────────────────────────────

/**
 * Registry of Promoters keyed by PromoterKey {domain, kind?}.
 *
 * Resolution precedence (sc-1-2):
 *   1. domain+kind specific match
 *   2. domain-only fallback
 *   3. undefined — the CLI handler converts this to process.exitCode=1 (sc-1-5)
 *
 * resolve() returns undefined (never throws) for unsupported domains.
 * Modelled on src/orchestrator/checkpoints/registry.ts keyed-registry pattern.
 */
export class PromoterRegistry {
  private readonly map = new Map<string, Promoter>();

  /** Register a Promoter under the given key. Overwrites any prior registration. */
  register(key: PromoterKey, promoter: Promoter): void {
    this.map.set(serializeKey(key), promoter);
  }

  /**
   * Resolve the Promoter for a given key.
   * Tries domain+kind first; falls back to domain-only; returns undefined if neither exists.
   */
  resolve(key: PromoterKey): Promoter | undefined {
    const specificKey = serializeKey(key);
    const domainOnlyKey = serializeKey({ domain: key.domain });
    return this.map.get(specificKey) ?? this.map.get(domainOnlyKey);
  }
}
