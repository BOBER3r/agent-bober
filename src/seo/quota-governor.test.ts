import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SeoQuotaGovernor } from "./quota-governor.js";
import type { QuotaRequest } from "./quota-governor.js";
import type { SeoQuotaLedger } from "./types.js";
import type { BoberConfig } from "../config/schema.js";
import { fileExists } from "../utils/fs.js";

const TODAY = new Date().toISOString().slice(0, 10);

function cfg(maxUsd: number | null): BoberConfig {
  return { seo: { budget: { maxUsd } } } as BoberConfig;
}

async function seedLedger(path: string, ledger: SeoQuotaLedger): Promise<void> {
  await writeFile(path, JSON.stringify(ledger, null, 2) + "\n", "utf-8");
}

describe("SeoQuotaGovernor", () => {
  let dir: string;
  let ledgerPath: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "seo-quota-"));
    ledgerPath = join(dir, "quota-ledger.json");
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  // ── sc-7-1: admit() never throws; a refused request has no side effect ──

  describe("admit() never throws; refused ⇒ no side effect (sc-7-1)", () => {
    it("budget-exceeded: refuses, does not throw, does not create the ledger", async () => {
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(1));
      let decision;
      expect(() => {
        decision = g.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 5 });
      }).not.toThrow();
      expect(decision).toEqual({ admit: false, reason: "budget-exceeded" });
      expect(await fileExists(ledgerPath)).toBe(false);
      expect(g.spentUsd()).toBe(0); // no side effect: spend unchanged after a refused admit
    });

    it("daily-rows: pre-seeded at-cap ledger refuses without mutating the file", async () => {
      const ledger: SeoQuotaLedger = {
        [TODAY]: {
          spentUsd: 0,
          scopes: { "https://site.example|": { rowsToday: 50_000, urlInspectionsToday: 0 } },
        },
      };
      await seedLedger(ledgerPath, ledger);
      const before = await readFile(ledgerPath, "utf-8");

      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      const decision = g.admit({
        source: "gsc",
        capability: "search-analytics",
        scope: { siteUrl: "https://site.example" },
        estRows: 1,
        estCostUsd: 0,
      });
      expect(decision).toEqual({ admit: false, reason: "daily-rows" });

      const after = await readFile(ledgerPath, "utf-8");
      expect(after).toBe(before); // admit() never writes
    });

    it("url-inspection-cap: pre-seeded at-cap ledger refuses without mutating the file", async () => {
      const ledger: SeoQuotaLedger = {
        [TODAY]: {
          spentUsd: 0,
          scopes: { "https://site.example|": { rowsToday: 0, urlInspectionsToday: 2_000 } },
        },
      };
      await seedLedger(ledgerPath, ledger);
      const before = await readFile(ledgerPath, "utf-8");

      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      const decision = g.admit({
        source: "gsc",
        capability: "url-inspection",
        scope: { siteUrl: "https://site.example" },
        estRows: 1,
        estCostUsd: 0,
      });
      expect(decision).toEqual({ admit: false, reason: "url-inspection-cap" });

      const after = await readFile(ledgerPath, "utf-8");
      expect(after).toBe(before);
    });

    it(
      "rate-window: exhausting the URL-Inspection QPM window refuses the next call",
      async () => {
        const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
        const req: QuotaRequest = {
          source: "gsc",
          capability: "url-inspection",
          scope: { siteUrl: "https://site.example" },
          estRows: 0,
          estCostUsd: 0,
        };
        // Each record() advances the in-memory window synchronously (before its
        // first `await`), so by the time Array.from finishes constructing the
        // 600 promises, the window is already saturated — the trailing
        // `Promise.all` just drains the queued, mutex-serialized disk writes.
        const pending = Array.from({ length: 600 }, () => g.record(req, 0));
        const decision = g.admit(req);
        expect(decision).toEqual({ admit: false, reason: "rate-window" });
        await Promise.all(pending);
      },
      20_000,
    );
  });

  // ── sc-7-2: GSC caps per-site AND per-user separately + budget ──────────

  describe("GSC caps modeled per-site AND per-user separately; budget independent (sc-7-2)", () => {
    it(
      "saturating one site's window (many users) blocks a NEW user on that site, but not an unrelated site/user pair",
      async () => {
        const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
        const site = "https://busy-site.example";
        const pending = Array.from({ length: 1_200 }, (_, i) =>
          g.record(
            {
              source: "gsc",
              capability: "search-analytics",
              scope: { siteUrl: site, userId: `user-${i}` },
              estRows: 0,
              estCostUsd: 0,
            },
            0,
          ),
        );

        // Site-level cap (1,200 QPM) is now saturated regardless of which user calls next.
        const blocked = g.admit({
          source: "gsc",
          capability: "search-analytics",
          scope: { siteUrl: site, userId: "brand-new-user" },
          estRows: 0,
          estCostUsd: 0,
        });
        expect(blocked).toEqual({ admit: false, reason: "rate-window" });

        // A different site, with a user who made only ONE call on the busy site
        // (well under their own 1,200/min ceiling), is unaffected by the busy
        // site's saturation — proving the per-site window is independent of
        // the per-user window.
        const allowed = g.admit({
          source: "gsc",
          capability: "search-analytics",
          scope: { siteUrl: "https://quiet-site.example", userId: "user-500" },
          estRows: 0,
          estCostUsd: 0,
        });
        expect(allowed).toEqual({ admit: true });

        await Promise.all(pending);
      },
      20_000,
    );

    it(
      "saturating one user's window (many sites) blocks that user on a brand-new site",
      async () => {
        const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
        const user = "heavy-user";
        const pending = Array.from({ length: 1_200 }, (_, i) =>
          g.record(
            {
              source: "gsc",
              capability: "search-analytics",
              scope: { siteUrl: `https://site-${i}.example`, userId: user },
              estRows: 0,
              estCostUsd: 0,
            },
            0,
          ),
        );

        const blocked = g.admit({
          source: "gsc",
          capability: "search-analytics",
          scope: { siteUrl: "https://brand-new-site.example", userId: user },
          estRows: 0,
          estCostUsd: 0,
        });
        expect(blocked).toEqual({ admit: false, reason: "rate-window" });

        await Promise.all(pending);
      },
      20_000,
    );

    it("budget-exceeded trips independently of GSC caps; null maxUsd is uncapped", async () => {
      const capped = await SeoQuotaGovernor.load(ledgerPath, cfg(10));
      expect(capped.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 10.01 }).admit).toBe(false);
      expect(capped.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 10 }).admit).toBe(true);

      const uncapped = await SeoQuotaGovernor.load(join(dir, "uncapped-ledger.json"), cfg(null));
      expect(uncapped.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 1_000_000 }).admit).toBe(true);
    });

    it("gsc requests default to search-analytics capability when omitted", async () => {
      const ledger: SeoQuotaLedger = {
        [TODAY]: {
          spentUsd: 0,
          scopes: { "https://site.example|": { rowsToday: 50_000, urlInspectionsToday: 0 } },
        },
      };
      await seedLedger(ledgerPath, ledger);
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      const decision = g.admit({ source: "gsc", scope: { siteUrl: "https://site.example" }, estRows: 1, estCostUsd: 0 });
      expect(decision).toEqual({ admit: false, reason: "daily-rows" });
    });
  });

  // ── sc-7-3: atomic, concurrent-safe persistence ──────────────────────────

  describe("record() persists atomically; no lost update under concurrency (sc-7-3)", () => {
    it("single record() writes via temp+rename (no leftover .tmp files) and persists spend", async () => {
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      await g.record({ source: "dataforseo", scope: { siteUrl: "s", userId: "u" }, estRows: 0, estCostUsd: 2.5 }, 2.5);

      expect(await fileExists(ledgerPath)).toBe(true);
      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as SeoQuotaLedger;
      expect(raw[TODAY]?.spentUsd).toBe(2.5);

      const entries = await readdir(dir);
      expect(entries.some((f) => f.endsWith(".tmp"))).toBe(false);
      expect(g.spentUsd()).toBe(2.5);
    });

    it("two governors sharing a ledger path: interleaved record() loses zero updates", async () => {
      const g1 = await SeoQuotaGovernor.load(ledgerPath, cfg(1000));
      const g2 = await SeoQuotaGovernor.load(ledgerPath, cfg(1000));
      const req: QuotaRequest = { source: "dataforseo", scope: { siteUrl: "s", userId: "u" }, estRows: 0, estCostUsd: 0 };

      await Promise.all([
        ...Array.from({ length: 50 }, () => g1.record(req, 1)),
        ...Array.from({ length: 50 }, () => g2.record(req, 1)),
      ]);

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as SeoQuotaLedger;
      const total = Object.values(raw).reduce((sum, day) => sum + day.spentUsd, 0);
      expect(total).toBe(100); // 100 records × $1 — zero lost updates
    });
  });

  // ── sc-7-4: corrupt ledger fails closed ──────────────────────────────────

  describe("corrupt ledger fails closed (sc-7-4)", () => {
    it("existing-but-unparseable ledger => costed admit refused", async () => {
      await writeFile(ledgerPath, "{ this is not json", "utf-8");
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(1000));
      const decision = g.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 0.01 });
      expect(decision.admit).toBe(false);
      expect(g.spentUsd()).toBe(Number.POSITIVE_INFINITY);
    });

    it("corrupt ledger also trips GSC daily-rows / url-inspection-cap (fail-closed, not just budget)", async () => {
      await writeFile(ledgerPath, "not json at all", "utf-8");
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      expect(
        g.admit({ source: "gsc", capability: "search-analytics", scope: { siteUrl: "s" }, estRows: 1, estCostUsd: 0 })
          .admit,
      ).toBe(false);
      expect(
        g.admit({ source: "gsc", capability: "url-inspection", scope: { siteUrl: "s" }, estRows: 1, estCostUsd: 0 })
          .admit,
      ).toBe(false);
    });

    it("record() heals a corrupt ledger by overwriting from a fresh {} base", async () => {
      await writeFile(ledgerPath, "{ broken", "utf-8");
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(1000));
      await g.record({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 1 }, 1);

      const raw = JSON.parse(await readFile(ledgerPath, "utf-8")) as SeoQuotaLedger;
      expect(raw[TODAY]?.spentUsd).toBe(1);
      expect(g.spentUsd()).toBe(1); // healed: no longer at-ceiling
    });
  });

  // ── Offline path never touches the ledger ───────────────────────────────

  describe("offline-only runs never create the ledger", () => {
    it("construction + admit()-only usage issues zero record() calls and never creates the file", async () => {
      const g = await SeoQuotaGovernor.load(ledgerPath, cfg(null));
      g.admit({
        source: "gsc",
        capability: "search-analytics",
        scope: { siteUrl: "s" },
        estRows: 100,
        estCostUsd: 0,
      });
      g.admit({ source: "dataforseo", scope: {}, estRows: 0, estCostUsd: 0.5 });
      g.admit({
        source: "gsc",
        capability: "url-inspection",
        scope: { siteUrl: "s" },
        estRows: 1,
        estCostUsd: 0,
      });
      expect(await fileExists(ledgerPath)).toBe(false);
    });
  });
});
