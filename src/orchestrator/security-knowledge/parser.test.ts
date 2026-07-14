import { describe, it, expect } from "vitest";
import { readFile } from "node:fs/promises";
import { SecuritySignatureParser } from "./parser.js";
import { ALL_VULN_CLASSES } from "../stack-knowledge.js";

// ── Real-asset test: parses the actual generic skill file ────────────

describe("SecuritySignatureParser — real generic skill file", () => {
  it("parses skills/bober.security-generic/SKILL.md into >=12 well-formed signatures", async () => {
    const md = await readFile(
      new URL("../../../skills/bober.security-generic/SKILL.md", import.meta.url),
      "utf-8",
    );

    const signatures = SecuritySignatureParser.parse(
      "generic",
      md,
      "skills/bober.security-generic/SKILL.md",
    );

    expect(signatures.length).toBeGreaterThanOrEqual(12);

    for (const signature of signatures) {
      expect(signature.stackId).toBe("generic");
      expect(signature.signatureId.length).toBeGreaterThan(0);
      expect(signature.title.length).toBeGreaterThan(0);
      expect(ALL_VULN_CLASSES).toContain(signature.vulnClass);
      expect(["critical", "high", "medium", "low", "info"]).toContain(signature.severity);
      expect(signature.unsafeExample.trim()).not.toBe("");
      expect(signature.safeExample.trim()).not.toBe("");
      expect(signature.skillRef).toBe("skills/bober.security-generic/SKILL.md");
    }
  });

  it("covers every signatureId unique (no duplicate ids in the real file)", async () => {
    const md = await readFile(
      new URL("../../../skills/bober.security-generic/SKILL.md", import.meta.url),
      "utf-8",
    );
    const signatures = SecuritySignatureParser.parse("generic", md, "x");
    const ids = signatures.map((s) => s.signatureId);
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Totality: parser never throws, drops malformed blocks ────────────

describe("SecuritySignatureParser — total, pure", () => {
  it("never throws on malformed input", () => {
    const malformedInputs = [
      "",
      "### \n(no fields)",
      "not markdown at all",
      "### x\n- **Title:** t",
      "### truncated-fence\n- **Title:** t\n- **Severity:** high\n- **VulnClass:** injection\n\n**Unsafe:**\n```ts\nno closing fence",
      "### missing-signature-id\n\n\n- **Title:** t\n- **Severity:** high\n- **VulnClass:** injection\n\n**Unsafe:**\n```ts\nx\n```\n\n**Safe:**\n```ts\ny\n```",
      "### bad-vulnclass\n- **Title:** t\n- **Severity:** high\n- **VulnClass:** not-a-real-class\n\n**Unsafe:**\n```ts\nx\n```\n\n**Safe:**\n```ts\ny\n```",
      "### bad-severity\n- **Title:** t\n- **Severity:** catastrophic\n- **VulnClass:** injection\n\n**Unsafe:**\n```ts\nx\n```\n\n**Safe:**\n```ts\ny\n```",
    ];

    for (const input of malformedInputs) {
      expect(() => SecuritySignatureParser.parse("generic", input, "x")).not.toThrow();
    }
  });

  it("returns [] for an empty file", () => {
    expect(SecuritySignatureParser.parse("generic", "", "x")).toEqual([]);
  });

  it("drops a block missing a required field, keeps the parseable subset", () => {
    const md = [
      "### incomplete-block",
      "- **Title:** missing vulnClass and severity",
      "",
      "### sql-injection",
      "- **Title:** SQL injection via string concat",
      "- **Severity:** critical",
      "- **VulnClass:** injection",
      "- **Invariant:** always parameterize",
      "- **Keywords:** sql, query",
      "",
      "**Unsafe:**",
      "```ts",
      'db.query("SELECT * FROM t WHERE id=" + id);',
      "```",
      "",
      "**Safe:**",
      "```ts",
      'db.query("SELECT * FROM t WHERE id=$1", [id]);',
      "```",
    ].join("\n");

    const signatures = SecuritySignatureParser.parse("generic", md, "x");
    expect(signatures).toHaveLength(1);
    expect(signatures[0].signatureId).toBe("sql-injection");
    expect(signatures[0].cwe).toBeNull();
  });

  it("is pure — does not mutate its inputs", () => {
    const md = "### sig\n- **Title:** t\n- **Severity:** low\n- **VulnClass:** xss\n\n**Unsafe:**\n```ts\nx\n```\n\n**Safe:**\n```ts\ny\n```";
    const snapshot = md;
    SecuritySignatureParser.parse("generic", md, "x");
    expect(md).toBe(snapshot);
  });
});
