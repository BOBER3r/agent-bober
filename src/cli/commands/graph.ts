import type { Command } from "commander";
import { TokensavePrereqCheck } from "../../graph/prereq.js";

/**
 * Register the `graph` subcommand on the given root program.
 * Phase 1: only `check-prereq` is wired. `init|sync|status` come in sprint 10.
 */
export function registerGraphCommand(program: Command): void {
  const graph = program
    .command("graph")
    .description("Code-graph (tokensave) integration commands");

  graph
    .command("check-prereq")
    .description("Detect tokensave and report version compatibility (JSON)")
    .action(async () => {
      const checker = new TokensavePrereqCheck();
      const result = await checker.check();
      // Plain JSON to stdout — no chalk, no logger
      process.stdout.write(JSON.stringify(result) + "\n");
      if (!result.ok) process.exitCode = 1;
    });
}
