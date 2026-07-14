/**
 * profile — resolver for a vault's optional profile.yaml.
 *
 * Reads <vaultDir>/profile.yaml on demand and returns:
 *   - The parsed VaultProfile when the file is plaintext YAML.
 *   - { encrypted: true } when the file carries a SOPS top-level `sops:` key
 *     (structural detection only — no decryption, no key management).
 *   - undefined when the file is absent (ENOENT).
 *
 * PURE w.r.t. clock: never calls Date.now() or new Date().
 *       No crypto, network, or sops-binary imports — detection is key-presence only.
 *
 * bober: reuses parseFrontmatter (the ONE YAML path) by wrapping the standalone
 *        YAML body in `---` delimiters — no second YAML parser is introduced.
 *        Swap for a full YAML library if nested mappings beyond the Dataview
 *        scalar/list subset are needed.
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { parseFrontmatter } from "./frontmatter.js";

/**
 * Generic, mostly-open vault profile. Domains add optional well-known keys
 * at their own use sites — no medical or financial fields are hardcoded here.
 */
export type VaultProfile = Record<string, unknown>;

/**
 * Resolve the vault profile from `<vaultDir>/profile.yaml`.
 *
 * Returns:
 *   - `VaultProfile` — plaintext YAML parsed into an open record.
 *   - `{ encrypted: true }` — SOPS-encrypted file detected (top-level `sops:` key
 *     present); no value is decrypted or exposed.
 *   - `undefined` — profile.yaml is absent (no throw).
 */
export async function resolveProfile(
  vaultDir: string,
): Promise<VaultProfile | { encrypted: true } | undefined> {
  let raw: string;
  try {
    raw = await readFile(join(vaultDir, "profile.yaml"), "utf-8");
  } catch (err) {
    if ((err as { code?: string }).code === "ENOENT") return undefined;
    throw err;
  }

  // profile.yaml is a standalone YAML document (no leading `---`).
  // Wrap it so the single declared parser handles it with consistent scalar/list rules.
  const { frontmatter } = parseFrontmatter(`---\n${raw}\n---\n`);

  // SOPS detection is key-PRESENCE, not truthiness:
  // parseFrontmatter stores `sops:` (with indented children) as "" (empty string),
  // which is falsy — use `in` to detect the key regardless of its value.
  if ("sops" in frontmatter) return { encrypted: true };

  return frontmatter as VaultProfile;
}
