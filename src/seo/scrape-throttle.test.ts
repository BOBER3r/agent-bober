import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { fileExists } from "../utils/fs.js";
import { ScrapeThrottle } from "./scrape-throttle.js";
import type { ScrapeProxyLedger } from "./scrape-throttle.js";
import { SeoQuotaGovernor } from "./quota-governor.js";
import type { BoberConfig } from "../config/schema.js";

describe("ScrapeThrottle", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "scrape-throttle-"));
    ledgerPath = join(dir, "scrape-throttle-ledger.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // -- sc-9-1: rate-window grant/deny + window reset via injected clock ----

  describe("acquire() rate window + budget (sc-9-1)", () => {
    it("grants within the window and cap, denies once the cap is hit, resets across the boundary", async () => {
      let ms = 1_000_000;
      const clock = () => new Date(ms).toISOString(); // controllable ISO clock
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 2, windowMs: 60_000, maxProxyUsd: 1 }, clock);

      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true); // count 1
      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true); // count 2 (== cap)
      expect(await t.acquire("chatgpt-ui")).toEqual({ proceed: false, reason: "rate-window" });

      ms += 60_001; // cross the window boundary
      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true); // window reset -> granted

      // proxy-budget denial:
      await t.recordProxyCost("chatgpt-ui", 1); // spend hits the $1 cap
      ms += 60_001; // fresh window so rate isn't the blocker
      expect(await t.acquire("chatgpt-ui")).toEqual({ proceed: false, reason: "proxy-budget" });
    });

    it("a denied acquire does not advance the rate counter (Pattern G: no side effect on refuse)", async () => {
      let ms = 5_000_000;
      const clock = () => new Date(ms).toISOString();
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 1, windowMs: 60_000, maxProxyUsd: 100 }, clock);

      expect((await t.acquire("perplexity")).proceed).toBe(true); // count -> 1 (== cap)
      const before = await readFile(ledgerPath, "utf-8");

      const denied = await t.acquire("perplexity");
      expect(denied).toEqual({ proceed: false, reason: "rate-window" });

      const after = await readFile(ledgerPath, "utf-8");
      expect(after).toBe(before); // denied acquire wrote nothing
      const raw = JSON.parse(after) as ScrapeProxyLedger;
      expect(raw["perplexity"].count).toBe(1); // counter did not advance on refusal
    });

    it("distinct engines get independent rate windows", async () => {
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 1, windowMs: 60_000, maxProxyUsd: 100 });
      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true);
      expect(await t.acquire("chatgpt-ui")).toEqual({ proceed: false, reason: "rate-window" });
      // A different engine is unaffected by chatgpt-ui's saturated window.
      expect((await t.acquire("perplexity-ui")).proceed).toBe(true);
    });
  });

  // -- sc-9-2: concurrent recordProxyCost never loses an update -------------

  describe("recordProxyCost() atomic + concurrent-safe (sc-9-2)", () => {
    it("concurrent recordProxyCost calls never lose an update", async () => {
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 1e9, windowMs: 60_000, maxProxyUsd: 1e9 });
      await Promise.all(Array.from({ length: 100 }, () => t.recordProxyCost("chatgpt-ui", 1)));

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as ScrapeProxyLedger;
      expect(raw["chatgpt-ui"].proxyUsdSpent).toBe(100); // 100 x $1, zero lost updates

      const entries = await readdir(dir);
      expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false); // temp+rename left no litter
    });

    it("two throttle instances sharing a ledger path: interleaved recordProxyCost loses zero updates", async () => {
      const t1 = new ScrapeThrottle(ledgerPath, { maxPerWindow: 1e9, windowMs: 60_000, maxProxyUsd: 1e9 });
      const t2 = new ScrapeThrottle(ledgerPath, { maxPerWindow: 1e9, windowMs: 60_000, maxProxyUsd: 1e9 });

      await Promise.all([
        ...Array.from({ length: 50 }, () => t1.recordProxyCost("perplexity", 1)),
        ...Array.from({ length: 50 }, () => t2.recordProxyCost("perplexity", 1)),
      ]);

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as ScrapeProxyLedger;
      expect(raw["perplexity"].proxyUsdSpent).toBe(100);
    });

    it("guards NaN/negative/zero cost — never corrupts or reduces the running total", async () => {
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      await t.recordProxyCost("chatgpt-ui", 5);
      await t.recordProxyCost("chatgpt-ui", Number.NaN);
      await t.recordProxyCost("chatgpt-ui", -3);
      await t.recordProxyCost("chatgpt-ui", 0);

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as ScrapeProxyLedger;
      expect(raw["chatgpt-ui"].proxyUsdSpent).toBe(5); // bad values ignored
    });
  });

  // -- sc-9-3: corrupt ledger fails closed -----------------------------------

  describe("corrupt ledger fails closed (sc-9-3)", () => {
    it("existing-but-unparseable ledger => acquire denies, never grants past an unknown budget", async () => {
      await writeFile(ledgerPath, "{ this is not json", "utf-8");
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      const d = await t.acquire("chatgpt-ui");
      expect(d).toEqual({ proceed: false, reason: "proxy-budget" });
    });

    it("acquire does not overwrite the corrupt file (no side effect on refuse)", async () => {
      await writeFile(ledgerPath, "not json at all", "utf-8");
      const before = await readFile(ledgerPath, "utf-8");
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      await t.acquire("chatgpt-ui");
      const after = await readFile(ledgerPath, "utf-8");
      expect(after).toBe(before);
    });

    it("recordProxyCost() heals a corrupt ledger by overwriting from a fresh {} base", async () => {
      await writeFile(ledgerPath, "{ broken", "utf-8");
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      await t.recordProxyCost("chatgpt-ui", 2);

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as ScrapeProxyLedger;
      expect(raw["chatgpt-ui"].proxyUsdSpent).toBe(2); // healed

      // Ledger is no longer corrupt, so acquire can grant again (within caps).
      const t2 = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      expect((await t2.acquire("chatgpt-ui")).proceed).toBe(true);
    });

    it("missing ledger (first run) is NOT corrupt — acquire grants", async () => {
      expect(await fileExists(ledgerPath)).toBe(false);
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true);
    });
  });

  // -- sc-9-4: independence from the governor USD ledger ---------------------

  describe("independent from the governor USD ledger (sc-9-4)", () => {
    it("proxy spend is invisible to the governor USD ceiling; throttle never writes the governor's ledger", async () => {
      const govPath = join(dir, "quota-ledger.json"); // DISTINCT path
      const g = await SeoQuotaGovernor.load(govPath, { seo: { budget: { maxUsd: 10 } } } as BoberConfig);
      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });

      await t.recordProxyCost("chatgpt-ui", 50); // huge proxy spend, well past the governor's $10 cap
      expect(g.spentUsd()).toBe(0); // governor USD ceiling untouched
      expect(await fileExists(govPath)).toBe(false); // throttle never wrote the governor ledger

      // Governor admits are unaffected by throttle activity.
      expect(g.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 5 })).toEqual({ admit: true });
    });

    it("a corrupt governor ledger does not affect throttle acquire, and vice versa", async () => {
      const govPath = join(dir, "quota-ledger.json");
      await writeFile(govPath, "{ not json", "utf-8");
      const g = await SeoQuotaGovernor.load(govPath, { seo: { budget: { maxUsd: 10 } } } as BoberConfig);
      expect(g.spentUsd()).toBe(Number.POSITIVE_INFINITY); // governor fails closed on its own corruption

      const t = new ScrapeThrottle(ledgerPath, { maxPerWindow: 5, windowMs: 60_000, maxProxyUsd: 100 });
      expect((await t.acquire("chatgpt-ui")).proceed).toBe(true); // throttle's own (fresh) ledger is unaffected
    });
  });
});
