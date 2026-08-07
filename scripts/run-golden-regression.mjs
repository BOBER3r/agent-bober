#!/usr/bin/env node
/**
 * Golden graph regression gate (sprint 14, sc-14-3/sc-14-4).
 *
 * Invoked by the blocking `pge-graph-gate` job in `.github/workflows/ci.yml`.
 *
 * This file is DELIBERATELY THIN and decides NOTHING. Every decision — which cases load,
 * what the dataset must look like, whether the pass-rate half runs, how the pass rate is
 * compared — lives in `src/pge/golden/gate.ts` (which calls `runGoldenRegressionFromDir`
 * in `src/pge/golden/runner.ts`), where unit tests drive both branches of each. A `.mjs`
 * script is invisible to tsc, to ESLint and to Vitest, so a rule implemented here would
 * be a rule no negative control can reach — and an untested gate is the decorative gate
 * this whole design exists to refuse.
 *
 * Exit codes are the gate's own `GOLDEN_EXIT`:
 *   0  the dataset is valid against the committed graph (and, when an executor is wired,
 *      the pass rate is STRICTLY above the threshold — 80 against 80 fails, by design)
 *   1  the dataset ran and did not clear the threshold
 *   2  usage — the dataset is malformed, absent, off the committed graph, or unrunnable
 *
 * FAILS CLOSED. No build, no gate module, an unreadable topology artifact, an unparseable
 * threshold, a thrown run: every one of them exits non-zero. A gate that passes when it
 * could not run is worse than no gate, because it reads as coverage.
 *
 * ── The executor is the gate's, not this script's ───────────────────
 *
 * `runGoldenGate` builds the real one itself (`dist/pge/golden/executor.js`, over this
 * repository root) and there is no option here that turns it off. That is deliberate and
 * it is a fix for a real defect: an earlier revision made the pass-rate half conditional
 * on this script injecting an executor, and this script looked for a module that did not
 * exist — so the half that claimed to gate on a regression pass rate was reachable from
 * unit tests and from nothing else. A wiring that can be forgotten is a wiring that will
 * be.
 *
 * Threshold: `--threshold <n>` beats `GOLDEN_PASS_THRESHOLD` beats the gate's default.
 * Dataset directory: `--dir <path>`, default `.bober/golden` under the repository root.
 */

import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const GATE_URL = new URL("../dist/pge/golden/gate.js", import.meta.url);

/** Non-zero even when the gate never loaded, so "cannot run" is never "passed". */
const EXIT_CANNOT_RUN = 2;

function die(message) {
  process.stderr.write(`${message}\n`);
  process.exit(EXIT_CANNOT_RUN);
}

function flag(argv, name) {
  const at = argv.indexOf(name);
  return at !== -1 && argv[at + 1] !== undefined ? argv[at + 1] : undefined;
}

function resolveThreshold(argv) {
  const raw = flag(argv, "--threshold") ?? process.env.GOLDEN_PASS_THRESHOLD;
  if (raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  if (!Number.isFinite(value)) {
    die(`Invalid pass-rate threshold ${JSON.stringify(raw)}: expected a number.`);
  }
  // Range is the runner's call (`thresholdProblem`), not this script's; it reports an
  // unusable threshold as a dataset error and exits `usage`.
  return value;
}

async function main() {
  const argv = process.argv.slice(2);

  let gate;
  try {
    gate = await import(GATE_URL.href);
  } catch (error) {
    die(
      `Cannot load the golden gate at dist/pge/golden/gate.js: ${
        error instanceof Error ? error.message : String(error)
      }\nRun \`npm run build\` first. The gate does NOT pass when it cannot be loaded.`,
    );
  }

  if (typeof gate.runGoldenGate !== "function") {
    die(
      `dist/pge/golden/gate.js does not export \`runGoldenGate\`. ` +
        `Exported names: ${Object.keys(gate).sort().join(", ") || "<none>"}.`,
    );
  }

  const dirArg = flag(argv, "--dir");
  const dir = dirArg === undefined ? undefined : isAbsolute(dirArg) ? dirArg : join(ROOT, dirArg);

  let result;
  try {
    result = await gate.runGoldenGate({
      projectRoot: ROOT,
      dir,
      minPassRatePercent: resolveThreshold(argv),
    });
  } catch (error) {
    die(
      `The golden gate threw: ${
        error instanceof Error ? (error.stack ?? error.message) : String(error)
      }`,
    );
  }

  // `lines` already names how many cases were EXECUTED out of how many exist —
  // `runGoldenGate` puts it there rather than leaving it to a caller, so the split is
  // stated in a GREEN log too. A denominator only visible in a failing run is a
  // denominator nobody ever reads.
  const stream = result.exitCode === 0 ? process.stdout : process.stderr;
  for (const line of result.lines) stream.write(`${line}\n`);
  process.exit(result.exitCode);
}

await main();
