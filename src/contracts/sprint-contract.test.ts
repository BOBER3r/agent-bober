import { describe, it, expect, afterEach } from "vitest";

import {
  SprintContractSchema,
  ContractStatusSchema,
  createContract,
  updateContractStatus,
  isSettledContractStatus,
  isTerminalContractStatus,
  SETTLED_CONTRACT_STATUSES,
  TERMINAL_CONTRACT_STATUSES,
  findPrecisionIssues,
  isContractPrecise,
  MIN_CRITERION_DESCRIPTION_LENGTH,
  MIN_DEFINITION_OF_DONE_LENGTH,
  type SprintContract,
  type ContractStatus,
} from "./sprint-contract.js";

// ── corpus guard (sc-2-2 / sc-2-3 / sc-2-4) ─────────────────────────
// Extra imports for the real-corpus status guard below. Kept separate from
// the pure in-memory imports above so the existing unit tests stay
// untouched — see sprint-spec-20260812-terminal-vocabulary-2's briefing §1
// for why this reads .bober/contracts/ at run time instead of going through
// `listContracts` (which silently drops schema-invalid files, the very
// files this guard exists to catch) or validating the whole file against
// `SprintContractSchema` (60 of 256 committed contracts fail that for
// reasons unrelated to `status` — see the same briefing §1.3).
import { copyFile, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadContract, saveContract } from "../state/sprint-state.js";

// A reusable, schema-valid contract for tests that need a known-good base.
function validContract(overrides: Partial<SprintContract> = {}): SprintContract {
  return {
    contractId: "sprint-test-1",
    specId: "spec-test",
    sprintNumber: 1,
    title: "Add login form",
    description:
      "Wire a login form to /api/auth/login and redirect to /dashboard on 200.",
    status: "proposed",
    dependsOn: [],
    features: ["feat-login"],
    successCriteria: [
      {
        criterionId: "sc-1-1",
        description:
          "Submitting valid credentials posts to /api/auth/login and stores the JWT in an httpOnly cookie.",
        verificationMethod: "playwright",
        required: true,
      },
    ],
    nonGoals: ["No password reset flow in this sprint"],
    stopConditions: ["E2E login test passes against the staging API"],
    definitionOfDone:
      "A user with valid credentials can log in and be redirected to /dashboard, with the JWT set as an httpOnly cookie.",
    assumptions: [],
    outOfScope: [],
    estimatedFiles: ["src/components/Login.tsx"],
    iterationHistory: [],
    lastEvalId: null,
    ...overrides,
  };
}

describe("SprintContractSchema", () => {
  it("accepts a fully populated contract", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
  });

  it("rejects criterion description shorter than minimum", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description: "works",
          verificationMethod: "manual",
          required: true,
        },
      ],
    });
    const result = SprintContractSchema.safeParse(c);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(
        result.error.issues.some((i) =>
          i.path.join(".").includes("successCriteria"),
        ),
      ).toBe(true);
    }
    // sanity-check the threshold itself
    expect(MIN_CRITERION_DESCRIPTION_LENGTH).toBeGreaterThan(5);
  });

  it("rejects empty successCriteria", () => {
    const c = validContract({ successCriteria: [] });
    const result = SprintContractSchema.safeParse(c);
    expect(result.success).toBe(false);
  });

  it("rejects empty nonGoals", () => {
    const c = validContract({ nonGoals: [] });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects empty stopConditions", () => {
    const c = validContract({ stopConditions: [] });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects definitionOfDone shorter than minimum", () => {
    const c = validContract({ definitionOfDone: "done" });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
    expect(MIN_DEFINITION_OF_DONE_LENGTH).toBeGreaterThan(5);
  });

  it("rejects free-form verificationMethod values", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description:
            "Submitting valid credentials posts to /api/auth/login successfully.",
          // @ts-expect-error — exercising runtime rejection of invalid enum value
          verificationMethod: "vibes",
          required: true,
        },
      ],
    });
    expect(SprintContractSchema.safeParse(c).success).toBe(false);
  });

  it("rejects ambiguityScore outside 0..10", () => {
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: -1 }))
        .success,
    ).toBe(false);
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: 11 }))
        .success,
    ).toBe(false);
    expect(
      SprintContractSchema.safeParse(validContract({ ambiguityScore: 5 }))
        .success,
    ).toBe(true);
  });
});

describe("createContract", () => {
  it("produces a schema-valid contract with placeholder precision fields", () => {
    const contract = createContract(
      "Add login form",
      "Wire login form to /api/auth/login.",
      [
        {
          criterionId: "sc-1",
          description:
            "Submitting valid credentials posts to /api/auth/login.",
          verificationMethod: "playwright",
        },
      ],
      { specId: "spec-x", sprintNumber: 2, features: ["feat-login"] },
    );

    const result = SprintContractSchema.safeParse(contract);
    expect(result.success).toBe(true);

    expect(contract.specId).toBe("spec-x");
    expect(contract.sprintNumber).toBe(2);
    expect(contract.status).toBe("proposed");
    expect(contract.successCriteria[0].required).toBe(true);
    expect(contract.nonGoals[0]).toMatch(/Auto-generated/);
  });
});

describe("updateContractStatus", () => {
  it("sets startedAt when entering in-progress", () => {
    const contract = validContract();
    expect(contract.startedAt).toBeUndefined();
    const next = updateContractStatus(contract, "in-progress");
    expect(next.status).toBe("in-progress");
    expect(next.startedAt).toBeTruthy();
  });

  it("sets completedAt for terminal statuses", () => {
    const contract = validContract();
    for (const status of ["passed", "failed", "completed"] as const) {
      const next = updateContractStatus(contract, status);
      expect(next.status).toBe(status);
      expect(next.completedAt).toBeTruthy();
    }
  });

  it("does not overwrite existing startedAt", () => {
    const original = "2026-04-15T10:00:00.000Z";
    const contract = validContract({ startedAt: original });
    const next = updateContractStatus(contract, "in-progress");
    expect(next.startedAt).toBe(original);
  });

  it("agrees with isTerminalContractStatus for every status (so :216-219 cannot drift back)", () => {
    // Pins the coupling between updateContractStatus's completedAt-stamping
    // rule and the exported predicate — the whole point of generalising the
    // inline rule into isTerminalContractStatus. If the two ever diverge,
    // this is the test that fails.
    for (const status of ContractStatusSchema.options) {
      const contract = validContract();
      const next = updateContractStatus(contract, status);
      expect(Boolean(next.completedAt)).toBe(isTerminalContractStatus(status));
    }
  });
});

describe("isSettledContractStatus / isTerminalContractStatus", () => {
  // The exact partition of ALL NINE ContractStatusSchema members, so adding a
  // tenth status to the enum without deciding where it belongs fails this
  // test loudly rather than silently defaulting to "not settled".
  const EXPECTED_SETTLED = new Set<ContractStatus>(["passed", "completed"]);
  const EXPECTED_TERMINAL = new Set<ContractStatus>(["passed", "failed", "completed"]);

  it("SETTLED_CONTRACT_STATUSES is exactly {passed, completed}", () => {
    expect(new Set(SETTLED_CONTRACT_STATUSES)).toEqual(EXPECTED_SETTLED);
  });

  it("TERMINAL_CONTRACT_STATUSES is exactly {passed, failed, completed}", () => {
    expect(new Set(TERMINAL_CONTRACT_STATUSES)).toEqual(EXPECTED_TERMINAL);
  });

  it("TERMINAL_CONTRACT_STATUSES is a strict superset of SETTLED_CONTRACT_STATUSES", () => {
    // The two sets are built one from the other in the source (adds
    // "failed") specifically so they cannot silently diverge. Assert that
    // relationship directly, not just the two memberships independently.
    for (const s of SETTLED_CONTRACT_STATUSES) {
      expect(TERMINAL_CONTRACT_STATUSES.has(s)).toBe(true);
    }
    expect(TERMINAL_CONTRACT_STATUSES.size).toBe(SETTLED_CONTRACT_STATUSES.size + 1);
  });

  it("partitions every member of ContractStatusSchema exactly as expected", () => {
    expect(ContractStatusSchema.options.length).toBe(9); // liveness: the enum still has 9 members
    for (const status of ContractStatusSchema.options) {
      expect(isSettledContractStatus(status)).toBe(EXPECTED_SETTLED.has(status));
      expect(isTerminalContractStatus(status)).toBe(EXPECTED_TERMINAL.has(status));
    }
  });

  it("isSettledContractStatus excludes 'failed' (a failed sprint is over, not settled-good)", () => {
    expect(isSettledContractStatus("failed")).toBe(false);
    expect(isTerminalContractStatus("failed")).toBe(true);
  });

  it("every settled status is also terminal, but not vice versa", () => {
    for (const status of ContractStatusSchema.options) {
      if (isSettledContractStatus(status)) {
        expect(isTerminalContractStatus(status)).toBe(true);
      }
    }
    // "failed" is the witness that the converse does not hold.
    expect(isTerminalContractStatus("failed") && !isSettledContractStatus("failed")).toBe(true);
  });
});

describe("findPrecisionIssues", () => {
  it("returns no issues for a clean contract", () => {
    expect(findPrecisionIssues(validContract())).toEqual([]);
  });

  it("flags banned vague phrases in criterion descriptions", () => {
    const c = validContract({
      successCriteria: [
        {
          criterionId: "sc-1-1",
          description: "The login form works correctly when submitted.",
          verificationMethod: "manual",
          required: true,
        },
      ],
    });
    const issues = findPrecisionIssues(c);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues[0].field).toContain("successCriteria");
    expect(issues[0].message).toContain('"works correctly"');
  });

  it("flags vague phrases in definitionOfDone", () => {
    const c = validContract({
      definitionOfDone: "The feature looks good and behaves properly.",
    });
    const issues = findPrecisionIssues(c);
    // Two banned phrases in one string => two issues
    expect(issues.length).toBe(2);
    expect(issues.every((i) => i.field === "definitionOfDone")).toBe(true);
  });
});

describe("isContractPrecise", () => {
  it("returns true for a properly authored contract", () => {
    expect(isContractPrecise(validContract())).toBe(true);
  });

  it("returns false for placeholder auto-generated contracts", () => {
    const auto = createContract(
      "Stub",
      "Stub feature",
      [
        {
          criterionId: "sc-1",
          description:
            "The endpoint returns the expected JSON shape on a 200 response.",
          verificationMethod: "api-check",
        },
      ],
    );
    expect(isContractPrecise(auto)).toBe(false);
  });

  it("returns false when ambiguityScore >= 7", () => {
    expect(isContractPrecise(validContract({ ambiguityScore: 7 }))).toBe(false);
    expect(isContractPrecise(validContract({ ambiguityScore: 6 }))).toBe(true);
  });

  it("returns false when banned phrases are present", () => {
    const c = validContract({
      definitionOfDone:
        "The dashboard works correctly and renders the right widgets.",
    });
    expect(isContractPrecise(c)).toBe(false);
  });
});

// ── corpus guard (sc-2-2 / sc-2-3 / sc-2-4) ─────────────────────────
//
// Reads every committed contract in `.bober/contracts/` at run time and
// asserts its `status` field alone parses against `ContractStatusSchema` —
// deliberately NOT the whole-contract `SprintContractSchema`. 60 of the
// corpus's 256 committed files fail the whole schema for reasons unrelated
// to `status` (legacy `successCriteria` shape, missing `nonGoals` /
// `stopConditions` / `definitionOfDone`, etc.); a whole-schema test would
// fail on all 60 and could only be made green by rewriting fields this
// sprint's nonGoals forbid touching. sc-2-2's own wording asks only that
// "its status parses against ContractStatusSchema" — read literally.

const REPO_ROOT = fileURLToPath(new URL("../../", import.meta.url));
const CONTRACTS_DIR = join(REPO_ROOT, ".bober", "contracts");

interface ContractStatusEntry {
  /** File name only (not a full path) — enough to identify the offender. */
  file: string;
  status: unknown;
}

/**
 * Pure — takes in-memory {file, status} entries, never touches disk. This is
 * what the in-memory mutation-control test below drives directly with
 * synthetic entries, so "the guard bites" is proven without depending on
 * filesystem state at all (the same rationale as
 * status-vocabulary.invariant.test.ts's findOffenders split).
 */
function findIllegalStatuses(entries: ContractStatusEntry[]): string[] {
  const offenders: string[] = [];
  for (const entry of entries) {
    if (!ContractStatusSchema.safeParse(entry.status).success) {
      offenders.push(`${entry.file}: ${JSON.stringify(entry.status)}`);
    }
  }
  return offenders;
}

/** Reads {file, status} for every *.json contract in `dir`, at run time. */
async function readContractStatusEntries(dir: string): Promise<ContractStatusEntry[]> {
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json"));
  const entries: ContractStatusEntry[] = [];
  for (const file of files) {
    const raw = await readFile(join(dir, file), "utf-8");
    const parsed = JSON.parse(raw) as { status?: unknown };
    entries.push({ file, status: parsed.status });
  }
  return entries;
}

describe("every committed contract's status is a legal ContractStatusSchema member (sc-2-2)", () => {
  it("the walk actually happens against the real corpus (liveness — today it is 256 files)", async () => {
    // Not hardcoded to 256: a `toBeGreaterThan` threshold so a newly added
    // contract (sc-2-4's whole point) does not force an edit here.
    const entries = await readContractStatusEntries(CONTRACTS_DIR);
    expect(entries.length).toBeGreaterThan(200);
  });

  it("no committed contract carries a status outside ContractStatusSchema", async () => {
    const entries = await readContractStatusEntries(CONTRACTS_DIR);
    expect(findIllegalStatuses(entries)).toEqual([]);
  });

  // ── Mutation control: proves the guard actually fires (sc-2-3) ──────

  it("bites: a synthetic illegal status is reported (in-memory, no disk involved)", () => {
    const entries: ContractStatusEntry[] = [
      { file: "sprint-fake-1.json", status: "pending" },
      { file: "sprint-fake-2.json", status: "completed" },
    ];
    expect(findIllegalStatuses(entries)).toEqual(['sprint-fake-1.json: "pending"']);
  });

  it("does not bite on any legal ContractStatusSchema member", () => {
    const entries: ContractStatusEntry[] = ContractStatusSchema.options.map((status, i) => ({
      file: `sprint-fake-${i}.json`,
      status,
    }));
    expect(findIllegalStatuses(entries)).toEqual([]);
  });

  describe("mutation control: an illegal status introduced in a temp copy of the real corpus (sc-2-3, sc-2-4)", () => {
    // A writable copy under os.tmpdir(), never the committed corpus. A
    // crashed run leaves nothing behind under .bober/ — same rationale as
    // src/pge/golden/dataset.test.ts's copyDataset().
    const tempDirs: string[] = [];

    afterEach(async () => {
      while (tempDirs.length > 0) {
        const dir = tempDirs.pop();
        if (dir !== undefined) await rm(dir, { recursive: true, force: true });
      }
    });

    it("the directory-reading scan reports exactly the one file whose status was rewritten", async () => {
      const dir = await mkdtemp(join(tmpdir(), "contracts-status-"));
      tempDirs.push(dir);

      const files = (await readdir(CONTRACTS_DIR)).filter((f) => f.endsWith(".json"));
      for (const file of files) await copyFile(join(CONTRACTS_DIR, file), join(dir, file));

      // Confirm the committed corpus starts clean under this same scan
      // before mutating, so the failure below is attributable to the
      // mutation and not to a pre-existing offender.
      expect(findIllegalStatuses(await readContractStatusEntries(dir))).toEqual([]);

      const target = files[0];
      const draft = JSON.parse(await readFile(join(dir, target), "utf-8")) as Record<
        string,
        unknown
      >;
      draft.status = "pending";
      await writeFile(join(dir, target), JSON.stringify(draft), "utf-8");

      const entries = await readContractStatusEntries(dir);
      expect(findIllegalStatuses(entries)).toEqual([`${target}: "pending"`]);

      // The committed corpus itself is untouched by this test.
      const committedEntries = await readContractStatusEntries(CONTRACTS_DIR);
      expect(findIllegalStatuses(committedEntries)).toEqual([]);
    });
  });
});

// ── SprintContractSchema.version (sc-3-1) ───────────────────────────
//
// `version` is optional, never defaulted (see the field's JSDoc in
// sprint-contract.ts and versionRank at src/pge/registry/reducers.ts:366-393).
// A `.default(...)` would stamp a value onto every contract that lacks one —
// including all ~250 committed contracts and the seeded copy `sprint_exit`
// must outrank — so the anti-default assertion below is the load-bearing one.

describe("SprintContractSchema.version (sc-3-1)", () => {
  it("accepts a contract with no version field, so committed contracts stay valid without migration", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
  });

  it("leaves version genuinely ABSENT — not defaulted to 0 or any other value", () => {
    const result = SprintContractSchema.safeParse(validContract());
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBeUndefined();
      expect("version" in result.data).toBe(false);
    }
  });

  it("accepts an explicit version and preserves the exact value", () => {
    const result = SprintContractSchema.safeParse(validContract({ version: 3 }));
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.version).toBe(3);
    }
  });

  it("rejects a negative or non-integer version", () => {
    expect(SprintContractSchema.safeParse(validContract({ version: -1 })).success).toBe(false);
    expect(SprintContractSchema.safeParse(validContract({ version: 1.5 })).success).toBe(false);
  });
});

// ── version round-trip through saveContract -> loadContract (sc-3-5) ─
//
// `saveContract` serialises the CALLER'S object verbatim (sprint-state.ts:63), while
// `loadContract` returns `SprintContractSchema.safeParse(...).data` — a plain `z.object`,
// which strips undeclared keys (zod 3.25.76 default "strip" mode, no `.strict()` or
// `.passthrough()` anywhere on SprintContractSchema). That asymmetry is exactly why
// `version` had to become a DECLARED schema field rather than an unknown key riding along:
// an undeclared key survives the write and vanishes on the very next read.

describe("version round-trip through saveContract -> loadContract (sc-3-5)", () => {
  const tempDirs: string[] = [];

  afterEach(async () => {
    while (tempDirs.length > 0) {
      const dir = tempDirs.pop();
      if (dir !== undefined) await rm(dir, { recursive: true, force: true });
    }
  });

  it("a declared version field survives save then load", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contracts-version-"));
    tempDirs.push(dir);

    const contract = validContract({ contractId: "sprint-version-roundtrip", version: 4 });
    await saveContract(dir, contract);
    const loaded = await loadContract(dir, contract.contractId);

    expect(loaded.version).toBe(4);
  });

  it("a contract with no version field round-trips with version still absent", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contracts-version-absent-"));
    tempDirs.push(dir);

    const contract = validContract({ contractId: "sprint-version-absent" });
    await saveContract(dir, contract);
    const loaded = await loadContract(dir, contract.contractId);

    expect(loaded.version).toBeUndefined();
  });

  it("control: an UNDECLARED key on the same object does NOT survive the same round-trip — this is the asymmetry version had to avoid", async () => {
    const dir = await mkdtemp(join(tmpdir(), "contracts-version-control-"));
    tempDirs.push(dir);

    const contract = validContract({ contractId: "sprint-version-control" });
    // saveContract writes the caller's object as-is, so an undeclared key reaches the file.
    const withUndeclaredKey = {
      ...contract,
      undeclaredRideAlongField: "should not survive a load",
    } as SprintContract;
    await saveContract(dir, withUndeclaredKey);

    const raw = await readFile(
      join(dir, ".bober", "contracts", `${contract.contractId.replace(/[^a-zA-Z0-9_-]/g, "_")}.json`),
      "utf-8",
    );
    expect(JSON.parse(raw)).toHaveProperty("undeclaredRideAlongField");

    const loaded = await loadContract(dir, contract.contractId);
    expect((loaded as Record<string, unknown>).undeclaredRideAlongField).toBeUndefined();
  });
});
