/**
 * HttpClient — the SOLE provider-agnostic HTTP transport seam under
 * `src/seo/` (spec-20260715-ultimate-seo-suite, Sprint 8; ADR-5).
 *
 * `src/seo/adapters/http.ts` is the ONLY file under `src/seo/` allowed to
 * reference the global `fetch`. Every live adapter (`GscAdapter` this
 * sprint, `DataForSeoAdapter` in Sprint 9) takes an injectable `HttpClient`
 * constructor param defaulting to `defaultHttpClient`; tests inject a fake
 * so no socket ever opens in CI. Mirrors the injectable-transport pattern
 * in `src/medical/retrieval/medline-source.ts:37-39` and
 * `src/medical/whoop/whoop-client.ts:40-52`, generalised to a
 * `{method, headers, body}` request shape shared by both GSC and
 * DataForSEO (both are plain JSON-over-HTTPS POST APIs).
 *
 * bober: no retry/backoff here — a thin request/response shim only. Each
 *        adapter owns its own error handling (429/5xx -> abstain) per
 *        ADR-5. Add shared retry logic only if a second adapter needs the
 *        exact same policy.
 */

/** Duck-typed response — deliberately NOT the global `Response` type, so
 *  tests can construct fakes without touching the real fetch API. */
export interface HttpResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

/** One outbound request's method/headers/body. */
export interface HttpRequestInit {
  method: string;
  headers?: Record<string, string>;
  body?: string;
}

/** Provider-agnostic injectable HTTP transport. */
export interface HttpClient {
  request(url: string, init: HttpRequestInit): Promise<HttpResponse>;
}

/**
 * Default transport = global fetch. The sole global-fetch reference under
 * `src/seo/`. Adapters take this as their default `http` constructor param;
 * tests always inject a fake `HttpClient` instead.
 */
export const defaultHttpClient: HttpClient = {
  async request(url, init) {
    const res = await fetch(url, {
      method: init.method,
      headers: init.headers,
      body: init.body,
    });
    return { ok: res.ok, status: res.status, json: () => res.json() };
  },
};
