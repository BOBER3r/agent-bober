/**
 * DataForSeoSerpProvider — the `SerpProvider` (`../serp-provider.js`)
 * implementation backed by the DataForSEO SERP API
 * (spec-20260717-seo-improver-builder, Sprint 8; ADR-10).
 *
 * A THIN delegate over the existing, already egress+governor-gated
 * `DataForSeoAdapter.serp` path (`./dataforseo-adapter.ts:190-238`) — this
 * class does no HTTP, no parsing, no egress check, and no USD booking of
 * its own. `adapter.serp` already:
 *   1. asserts the `"serp-provider"` egress axis (`dataforseo-adapter.ts:193`),
 *   2. gates `governor.admit()` before opening a socket,
 *   3. books the actual USD via `governor.record(admitReq, 0.0006)`
 *      (`dataforseo-adapter.ts:227`) ONLY after a successful round-trip.
 * Calling it a SECOND time here would double-charge and break the
 * byte-identical-when-off / byte-identical-to-today invariant — so this
 * wrapper's `serp()` body is a single delegating call, nothing else.
 */
import type { DataOutcome } from "../types.js";
import type { SerpRow } from "../data-source.js";
import type { SerpProvider } from "../serp-provider.js";
import type { DataForSeoAdapter } from "./dataforseo-adapter.js";

/**
 * Documented standard-SERP price (mirrors the `SERP_PRICE_USD.standard`
 * constant, `dataforseo-adapter.ts:67-71` — NOT exported from that module,
 * restated here as metadata only; the real charge is computed and booked
 * inside the wrapped adapter, not by this constant).
 */
const DATAFORSEO_SERP_COST_USD = 0.0006;

export class DataForSeoSerpProvider implements SerpProvider {
  readonly name = "dataforseo" as const;
  readonly estCostUsdPerResult = DATAFORSEO_SERP_COST_USD;

  constructor(private readonly adapter: DataForSeoAdapter) {}

  /** Delegates to the existing, already egress+governor-gated `adapter.serp` path — output byte-identical to today. */
  serp(keyword: string, location: string): Promise<DataOutcome<SerpRow[]>> {
    return this.adapter.serp({ keyword, location });
  }
}
