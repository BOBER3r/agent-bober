import { describe, it, expect } from "vitest";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

// Regression guard for inc-20260620-cli-tdz-crash:
// `decomposer-deep` <-> `critic-deep` formed a circular import where `critic-deep` read budget
// constants at module-evaluation time. Entering the graph via `decomposer-deep` first (as the CLI
// does through fleet/index.ts) left those constants in their temporal dead zone → ReferenceError
// that killed EVERY `agent-bober` command. The fix moves the init-time constants into the
// dependency-free leaf `decomposer-deep-constants.ts`.

const __dirname = dirname(fileURLToPath(import.meta.url));

describe("deep decomposer constants — circular-import init safety", () => {
  it("re-exports the budget constants and derives the critique budget correctly", async () => {
    // In-process value/re-export guard (always runs; vitest's loader does not reproduce the
    // native-ESM ordering, so this guards the refactor's correctness, not the TDZ itself).
    const decomposer = await import("./decomposer-deep.js");
    const critic = await import("./critic-deep.js");
    expect(decomposer.DEEP_MAX_TOTAL_CALLS).toBe(4);
    expect(decomposer.DEEP_EXPAND_MAX_RETRIES).toBe(1);
    expect(decomposer.DEEP_PLAN_MAX_RETRIES).toBe(1);
    // 4 + 1*((1+1)+(1+1)) = 8
    expect(critic.DEEP_CRITIQUE_MAX_TOTAL_CALLS).toBe(8);
  });

  it("loads under the native ESM loader in the crashing order (decomposer-deep first)", () => {
    // The TRUE TDZ guard: spawn real Node and import the built dist module in the order that
    // previously crashed. Runs only when dist is present (i.e. post-build / CI); skips on a
    // pure-src test run where there is no built artifact to load.
    const distModule = resolve(__dirname, "../../dist/fleet/decomposer-deep.js");
    if (!existsSync(distModule)) {
      // No built artifact — native loader cannot import .ts here; nothing to assert.
      return;
    }
    const script = `import('${distModule.replace(/\\/g, "\\\\")}')
      .then((m) => { if (m.DEEP_MAX_TOTAL_CALLS !== 4) { console.error('bad value'); process.exit(2); } })
      .catch((e) => { console.error(e && e.message); process.exit(1); });`;
    // Throws (non-zero exit) if the TDZ regression returns; passes silently on exit 0.
    expect(() =>
      execFileSync(process.execPath, ["--input-type=module", "-e", script], {
        stdio: "pipe",
        timeout: 20_000,
      }),
    ).not.toThrow();
  });
});
