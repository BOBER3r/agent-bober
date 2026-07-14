/**
 * Personalization profile -> SOPS-encrypted <vaultDir>/profile.yaml (Sprint 5).
 * Encryption is behind an injectable cipher seam; tests inject a reversible fake.
 * When the cipher is unavailable BOTH paths refuse and write NO plaintext PHI.
 * Hand-rolled flat YAML emit/parse (string[] arrays) — NEVER import src/vault.
 */

import { writeFile, readFile } from "node:fs/promises";
import { join } from "node:path";
import { execa, execaSync } from "execa";
import { z } from "zod";
import { ensureDir } from "../utils/fs.js";

// -- Schema --------------------------------------------------------------

export const ProfileSchema = z.object({
  age: z.number().int().min(0),
  sex: z.enum(["male", "female", "other"]),
  conditions: z.array(z.string()).default([]),
  medications: z.array(z.string()).default([]),
  supplements: z.array(z.string()).default([]),
  allergies: z.array(z.string()).default([]),
  goals: z.array(z.string()).default([]),
});

export type Profile = z.infer<typeof ProfileSchema>;

// -- Cipher seam ---------------------------------------------------------

/**
 * Encryption seam for profile.yaml (SOPS age key by default).
 * Tests inject a reversible fake; production uses the sops-via-execa default.
 * available() MUST be synchronous — the caller gates IO on its return value.
 */
export interface ProfileCipher {
  /** Returns true synchronously when the underlying binary is available. */
  available(): boolean;
  /** Encrypt plaintext to ciphertext (may return a Promise). */
  encrypt(plaintext: string): string | Promise<string>;
  /** Decrypt ciphertext to plaintext (may return a Promise). */
  decrypt(ciphertext: string): string | Promise<string>;
}

/**
 * Default cipher: shells out to `sops` via execa with --age recipient.
 * available() probes the binary synchronously via execaSync.
 *
 * bober: sops --age key path is not parameterised here; callers supply an age
 *        recipient once key-distribution is solved out-of-band (contract assumption 3).
 *        Swap for a KMS-backed cipher when distributed key management is added.
 */
function createSopsCipher(): ProfileCipher {
  return {
    available(): boolean {
      try {
        const r = execaSync("sops", ["--version"], {
          reject: false,
          timeout: 5_000,
        });
        return r.exitCode === 0;
      } catch {
        return false;
      }
    },
    async encrypt(plaintext: string): Promise<string> {
      const r = await execa(
        "sops",
        ["--encrypt", "--input-type", "yaml", "--output-type", "yaml", "/dev/stdin"],
        { input: plaintext, reject: false },
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `sops encrypt failed (exit ${String(r.exitCode)}): ${r.stderr || r.stdout || "no output"}`,
        );
      }
      return r.stdout;
    },
    async decrypt(ciphertext: string): Promise<string> {
      const r = await execa(
        "sops",
        ["--decrypt", "--input-type", "yaml", "--output-type", "yaml", "/dev/stdin"],
        { input: ciphertext, reject: false },
      );
      if (r.exitCode !== 0) {
        throw new Error(
          `sops decrypt failed (exit ${String(r.exitCode)}): ${r.stderr || r.stdout || "no output"}`,
        );
      }
      return r.stdout;
    },
  };
}

// -- YAML emit/parse (flat scalars + string[] arrays) --------------------

/** Array fields in the profile (serialized after the scalar fields). */
const ARRAY_KEYS = [
  "conditions",
  "medications",
  "supplements",
  "allergies",
  "goals",
] as const;

/**
 * Emit a Profile as a minimal YAML string.
 * Scalars (age, sex) first; array fields follow.
 * Empty arrays are emitted as `key: []`; non-empty as `key:\n  - item\n`.
 */
export function emitProfileYaml(p: Profile): string {
  const lines: string[] = [];
  lines.push(`age: ${String(p.age)}`);
  lines.push(`sex: ${p.sex}`);
  for (const key of ARRAY_KEYS) {
    const arr = p[key];
    if (arr.length === 0) {
      lines.push(`${key}: []`);
    } else {
      lines.push(`${key}:`);
      for (const item of arr) {
        lines.push(`  - ${item}`);
      }
    }
  }
  return lines.join("\n") + "\n";
}

/**
 * Parse a minimal profile YAML string into a plain object (for ProfileSchema.parse).
 * Handles flat scalars (age: 42, sex: male) and string arrays (key:\n  - item).
 * Returns unknown — callers must validate through ProfileSchema.parse.
 */
export function parseProfileYaml(raw: string): unknown {
  const result: Record<string, unknown> = {};
  const lines = raw.split("\n");
  let currentArrayKey: string | null = null;
  let currentArray: string[] = [];

  const flushArray = (): void => {
    if (currentArrayKey !== null) {
      result[currentArrayKey] = currentArray;
      currentArrayKey = null;
      currentArray = [];
    }
  };

  for (const line of lines) {
    if (line.trim() === "") continue;

    // List item: "  - value"
    const listMatch = /^\s+-\s+(.+)$/.exec(line);
    if (listMatch !== null) {
      if (currentArrayKey !== null) {
        currentArray.push((listMatch[1] ?? "").trim());
      }
      continue;
    }

    // Non-list line: flush any in-progress array
    flushArray();

    const colonIdx = line.indexOf(":");
    if (colonIdx < 0) continue;
    const key = line.slice(0, colonIdx).trim();
    if (key === "") continue;
    const rest = line.slice(colonIdx + 1).trim();

    if (rest === "[]") {
      // Explicit empty array shorthand
      result[key] = [];
    } else if (rest === "") {
      // Start of an indented array block
      currentArrayKey = key;
      currentArray = [];
    } else {
      // Scalar: coerce to number when the value parses as a finite number
      const n = Number(rest);
      result[key] = Number.isFinite(n) && rest.trim() !== "" ? n : rest;
    }
  }

  // Flush any trailing array (file may not end with a blank line)
  flushArray();

  return result;
}

// -- Deps interface ------------------------------------------------------

/** Injectable dependencies for writeProfile / readProfile — production callers omit. */
export interface ProfileDeps {
  /** Override the encryption cipher (e.g. reversible fake in tests). */
  cipher?: ProfileCipher;
}

// -- read / write --------------------------------------------------------

/**
 * Validate, serialize, encrypt and write the profile to <vaultDir>/profile.yaml.
 *
 * SAFETY: throws with a clear message (and writes NOTHING to disk) when
 * cipher.available() returns false. The only bytes written to disk are ciphertext.
 */
export async function writeProfile(
  vaultDir: string,
  profile: Profile,
  deps: ProfileDeps = {},
): Promise<void> {
  const validated = ProfileSchema.parse(profile);
  const cipher = deps.cipher ?? createSopsCipher();

  if (!cipher.available()) {
    throw new Error(
      "writeProfile: sops cipher unavailable — install sops with an age key configured before writing the profile",
    );
  }

  const yaml = emitProfileYaml(validated);
  const encrypted = await cipher.encrypt(yaml);

  await ensureDir(vaultDir);
  await writeFile(join(vaultDir, "profile.yaml"), encrypted, "utf-8");
}

/**
 * Read, decrypt, parse and validate the profile from <vaultDir>/profile.yaml.
 *
 * SAFETY: throws with a clear message when cipher.available() returns false
 * (no disk reads are attempted).
 */
export async function readProfile(
  vaultDir: string,
  deps: ProfileDeps = {},
): Promise<Profile> {
  const cipher = deps.cipher ?? createSopsCipher();

  if (!cipher.available()) {
    throw new Error(
      "readProfile: sops cipher unavailable — install sops with an age key configured before reading the profile",
    );
  }

  const encrypted = await readFile(join(vaultDir, "profile.yaml"), "utf-8");
  const yaml = await cipher.decrypt(encrypted);
  const parsed = parseProfileYaml(yaml);
  return ProfileSchema.parse(parsed);
}

// -- CLI cores -----------------------------------------------------------

/** Profile scalar keys. */
const SCALAR_KEYS = ["age", "sex"] as const;

/** All profile field keys (scalars + arrays). */
const ALL_KEYS = [...SCALAR_KEYS, ...ARRAY_KEYS] as const;

type ProfileKey = (typeof ALL_KEYS)[number];

/**
 * Core logic for `bober medical profile show`.
 * Reads and prints the profile to stdout.
 * Errors are caught, written to stderr, process.exitCode set to 1 — never throws.
 */
export async function runProfileShow(
  projectRoot: string,
  opts: { vault?: string },
  deps: ProfileDeps = {},
): Promise<void> {
  try {
    const vaultDir =
      opts.vault ?? join(projectRoot, ".bober", "medical");
    const profile = await readProfile(vaultDir, deps);

    process.stdout.write(`age: ${String(profile.age)}\n`);
    process.stdout.write(`sex: ${profile.sex}\n`);
    for (const key of ARRAY_KEYS) {
      const arr = profile[key];
      if (arr.length === 0) {
        process.stdout.write(`${key}: []\n`);
      } else {
        process.stdout.write(`${key}:\n`);
        for (const item of arr) {
          process.stdout.write(`  - ${item}\n`);
        }
      }
    }
  } catch (err) {
    process.stderr.write(
      `Failed to show profile: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}

/**
 * Core logic for `bober medical profile set <key> <value>`.
 * Reads the existing profile (or starts from a safe default on ENOENT),
 * updates one field, re-validates via ProfileSchema, and writes back.
 * For array keys, value is parsed as a comma-separated list.
 * Errors are caught, written to stderr, process.exitCode set to 1 — never throws.
 */
export async function runProfileSet(
  projectRoot: string,
  key: string,
  value: string,
  opts: { vault?: string },
  deps: ProfileDeps = {},
): Promise<void> {
  try {
    const vaultDir =
      opts.vault ?? join(projectRoot, ".bober", "medical");

    if (!(ALL_KEYS as readonly string[]).includes(key)) {
      throw new Error(
        `Unknown profile key: "${key}". Valid keys: ${ALL_KEYS.join(", ")}`,
      );
    }

    const typedKey = key as ProfileKey;

    // Read existing profile; fall back to safe default when the file is absent
    let current: Profile;
    try {
      current = await readProfile(vaultDir, deps);
    } catch (readErr) {
      const msg = readErr instanceof Error ? readErr.message : String(readErr);
      if (msg.includes("ENOENT") || msg.includes("no such file")) {
        current = ProfileSchema.parse({ age: 0, sex: "other" });
      } else {
        throw readErr;
      }
    }

    // Coerce the string value to the right type per key
    let coerced: unknown;
    if (typedKey === "age") {
      const n = Number(value);
      if (!Number.isFinite(n)) {
        throw new Error(`age must be a finite number, got: "${value}"`);
      }
      coerced = n;
    } else if (typedKey === "sex") {
      coerced = value;
    } else {
      // Array key: comma-separated items -> string[]
      coerced = value
        .split(",")
        .map((s) => s.trim())
        .filter((s) => s.length > 0);
    }

    const next: Record<string, unknown> = { ...current, [typedKey]: coerced };
    const validated = ProfileSchema.parse(next);

    await writeProfile(vaultDir, validated, deps);
    process.stdout.write(`Profile updated: ${key} = ${value}\n`);
  } catch (err) {
    process.stderr.write(
      `Failed to set profile field: ${err instanceof Error ? err.message : String(err)}\n`,
    );
    process.exitCode = 1;
  }
}
