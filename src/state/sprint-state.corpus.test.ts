import { mkdtemp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { describe, expect, it } from "vitest";

import { isSettledContractStatus } from "../contracts/sprint-contract.js";
import { listContracts, listContractsWithSkips } from "./sprint-state.js";

/**
 * Pins the gap this change closes: `listContracts` skipped any file failing
 * `SprintContractSchema` and said nothing, so every reader that goes through
 * it — `bober_sprint`, `bober_eval`, `bober_contracts`, `cli/commands/sprint`,
 * `cli/commands/eval`, `memory`, `conformance`, `resume-cursor` — reported a
 * corpus smaller than the one on disk with no signal that anything was
 * missing. On this repository the difference was 52 files, 44 of them settled.
 *
 * The assertions below are DELIBERATELY self-adjusting: none hardcodes 52 or
 * 44. They require the two halves to ACCOUNT FOR every `.json` file in
 * `.bober/contracts/`, so the invariant keeps holding as files are added, and
 * so it cannot be satisfied by quietly dropping a file from both halves.
 */

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");

async function contractFileCount(): Promise<number> {
  const entries = await readdir(join(REPO_ROOT, ".bober", "contracts"));
  return entries.filter((f) => f.endsWith(".json")).length;
}

describe("listContractsWithSkips against the real committed corpus", () => {
  it("accounts for every contract file on disk — nothing is silently dropped", async () => {
    const { contracts, skipped } = await listContractsWithSkips(REPO_ROOT);
    const onDisk = await contractFileCount();

    // Liveness: an empty corpus would make this vacuous.
    expect(onDisk).toBeGreaterThan(0);

    // THE invariant. Every file is either returned or reported as skipped.
    expect(contracts.length + skipped.length).toBe(onDisk);
  });

  it("still has unreadable files — the gap this reports is real, not theoretical", async () => {
    const { contracts, skipped } = await listContractsWithSkips(REPO_ROOT);

    // If this ever goes to zero because the corpus was migrated, that is good
    // news and this expectation should be relaxed — but it must not go to zero
    // because the reporting was removed, which the invariant above would catch.
    expect(skipped.length).toBeGreaterThan(0);
    expect(contracts.length).toBeGreaterThan(skipped.length);
  });

  it("gives every skipped file a name and a usable reason", async () => {
    const { skipped } = await listContractsWithSkips(REPO_ROOT);

    for (const entry of skipped) {
      expect(entry.file).toMatch(/\.json$/);
      expect(entry.reason.length).toBeGreaterThan(0);
      // A reason a human can act on: which check failed, not just "invalid".
      expect(entry.reason).toMatch(
        /failed schema validation|invalid JSON|unreadable/,
      );
    }
  });

  it("explains the whole settled shortfall — every missing settled sprint is a reported skip", async () => {
    const { contracts, skipped } = await listContractsWithSkips(REPO_ROOT);
    const settledReturned = contracts.filter((c) =>
      isSettledContractStatus(c.status),
    ).length;

    // Independently recount from the raw files what "settled" would be if
    // every file parsed — deliberately NOT via the schema, since the point is
    // to see the files the schema rejects.
    const dir = join(REPO_ROOT, ".bober", "contracts");
    const names = (await readdir(dir)).filter((f) => f.endsWith(".json"));
    let settledOnDisk = 0;
    const skippedNames = new Set(skipped.map((s) => s.file));
    let settledAmongSkipped = 0;
    for (const name of names) {
      const raw: unknown = JSON.parse(await readFile(join(dir, name), "utf-8"));
      const status = (raw as { status?: unknown }).status;
      if (status !== "passed" && status !== "completed") continue;
      settledOnDisk++;
      if (skippedNames.has(name)) settledAmongSkipped++;
    }

    // Liveness: the shortfall is real right now.
    expect(settledOnDisk).toBeGreaterThan(settledReturned);

    // THE accounting. Every settled sprint the readers cannot see is a file
    // this function names — none is unaccounted for.
    expect(settledOnDisk - settledReturned).toBe(settledAmongSkipped);
  });

  it("listContracts is exactly the contracts half — no behaviour change for its callers", async () => {
    const [plain, listing] = await Promise.all([
      listContracts(REPO_ROOT),
      listContractsWithSkips(REPO_ROOT),
    ]);

    expect(plain.map((c) => c.contractId)).toEqual(
      listing.contracts.map((c) => c.contractId),
    );
  });
});

// ── Controls on a corpus this test owns ─────────────────────────────

describe("listContractsWithSkips on a synthetic directory", () => {
  async function fixture(
    files: Record<string, string>,
  ): Promise<string> {
    const root = await mkdtemp(join(tmpdir(), "bober-contracts-"));
    const dir = join(root, ".bober", "contracts");
    await mkdir(dir, { recursive: true });
    for (const [name, body] of Object.entries(files)) {
      await writeFile(join(dir, name), body, "utf-8");
    }
    return root;
  }

  const VALID = JSON.stringify({
    contractId: "sprint-ok-1",
    specId: "spec-ok",
    sprintNumber: 1,
    title: "A valid contract",
    description: "Valid enough to parse.",
    status: "completed",
    successCriteria: [
      {
        criterionId: "sc-1-1",
        description:
          "A criterion long enough to clear the schema's minimum description length.",
        verificationMethod: "unit-test",
        required: true,
      },
    ],
    nonGoals: ["Nothing else"],
    stopConditions: ["The criterion passes"],
    definitionOfDone: "Done when the single criterion passes evaluation.",
  });

  it("separates parseable from unparseable and explains each skip", async () => {
    const root = await fixture({
      "a-valid.json": VALID,
      "b-bad-json.json": "{ this is not json",
      "c-bad-schema.json": JSON.stringify({ contractId: "x", specId: "y" }),
      "d-ignored.txt": "not a contract",
    });

    const { contracts, skipped } = await listContractsWithSkips(root);

    expect(contracts.map((c) => c.contractId)).toEqual(["sprint-ok-1"]);
    expect(skipped.map((s) => s.file)).toEqual([
      "b-bad-json.json",
      "c-bad-schema.json",
    ]);
    expect(skipped[0].reason).toContain("invalid JSON");
    // The reason names the failing paths, so a human can fix the file.
    expect(skipped[1].reason).toContain("failed schema validation");
    expect(skipped[1].reason).toContain("sprintNumber");
  });

  it("reports no skips for a directory that is entirely valid", async () => {
    const root = await fixture({ "a-valid.json": VALID });
    const { contracts, skipped } = await listContractsWithSkips(root);

    expect(contracts).toHaveLength(1);
    expect(skipped).toEqual([]);
  });

  it("returns both halves empty when the directory does not exist", async () => {
    const root = await mkdtemp(join(tmpdir(), "bober-empty-"));
    await expect(listContractsWithSkips(root)).resolves.toEqual({
      contracts: [],
      skipped: [],
    });
  });
});
