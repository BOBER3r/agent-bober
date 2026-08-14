/**
 * Live integration test — sc-4-5.
 *
 * Requires the real `code-review-graph` binary. It is NOT on the default
 * shell PATH in this environment (installed under
 * ~/Library/Python/3.12/bin) — export PATH or set CRG_BIN before running
 * this file for it to actually execute instead of skip. Mirrors the
 * `hasTokensave` skipIf pattern in tests/graph/hook-integration.test.ts and
 * tests/graph/mcp-client.test.ts (spawnSync, not execa, so it is unaffected
 * by any vi.mock("execa") elsewhere in the suite).
 */
import { describe, it, expect, vi } from "vitest";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { CodeReviewGraphBackend } from "../../../src/graph/backends/code-review-graph-backend.js";
import type { GraphSection } from "../../../src/graph/types.js";

function resolveCrGraphBinary(): string {
  return process.env.CRG_BIN ?? "code-review-graph";
}

const hasCrGraph = (() => {
  try {
    return spawnSync(resolveCrGraphBinary(), ["--version"]).status === 0;
  } catch {
    return false;
  }
})();

function makeIncidentLog() {
  return { append: vi.fn().mockResolvedValue(undefined) };
}

describe.skipIf(!hasCrGraph)("code-review-graph live MCP handshake (sc-4-5)", () => {
  it("TokensaveMcpClient.start() completes the initialize handshake against a real `code-review-graph serve`", async () => {
    const { TokensaveMcpClient } = await import("../../../src/graph/mcp-client.js");
    const incidents = makeIncidentLog();
    const tmp = await mkdtemp(join(tmpdir(), "bober-crg-live-"));

    // The Sprint-2 transport currently resolves the spawned binary from
    // `cfg.tokensavePath ?? processSpec.binary` regardless of which backend
    // is injected (wiring config.graph.codeReviewGraphPath through
    // spawnAndHandshake is a follow-up — see the sprint-4 briefing §4). For
    // this test we bypass that gap by putting the resolved cr-graph binary
    // directly on processSpec.binary, which the transport DOES honor.
    const processSpec = {
      ...new CodeReviewGraphBackend().processSpec(),
      binary: resolveCrGraphBinary(),
    };

    const client = new TokensaveMcpClient(
      tmp,
      { enabled: true, queryTimeoutMs: 5_000 } as unknown as GraphSection,
      incidents as never,
      processSpec,
    );

    try {
      const t0 = Date.now();
      await client.start();
      expect(Date.now() - t0).toBeLessThan(5_000);
      expect(client.health()).toBe("ready");
    } finally {
      await client.stop();
      await rm(tmp, { recursive: true, force: true });
    }
  });
});
