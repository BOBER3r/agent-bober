/**
 * GroundedSearchClient — provider-agnostic web-search grounding
 * (in-house-ai-visibility, Sprint 1;
 * arch-20260717-in-house-oss-ai-visibility-architecture.md:118-129,247-248).
 *
 * Wraps an injected `LLMClient.chat` (`providers/types.ts:282`) with a
 * `web_search` `ToolDef` and normalizes the vendor-native citation payload
 * (surfaced via `ChatResponse.groundingCitations`, `types.ts`) into a plain
 * `GroundedAnswer`. No `@anthropic-ai/sdk` or `openai` type crosses this
 * file's boundary (sc-1-4) — it imports ONLY from `./types.js`.
 *
 * The `LLMClient` is CONSTRUCTOR-injected (mirrors `SeoAnalyzer(llm, model)`,
 * `seo/analyzer.ts:304-307`) — a scripted fake drives every test here; the
 * real client (and any seam wiring into `AiVisibilityProvider`) is built by
 * a LATER sprint (nonGoals: no adapter wiring, no multiplexer, no factory,
 * no `src/seo/` changes this sprint).
 *
 * `anthropic.ts`'s `normalizeContent` currently DROPS `web_search` citation
 * blocks, so no real adapter populates `ChatResponse.groundingCitations`
 * yet — that population is deferred to a later sprint (see the field's doc
 * comment in `types.ts`). This client already reads and normalizes the
 * field; it just has nothing to read from a live call today.
 *
 * Sprint 7 adds `PerplexitySonarClient`, a SECOND `GroundedSearchClient`
 * implementation in this same file. Perplexity Sonar is a direct HTTP
 * `chat/completions` API, not reachable through `LLMClient.chat` — that
 * class does not wrap an `LLMClient` and introduces the file's only
 * `fetch` reference, behind an injectable transport. All Perplexity-
 * specific types stay local/unexported to this file (sc-7-4).
 */
import type { ChatResponse, LLMClient, ToolDef } from "./types.js";

// ── Public provider-agnostic types (sc-1-1) ─────────────────────────

/**
 * Grounded-search engines. `"perplexity"` is part of the type (sc-1-1
 * requires it in the union) but has NO implementation this sprint — it is
 * Sprint 7 (nonGoal here). `LiveGroundedSearchClient.search` returns
 * `citations: []` for it without throwing.
 */
export type GroundedEngine = "anthropic" | "openai" | "perplexity";

/** A single normalized citation: just enough to attribute a claim. */
export interface GroundedCitation {
  url: string;
  title: string;
}

/** The normalized result of one grounded-search turn. */
export interface GroundedAnswer {
  answerText: string;
  citations: GroundedCitation[];
  /** USD cost of the underlying LLM call, when known. Key omitted (never
   * `costUsd: undefined`) when the cost cannot be determined — mirrors the
   * `ChatResponse.costUsd` convention (`types.ts`, `anthropic.ts:53,63`). */
  costUsd?: number;
}

/**
 * Provider-agnostic grounded-search surface. Implementations run one
 * web-search-enabled LLM turn and return a normalized `GroundedAnswer`.
 */
export interface GroundedSearchClient {
  readonly engine: GroundedEngine;
  search(prompt: string, locale?: string): Promise<GroundedAnswer>;
}

// ── web_search tool, expressed via the existing ToolDef surface (sc-1-2) ──

const WEB_SEARCH_TOOL: ToolDef = {
  name: "web_search",
  readOnly: true,
  description: "Search the web and cite the sources used to answer.",
  input_schema: {
    type: "object",
    properties: {
      query: { type: "string", description: "The search query to run." },
    },
    required: ["query"],
  },
};

// ── Per-engine citation mappers (sc-1-2) ────────────────────────────

type RawGroundingCitation = NonNullable<ChatResponse["groundingCitations"]>[number];

/**
 * Anthropic `web_search_result_location` → `{url, title}`. `cited_text` is
 * intentionally dropped — `GroundedCitation` only carries `{url, title}`
 * (arch doc :247).
 */
function mapAnthropicCitations(raw: RawGroundingCitation[]): GroundedCitation[] {
  return raw.map((c) => ({ url: c.url, title: c.title ?? c.url }));
}

/** OpenAI `url_citation` annotation → `{url, title}`. */
function mapOpenAiCitations(raw: RawGroundingCitation[]): GroundedCitation[] {
  return raw.map((c) => ({ url: c.url, title: c.title ?? c.url }));
}

// ── LiveGroundedSearchClient (sc-1-2, sc-1-3) ───────────────────────

/**
 * Wraps an injected `LLMClient.chat` to run a single web-search-grounded
 * turn and normalize its citations. Never constructs a real provider
 * client itself — the caller injects one built by `createClient`
 * (`factory.ts`) at wiring time (a later sprint).
 */
export class LiveGroundedSearchClient implements GroundedSearchClient {
  constructor(
    readonly engine: GroundedEngine,
    private readonly llm: LLMClient,
    private readonly model: string,
  ) {}

  /**
   * Runs one grounded-search turn. Never throws on a non-grounded response
   * (sc-1-3): `groundingCitations` is guarded with `?? []` before mapping,
   * so `citations` is simply `[]` when the model didn't ground its answer.
   */
  async search(prompt: string, locale?: string): Promise<GroundedAnswer> {
    const res = await this.llm.chat({
      model: this.model,
      system: buildSystemPrompt(locale),
      messages: [{ role: "user", content: prompt }],
      tools: [WEB_SEARCH_TOOL],
    });

    const raw = res.groundingCitations ?? [];
    const citations =
      this.engine === "anthropic"
        ? mapAnthropicCitations(raw)
        : this.engine === "openai"
          ? mapOpenAiCitations(raw)
          : []; // perplexity: Sprint 7, no mapper yet (sc-1-1 type-only)

    return {
      answerText: res.text,
      citations,
      ...(res.costUsd !== undefined ? { costUsd: res.costUsd } : {}),
    };
  }
}

function buildSystemPrompt(locale?: string): string {
  const localeClause = locale ? ` Answer as relevant to the "${locale}" locale.` : "";
  return (
    "You are a grounded-search assistant. Use the web_search tool to find " +
    "current, factual sources before answering, and cite every source you " +
    `rely on.${localeClause}`
  );
}

// ── PerplexitySonarClient (Sprint 7, sc-7-1..sc-7-4) ─────────────────

/**
 * Perplexity Sonar is a DIRECT HTTP `chat/completions` API — it is NOT
 * reachable through `LLMClient.chat` + a `web_search` `ToolDef`, so this
 * class (unlike `LiveGroundedSearchClient`) does not wrap an `LLMClient` at
 * all. Endpoint + default model per the Sonar docs; kept as local `const`s
 * so no magic string is repeated.
 */
const PERPLEXITY_API_URL = "https://api.perplexity.ai/chat/completions";
const PERPLEXITY_DEFAULT_MODEL = "sonar";

/**
 * Duck-typed response — deliberately NOT the global `Response` type, so
 * tests can construct fakes without touching the real fetch API. Mirrors
 * `HttpResponse` (`seo/adapters/http.ts:23-27`) in SHAPE only — defined
 * LOCALLY here (unexported) because `src/providers/` must not import from
 * `src/seo/` (sc-7-4 / sprint briefing Pattern C).
 */
interface PerplexityTransportResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/**
 * Fetch-like injectable transport — the SOLE seam through which
 * `PerplexitySonarClient` reaches the network. Defaults to a thin global-
 * `fetch` wrapper (`defaultPerplexityTransport` below); tests inject a fake
 * so no socket ever opens (sc-7-3).
 */
type PerplexityTransport = (
  url: string,
  init: { method: string; headers: Record<string, string>; body: string },
) => Promise<PerplexityTransportResponse>;

/** Default transport = global fetch. The sole global-fetch reference in this file. */
const defaultPerplexityTransport: PerplexityTransport = async (url, init) => {
  const res = await fetch(url, { method: init.method, headers: init.headers, body: init.body });
  return { ok: res.ok, status: res.status, json: () => res.json() };
};

/** One `search_results[]` entry — the richest Sonar citation shape (carries a title). */
interface SonarSearchResult {
  title?: string;
  url?: string;
}

/**
 * Raw Perplexity `chat/completions` Sonar response shape. Kept LOCAL and
 * UNEXPORTED so no Perplexity type ever crosses this file's boundary
 * (sc-7-4) — only `PerplexitySonarClient` (which implements the
 * provider-agnostic `GroundedSearchClient`) is exported.
 */
interface SonarChatCompletionResponse {
  choices?: { message?: { content?: string } }[];
  citations?: string[];
  search_results?: SonarSearchResult[];
}

/**
 * Normalize a Sonar response's citations into `GroundedCitation[]`. Prefers
 * `search_results` (richest — carries a title, same `title ?? url` fallback
 * as `mapAnthropicCitations`/`mapOpenAiCitations` above); falls back to the
 * plain `citations` URL array (URL doubles as title) when `search_results`
 * is absent/empty; `[]` when both are absent/empty (ungrounded).
 */
function mapSonarCitations(data: SonarChatCompletionResponse): GroundedCitation[] {
  const withUrls = (data.search_results ?? []).filter(
    (r): r is SonarSearchResult & { url: string } => typeof r.url === "string",
  );
  if (withUrls.length > 0) {
    return withUrls.map((r) => ({ url: r.url, title: r.title ?? r.url }));
  }
  return (data.citations ?? []).map((url) => ({ url, title: url }));
}

/**
 * `PerplexitySonarClient` — the third `GroundedSearchClient` arm (sc-7-1..
 * sc-7-4). Mirrors the DataForSEO credential-injection idiom
 * (`dataforseo-adapter.ts:162-178`): the API key is read from
 * `PERPLEXITY_API_KEY` via an injected `getApiKey` (never hardcoded), and
 * the network call goes through an injected `transport` — both default to
 * real implementations so production wiring needs no arguments, while tests
 * stub both and never open a real socket (sc-7-3).
 */
export class PerplexitySonarClient implements GroundedSearchClient {
  readonly engine: GroundedEngine = "perplexity";

  constructor(
    private readonly transport: PerplexityTransport = defaultPerplexityTransport,
    private readonly getApiKey: () => string | undefined = () => process.env["PERPLEXITY_API_KEY"],
    private readonly model: string = PERPLEXITY_DEFAULT_MODEL,
  ) {}

  /**
   * Runs one Sonar-grounded turn. Never throws (sc-7-1): a missing key, an
   * `!res.ok` response, a network error, or malformed JSON all degrade to
   * `{ answerText: "", citations: [] }` — there is no `DataOutcome`/abstain
   * at this layer (that happens upstream in `ApiSpineEngineProvider.probe`,
   * api-spine-provider.ts:80-84). `costUsd` is intentionally OMITTED
   * (Pattern D) — Sonar cost is already N-baked via `perCallUsd`.
   */
  async search(prompt: string, locale?: string): Promise<GroundedAnswer> {
    try {
      const apiKey = this.getApiKey();
      if (!apiKey) return { answerText: "", citations: [] };

      const localeClause = locale ? ` Answer as relevant to the "${locale}" locale.` : "";
      const res = await this.transport(PERPLEXITY_API_URL, {
        method: "POST",
        headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          model: this.model,
          messages: [
            {
              role: "system",
              content: `Search the web and cite every source you rely on.${localeClause}`,
            },
            { role: "user", content: prompt },
          ],
        }),
      });
      if (!res.ok) return { answerText: "", citations: [] };

      const data = (await res.json()) as SonarChatCompletionResponse;
      const answerText = data.choices?.[0]?.message?.content ?? "";
      return { answerText, citations: mapSonarCitations(data) };
    } catch {
      return { answerText: "", citations: [] };
    }
  }
}
