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
