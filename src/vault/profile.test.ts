import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveProfile } from "./profile.js";
import { ACTIVE_STATUS, SUPERSEDED_STATUS, ATTACHMENTS_DIR } from "./conventions.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

/** Plaintext vault profile YAML (standalone — no `---` delimiters). */
const PLAINTEXT = `owner: alice
domain: medical
created: 2026-06-28T00:00:00.000Z
tags:
  - primary
  - care
`;

/**
 * Minimal representative SOPS-encrypted YAML.
 * The top-level `sops:` mapping is injected by SOPS on every encrypted file.
 * The `name:` line carries an ENC[...] ciphertext value — it must never be exposed.
 */
const SOPS_ENCRYPTED = `name: ENC[AES256_GCM,data:Tr7o,iv:xY+a==,tag:zz9==,type:str]
sops:
    lastmodified: "2026-06-28T00:00:00Z"
    mac: ENC[AES256_GCM,data:9k0==,iv:aa1==,tag:bb2==,type:str]
    pgp: []
    unencrypted_suffix: _unencrypted
    version: 3.7.3
`;

// ── resolveProfile tests ────────────────────────────────────────────────────

describe("resolveProfile", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "bober-profile-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("sc-5-2: parses plaintext profile.yaml into a typed VaultProfile with declared fields", async () => {
    await writeFile(join(dir, "profile.yaml"), PLAINTEXT);
    const p = await resolveProfile(dir);
    expect(p).toMatchObject({ owner: "alice", domain: "medical" });
    expect((p as Record<string, unknown>).tags).toEqual(["primary", "care"]);
    // Confirm it is not the encrypted sentinel
    expect(p).not.toEqual({ encrypted: true });
  });

  it("sc-5-3: SOPS-encrypted profile returns ONLY { encrypted: true } — no leaked fields, no throw", async () => {
    await writeFile(join(dir, "profile.yaml"), SOPS_ENCRYPTED);
    const p = await resolveProfile(dir);
    // Exact shape — no extra fields allowed
    expect(p).toEqual({ encrypted: true });
    // Ciphertext must NOT be exposed
    expect((p as Record<string, unknown>).name).toBeUndefined();
    // SOPS metadata must NOT leak
    expect((p as Record<string, unknown>).sops).toBeUndefined();
    expect((p as Record<string, unknown>).version).toBeUndefined();
    expect((p as Record<string, unknown>).mac).toBeUndefined();
  });

  it("sc-5-4: missing profile.yaml returns undefined (never throws)", async () => {
    // dir exists but has no profile.yaml
    const result = await resolveProfile(dir);
    expect(result).toBeUndefined();
  });
});

// ── convention constants tests ──────────────────────────────────────────────

describe("conventions", () => {
  it("sc-5-4: exposes canonical status values and attachments directory name", () => {
    expect(ACTIVE_STATUS).toBe("active");
    // Must match the literal Sprint-2 used for the status:superseded exclusion check
    expect(SUPERSEDED_STATUS).toBe("superseded");
    expect(ATTACHMENTS_DIR).toBe("attachments");
  });
});
