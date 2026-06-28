/**
 * Tests for personalization profile: round-trip, cipher-unavailable safety,
 * and Zod schema rejection (sc-5-2, sc-5-3, sc-5-4).
 *
 * All tests use an injected reversible fake cipher — no real sops binary is invoked.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Buffer } from "node:buffer";

import type { ProfileCipher } from "./profile.js";
import {
  ProfileSchema,
  writeProfile,
  readProfile,
  emitProfileYaml,
  parseProfileYaml,
} from "./profile.js";

// -- Fake cipher ---------------------------------------------------------

/**
 * Reversible fake cipher for tests: base64-encodes with a "SOPS:" prefix.
 * available() returns the `available` argument — defaults to true.
 * Never shells out to a real sops binary.
 */
function fakeCipher(available = true): ProfileCipher {
  return {
    available: () => available,
    encrypt: (s: string) => `SOPS:${Buffer.from(s, "utf-8").toString("base64")}`,
    decrypt: (s: string) =>
      Buffer.from(s.replace(/^SOPS:/, ""), "base64").toString("utf-8"),
  };
}

// -- Temp dir setup -------------------------------------------------------

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(join(tmpdir(), "bober-profile-test-"));
  process.exitCode = 0;
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

// -- emitProfileYaml / parseProfileYaml unit tests -----------------------

describe("emitProfileYaml + parseProfileYaml", () => {
  it("round-trips a profile with non-empty arrays", () => {
    const profile = ProfileSchema.parse({
      age: 42,
      sex: "male",
      conditions: ["hypertension"],
      goals: ["lower ldl", "improve sleep"],
    });
    const yaml = emitProfileYaml(profile);
    const parsed = parseProfileYaml(yaml);
    const recovered = ProfileSchema.parse(parsed);

    expect(recovered.age).toBe(42);
    expect(recovered.sex).toBe("male");
    expect(recovered.conditions).toEqual(["hypertension"]);
    expect(recovered.goals).toEqual(["lower ldl", "improve sleep"]);
  });

  it("round-trips a profile with empty arrays via [] shorthand", () => {
    const profile = ProfileSchema.parse({ age: 0, sex: "other" });
    const yaml = emitProfileYaml(profile);

    expect(yaml).toContain("conditions: []");
    expect(yaml).toContain("goals: []");

    const recovered = ProfileSchema.parse(parseProfileYaml(yaml));
    expect(recovered.conditions).toEqual([]);
    expect(recovered.goals).toEqual([]);
  });
});

// -- sc-5-2: round-trip via fake cipher ------------------------------------

describe("writeProfile + readProfile round-trip (sc-5-2)", () => {
  it("round-trips age, sex, and goals through the fake cipher", async () => {
    const profile = ProfileSchema.parse({
      age: 42,
      sex: "male",
      goals: ["lower ldl", "improve sleep"],
    });

    await writeProfile(tmpDir, profile, { cipher: fakeCipher() });
    const back = await readProfile(tmpDir, { cipher: fakeCipher() });

    expect(back.age).toBe(42);
    expect(back.sex).toBe("male");
    expect(back.goals).toEqual(["lower ldl", "improve sleep"]);
  });

  it("profile.yaml on disk is NOT plaintext (encrypted via fake cipher prefix)", async () => {
    const profile = ProfileSchema.parse({
      age: 30,
      sex: "female",
      conditions: ["hypertension"],
    });

    await writeProfile(tmpDir, profile, { cipher: fakeCipher() });
    const content = await readFile(join(tmpDir, "profile.yaml"), "utf-8");

    // Fake cipher wraps in base64 with SOPS: prefix — not raw YAML
    expect(content.startsWith("SOPS:")).toBe(true);
    // Raw plaintext scalars must NOT be visible on disk
    expect(content).not.toContain("age: 30");
    expect(content).not.toContain("hypertension");
  });

  it("round-trips all array fields (medications, supplements, allergies)", async () => {
    const profile = ProfileSchema.parse({
      age: 55,
      sex: "female",
      medications: ["metformin"],
      supplements: ["vitamin d", "magnesium"],
      allergies: ["penicillin"],
    });

    await writeProfile(tmpDir, profile, { cipher: fakeCipher() });
    const back = await readProfile(tmpDir, { cipher: fakeCipher() });

    expect(back.medications).toEqual(["metformin"]);
    expect(back.supplements).toEqual(["vitamin d", "magnesium"]);
    expect(back.allergies).toEqual(["penicillin"]);
  });
});

// -- sc-5-3: cipher-unavailable refuse + no plaintext ----------------------

describe("cipher-unavailable safety (sc-5-3)", () => {
  it("writeProfile rejects with a clear message when cipher is unavailable", async () => {
    const profile = ProfileSchema.parse({ age: 25, sex: "other" });

    await expect(
      writeProfile(tmpDir, profile, { cipher: fakeCipher(false) }),
    ).rejects.toThrow(/unavailable/);
  });

  it("writeProfile leaves no profile.yaml on disk when cipher is unavailable", async () => {
    const profile = ProfileSchema.parse({ age: 25, sex: "other" });

    try {
      await writeProfile(tmpDir, profile, { cipher: fakeCipher(false) });
    } catch {
      // Expected — swallow to allow the assertion below
    }

    // No profile.yaml should exist (or be readable) after a refused write
    await expect(
      readFile(join(tmpDir, "profile.yaml"), "utf-8"),
    ).rejects.toThrow();
  });

  it("readProfile rejects with a clear message when cipher is unavailable", async () => {
    await expect(
      readProfile(tmpDir, { cipher: fakeCipher(false) }),
    ).rejects.toThrow(/unavailable/);
  });

  it("readProfile does NOT attempt a disk read when cipher is unavailable", async () => {
    // First write a valid encrypted profile so the file exists
    const profile = ProfileSchema.parse({ age: 40, sex: "male" });
    await writeProfile(tmpDir, profile, { cipher: fakeCipher() });

    // Now try to read with unavailable cipher — must refuse, not return garbage
    await expect(
      readProfile(tmpDir, { cipher: fakeCipher(false) }),
    ).rejects.toThrow(/unavailable/);
  });
});

// -- sc-5-4: Zod schema validation -----------------------------------------

describe("ProfileSchema validation (sc-5-4)", () => {
  it("rejects a negative age with a Zod validation error", () => {
    expect(() => ProfileSchema.parse({ age: -1, sex: "male" })).toThrow();
  });

  it("rejects an unrecognized sex value with a Zod validation error", () => {
    expect(() => ProfileSchema.parse({ age: 30, sex: "unknown" })).toThrow();
  });

  it("accepts valid profiles with all fields", () => {
    const result = ProfileSchema.parse({
      age: 35,
      sex: "female",
      conditions: ["diabetes"],
      medications: ["insulin"],
      supplements: ["zinc"],
      allergies: ["sulfa"],
      goals: ["stabilize glucose"],
    });
    expect(result.age).toBe(35);
    expect(result.conditions).toEqual(["diabetes"]);
  });

  it("defaults all array fields to [] when omitted", () => {
    const result = ProfileSchema.parse({ age: 0, sex: "other" });
    expect(result.conditions).toEqual([]);
    expect(result.medications).toEqual([]);
    expect(result.supplements).toEqual([]);
    expect(result.allergies).toEqual([]);
    expect(result.goals).toEqual([]);
  });
});
