/**
 * LocalExportSource — offline `SeoDataSource` (spec-20260715-ultimate-seo-suite,
 * Sprint 6). Parses crawl output + GSC/SERP exports dropped under
 * `.bober/seo/imports/` (one file per capability, `<capability>.csv` or
 * `<capability>.json` — see the briefing's file-convention table).
 *
 * Blends the never-throws-per-method discipline of
 * `src/medical/retrieval/medline-source.ts` with the async-fs + memoised
 * `load()` pattern of `../playbook-index.js`. Unlike `MedlineSource`, this
 * source takes NO `EgressGuard` and NO transport — it is offline by
 * construction; "disabled" here means *no local file for this capability*,
 * not *axis off*. Zero network imports: reads local files only.
 */
import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";

import { readJson } from "../../utils/fs.js";
import type {
  SeoDataSource,
  SeoCapability,
  SearchAnalyticsQuery,
  SearchAnalyticsRow,
  UrlInspectionQuery,
  UrlInspectionRow,
  SerpQuery,
  SerpRow,
  KeywordQuery,
  KeywordRow,
  BacklinkQuery,
  BacklinkRow,
  AiVisibilityQuery,
  AiVisibilityRow,
  LinkGraphQuery,
  LinkGraphRow,
} from "../data-source.js";
import type { DataOutcome, DataProvenance } from "../types.js";

/** Relative to cwd; tests pass an absolute fixture directory instead. */
const DEFAULT_EXPORT_DIR = ".bober/seo/imports";

/**
 * The subset of `SeoCapability` this sprint's `LocalExportSource` serves from
 * a local file. `ai-visibility`/`link-graph` are NOT in this alias yet — they
 * have no local file/mapper this sprint (Sprint 1 is pure disabled-arms;
 * F5/F7 wire the offline arms). Narrowing here keeps `CAPABILITIES` and
 * `FILE_BASENAME` from being an exhaustive `Record<SeoCapability, ...>`,
 * which would otherwise fail to compile the moment `SeoCapability` widened
 * to 7 members.
 */
type FileBackedCapability =
  | "search-analytics"
  | "url-inspection"
  | "serp"
  | "keywords"
  | "backlinks";

const CAPABILITIES: FileBackedCapability[] = [
  "search-analytics",
  "url-inspection",
  "serp",
  "keywords",
  "backlinks",
];

/** `<capability>` file basename — see the briefing's import-convention table. */
const FILE_BASENAME: Record<FileBackedCapability, string> = {
  "search-analytics": "search-analytics",
  "url-inspection": "url-inspection",
  serp: "serp",
  keywords: "keywords",
  backlinks: "backlinks",
};

type FileEntry = { path: string; ext: "csv" | "json" };

// -- Hand-rolled CSV parser (no dependency — no CSV/tabular parser exists
//    anywhere in the repo; see the briefing §5 recommendation) -----------

/** Split one CSV record line into fields, honoring quotes/escaped `""`. */
function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          cur += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        cur += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ",") {
      fields.push(cur);
      cur = "";
    } else {
      cur += ch;
    }
  }
  fields.push(cur);
  return fields;
}

/**
 * Pure, total CSV reader. First non-empty line is the header; every
 * subsequent non-empty line becomes one record keyed by that header.
 * Handles quoted fields (including embedded commas and escaped `""`),
 * `\r\n`/`\n` line endings, and a trailing blank line. Header-only input
 * (or empty input) returns `[]`. NEVER throws (same spirit as
 * `SeoPlaybookParser.parse`, `../parser.js:151-169`).
 */
export function parseCsv(text: string): Array<Record<string, string>> {
  if (typeof text !== "string") return [];
  const lines = text.split(/\r\n|\n/).filter((line) => line.length > 0);
  if (lines.length === 0) return [];

  const header = parseCsvLine(lines[0]);
  const rows: Array<Record<string, string>> = [];
  for (const line of lines.slice(1)) {
    const values = parseCsvLine(line);
    const row: Record<string, string> = {};
    header.forEach((key, idx) => {
      row[key] = values[idx] ?? "";
    });
    rows.push(row);
  }
  return rows;
}

// -- Numeric coercion helpers (CSV/JSON values arrive as strings; guard NaN) --

function toNumber(value: string | undefined): number {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

function toOptionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value === "") return undefined;
  const n = Number(value);
  return Number.isFinite(n) ? n : undefined;
}

function toOptionalString(value: string | undefined): string | undefined {
  return value === undefined || value === "" ? undefined : value;
}

function toOptionalBoolean(value: string | undefined): boolean | undefined {
  if (value === undefined || value === "") return undefined;
  return value === "true" || value === "1";
}

// -- Per-capability row mappers (record<string,string> -> typed Row; keys
//    MUST match the CSV header / JSON keys 1:1, see data-source.ts) ------

function mapSearchAnalyticsRow(r: Record<string, string>): SearchAnalyticsRow {
  return {
    query: toOptionalString(r.query),
    page: toOptionalString(r.page),
    country: toOptionalString(r.country),
    device: toOptionalString(r.device),
    clicks: toNumber(r.clicks),
    impressions: toNumber(r.impressions),
    ctr: toNumber(r.ctr),
    position: toNumber(r.position),
  };
}

function mapUrlInspectionRow(r: Record<string, string>): UrlInspectionRow {
  return {
    url: r.url ?? "",
    coverageState: toOptionalString(r.coverageState),
    indexingState: toOptionalString(r.indexingState),
    lastCrawlTime: toOptionalString(r.lastCrawlTime),
    robotsTxtState: toOptionalString(r.robotsTxtState),
    pageFetchState: toOptionalString(r.pageFetchState),
  };
}

function mapSerpRow(r: Record<string, string>): SerpRow {
  return {
    keyword: r.keyword ?? "",
    position: toNumber(r.position),
    url: r.url ?? "",
    title: toOptionalString(r.title),
    location: toOptionalString(r.location),
  };
}

function mapKeywordRow(r: Record<string, string>): KeywordRow {
  return {
    keyword: r.keyword ?? "",
    searchVolume: toOptionalNumber(r.searchVolume),
    cpc: toOptionalNumber(r.cpc),
    competition: toOptionalNumber(r.competition),
    location: toOptionalString(r.location),
  };
}

function mapBacklinkRow(r: Record<string, string>): BacklinkRow {
  return {
    sourceUrl: r.sourceUrl ?? "",
    targetUrl: r.targetUrl ?? "",
    anchor: toOptionalString(r.anchor),
    dofollow: toOptionalBoolean(r.dofollow),
  };
}

// -- LocalExportSource ------------------------------------------------------

/**
 * Offline `SeoDataSource` backed by `.bober/seo/imports/` (or any directory
 * passed to the constructor — tests inject an absolute fixture path).
 *
 * `capabilities()` is synchronous but presence detection requires an async
 * `readdir`, so the present-file map is memoised in `load()` (mirrors
 * `SeoPlaybookIndex.load()`, `../playbook-index.js:43-67`). Every
 * capability method also calls `load()` itself if it hasn't run yet, so a
 * method invoked before an explicit `load()` still resolves correctly.
 */
export class LocalExportSource implements SeoDataSource {
  private files: Map<SeoCapability, FileEntry> | null = null;

  constructor(private readonly exportDir: string = DEFAULT_EXPORT_DIR) {}

  /**
   * Scan `exportDir` once for `<capability>.csv`/`.json` files and cache
   * which capabilities have a present file. Never throws: a missing
   * directory degrades to an empty capability set rather than rejecting.
   */
  async load(): Promise<SeoCapability[]> {
    if (this.files) return [...this.files.keys()];

    const found = new Map<SeoCapability, FileEntry>();
    let entries: string[];
    try {
      entries = await readdir(this.exportDir);
    } catch {
      this.files = found;
      return [];
    }

    for (const cap of CAPABILITIES) {
      const base = FILE_BASENAME[cap];
      if (entries.includes(`${base}.csv`)) {
        found.set(cap, { path: join(this.exportDir, `${base}.csv`), ext: "csv" });
      } else if (entries.includes(`${base}.json`)) {
        found.set(cap, { path: join(this.exportDir, `${base}.json`), ext: "json" });
      }
    }

    this.files = found;
    return [...found.keys()];
  }

  /** The capabilities this source can currently serve, or `[]` before `load()` has run. */
  capabilities(): SeoCapability[] {
    return [...(this.files?.keys() ?? [])];
  }

  async searchAnalytics(
    _q: SearchAnalyticsQuery,
  ): Promise<DataOutcome<SearchAnalyticsRow[]>> {
    return this.readCapability("search-analytics", mapSearchAnalyticsRow);
  }

  async urlInspection(_q: UrlInspectionQuery): Promise<DataOutcome<UrlInspectionRow[]>> {
    return this.readCapability("url-inspection", mapUrlInspectionRow);
  }

  async serp(_q: SerpQuery): Promise<DataOutcome<SerpRow[]>> {
    return this.readCapability("serp", mapSerpRow);
  }

  async keywords(_q: KeywordQuery): Promise<DataOutcome<KeywordRow[]>> {
    return this.readCapability("keywords", mapKeywordRow);
  }

  async backlinks(_q: BacklinkQuery): Promise<DataOutcome<BacklinkRow[]>> {
    return this.readCapability("backlinks", mapBacklinkRow);
  }

  // -- Capabilities this sprint's LocalExportSource does not yet serve;
  //    F5/F7 wire the offline ai-visibility/link-graph arms in a later
  //    sprint (nonGoal this sprint) --------------------------------------

  async aiVisibility(_q: AiVisibilityQuery): Promise<DataOutcome<AiVisibilityRow[]>> {
    return { kind: "disabled" };
  }

  async linkGraph(_q: LinkGraphQuery): Promise<DataOutcome<LinkGraphRow[]>> {
    return { kind: "disabled" };
  }

  /**
   * Shared read path for every capability method.
   *
   * Order: ensure `load()` has run -> absent file => `disabled` -> read +
   * parse (CSV or JSON) -> zero rows => `abstain{empty-export}` -> `stat`
   * for `mtimeMs` -> `data` + `provenance{source:"local-export",
   * retrievedAt, path, mtimeMs}` (sc-6-4). NEVER throws out of this
   * method — any fs/parse error maps to `abstain{source-error}`, mirroring
   * `MedlineSource.fetchPassages` (`../../medical/retrieval/medline-source.js:142-164`).
   */
  private async readCapability<T>(
    cap: SeoCapability,
    map: (r: Record<string, string>) => T,
  ): Promise<DataOutcome<T[]>> {
    try {
      if (!this.files) {
        await this.load();
      }
      const entry = this.files?.get(cap);
      if (!entry) {
        return { kind: "disabled" };
      }

      let records: Array<Record<string, string>>;
      if (entry.ext === "csv") {
        const text = await readFile(entry.path, "utf-8");
        records = parseCsv(text);
      } else {
        const parsed = await readJson<unknown>(entry.path);
        records = Array.isArray(parsed) ? (parsed as Array<Record<string, string>>) : [];
      }

      if (records.length === 0) {
        return { kind: "abstain", reason: "empty-export" };
      }

      const rows = records.map(map);
      const fileStat = await stat(entry.path);
      const provenance: DataProvenance = {
        source: "local-export",
        retrievedAt: new Date().toISOString(),
        path: entry.path,
        mtimeMs: fileStat.mtimeMs,
      };
      return { kind: "data", rows, provenance };
    } catch {
      // Includes: unreadable file, invalid JSON, stat failure. NEVER fail-open.
      return { kind: "abstain", reason: "source-error" };
    }
  }
}
