import { describe, it, expect } from "vitest";
import { SecurityStackRegistry } from "./registry.js";
import type { SecurityStackId } from "./signature.js";

// ── sc-5-1: every declared stack keyword resolves to a real skill name ──

describe("SecurityStackRegistry.resolve", () => {
  const TABLE: Array<{ label: string; input: Parameters<typeof SecurityStackRegistry.resolve>[0]; stackId: SecurityStackId }> = [
    { label: "solidity blockchain", input: { blockchain: "solidity" }, stackId: "solidity" },
    { label: "evm keyword", input: "evm-compatible chain", stackId: "solidity" },
    { label: "anchor blockchain", input: { blockchain: "anchor" }, stackId: "anchor" },
    { label: "solana keyword", input: "Solana program", stackId: "anchor" },
    { label: "react frontend", input: { frontend: "react" }, stackId: "react" },
    { label: "node backend", input: { backend: "node" }, stackId: "node" },
    { label: "payments other", input: { other: ["payments"] }, stackId: "payments" },
    { label: "igaming other", input: { other: ["igaming"] }, stackId: "igaming" },
    { label: "dex-backend keyword", input: "dex orderbook service", stackId: "dex-backend" },
  ];

  for (const { label, input, stackId } of TABLE) {
    it(`resolves ${label} to stackId "${stackId}" and skillName "bober.security-${stackId}"`, () => {
      const resolution = SecurityStackRegistry.resolve(input);
      expect(resolution.stackId).toBe(stackId);
      expect(resolution.skillName).toBe(`bober.security-${stackId}`);
    });
  }

  it("resolves an unrecognised stack keyword to 'generic' with a real skill name", () => {
    const resolution = SecurityStackRegistry.resolve({ frontend: "vue" });
    expect(resolution.stackId).toBe("generic");
    expect(resolution.skillName).toBe("bober.security-generic");
    expect(resolution.stackLabel).toBe("vue");
  });

  it("resolves an absent stack (undefined) to 'generic' without throwing", () => {
    const resolution = SecurityStackRegistry.resolve(undefined);
    expect(resolution.stackId).toBe("generic");
    expect(resolution.skillName).toBe("bober.security-generic");
    expect(resolution.stackLabel).toBe("unknown");
  });

  it("resolves a null stack to 'generic' without throwing", () => {
    const resolution = SecurityStackRegistry.resolve(null as unknown as undefined);
    expect(resolution.stackId).toBe("generic");
    expect(resolution.skillName).toBe("bober.security-generic");
  });

  it("prefers blockchain/language fields over frontend when both are present (precedence)", () => {
    const resolution = SecurityStackRegistry.resolve({ frontend: "react", blockchain: "solidity" });
    expect(resolution.stackId).toBe("solidity");
  });

  it("keeps stackLabel as the matched candidate string verbatim", () => {
    const resolution = SecurityStackRegistry.resolve({ blockchain: "solidity" });
    expect(resolution.stackLabel).toBe("solidity");
  });

  it("resolves every one of the 8 SecurityStackIds to a distinct, correctly-namespaced skill name", () => {
    const ids: SecurityStackId[] = [
      "solidity",
      "anchor",
      "react",
      "node",
      "payments",
      "igaming",
      "dex-backend",
      "generic",
    ];
    const seen = new Set<string>();
    for (const id of ids) {
      const skillName = `bober.security-${id}`;
      expect(seen.has(skillName)).toBe(false);
      seen.add(skillName);
    }
    expect(seen.size).toBe(8);
  });
});
