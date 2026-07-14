/**
 * MedlineSource tests — injectable transport + committed fixture (no live network).
 *
 * All tests inject a FetchLike transport returning fixture data or simulating errors.
 * The global fetch is NEVER called in these tests (it is banned in test files under
 * src/medical/ by the ESLint boundary; we use plain duck-typed objects instead).
 */
import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { MedlineSource, type FetchLike } from "./medline-source.js";
import type { RetrievalOutcome } from "./medline-source.js";
import { EgressGuard } from "../egress.js";

// ── Load committed fixture ───────────────────────────────────────────

const fixtureUrl = new URL("./__fixtures__/medlineplus-sample.json", import.meta.url);

async function loadFixture(): Promise<unknown> {
  const raw = await readFile(fixtureUrl, "utf-8");
  return JSON.parse(raw) as unknown;
}

// ── Helpers ──────────────────────────────────────────────────────────

function makeFakeFetch(body: unknown, ok = true, status = 200): FetchLike {
  return async () => ({
    ok,
    status,
    json: async () => body,
  });
}

function makeThrowingFetch(): FetchLike {
  return async () => {
    throw new Error("network down");
  };
}

// ── Tests ────────────────────────────────────────────────────────────

describe("MedlineSource — grounded retrieval from fixture (sc-7-5)", () => {
  it("axis ON + fixture response => grounded passages", async () => {
    const fixture = await loadFixture();
    const egress = new EgressGuard(false, true); // literature ON
    const fakeFetch = makeFakeFetch(fixture);
    const source = new MedlineSource(egress, fakeFetch);

    const outcome: RetrievalOutcome = await source.fetchPassages("metformin");

    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;

    expect(outcome.passages.length).toBeGreaterThanOrEqual(1);
    const first = outcome.passages[0];
    expect(typeof first?.title).toBe("string");
    expect(first?.title.length).toBeGreaterThan(0);
    expect(typeof first?.url).toBe("string");
    expect(first?.url.startsWith("https://")).toBe(true);
    expect(typeof first?.text).toBe("string");
    expect(first?.source).toBe("medlineplus");
  });

  it("fixture passages contain expected MedlinePlus content", async () => {
    const fixture = await loadFixture();
    const egress = new EgressGuard(false, true);
    const fakeFetch = makeFakeFetch(fixture);
    const source = new MedlineSource(egress, fakeFetch);

    const outcome = await source.fetchPassages("metformin");

    expect(outcome.kind).toBe("grounded");
    if (outcome.kind !== "grounded") return;

    const titles = outcome.passages.map((p) => p.title);
    expect(titles.some((t) => t.toLowerCase().includes("metformin") || t.toLowerCase().includes("diabetes"))).toBe(true);
  });
});

describe("MedlineSource — abstain paths (sc-7-7)", () => {
  it("network throws => abstain{source-error}", async () => {
    const egress = new EgressGuard(false, true);
    const source = new MedlineSource(egress, makeThrowingFetch());

    const outcome = await source.fetchPassages("metformin");

    expect(outcome).toEqual({ kind: "abstain", reason: "source-error" });
  });

  it("non-ok response (503) => abstain{source-error}", async () => {
    const egress = new EgressGuard(false, true);
    const fakeFetch = makeFakeFetch(null, false, 503);
    const source = new MedlineSource(egress, fakeFetch);

    const outcome = await source.fetchPassages("metformin");

    expect(outcome).toEqual({ kind: "abstain", reason: "source-error" });
  });

  it("empty document list => abstain{no-passages}", async () => {
    const emptyResponse = {
      nlmSearchResult: {
        list: {
          document: [],
        },
      },
    };
    const egress = new EgressGuard(false, true);
    const fakeFetch = makeFakeFetch(emptyResponse);
    const source = new MedlineSource(egress, fakeFetch);

    const outcome = await source.fetchPassages("unknownterm12345");

    expect(outcome).toEqual({ kind: "abstain", reason: "no-passages" });
  });

  it("malformed response (no nlmSearchResult) => abstain{no-passages}", async () => {
    const egress = new EgressGuard(false, true);
    const fakeFetch = makeFakeFetch({ unexpected: "shape" });
    const source = new MedlineSource(egress, fakeFetch);

    const outcome = await source.fetchPassages("metformin");

    expect(outcome).toEqual({ kind: "abstain", reason: "no-passages" });
  });

  it("axis OFF => assertAllowed throws => caught => abstain{source-error}", async () => {
    const egress = new EgressGuard(false, false); // literature OFF
    // fetchImpl should never be called when axis is off (assertAllowed throws first),
    // but we pass a throwing fetch to verify the catch path handles it either way.
    const source = new MedlineSource(egress, makeThrowingFetch());

    const outcome = await source.fetchPassages("metformin");

    // assertAllowed throws, which is caught and returns abstain{source-error}.
    expect(outcome).toEqual({ kind: "abstain", reason: "source-error" });
  });
});
