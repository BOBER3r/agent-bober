/**
 * `bober chat [team]` — Start an interactive bober chat session.
 *
 * The optional [team] positional argument selects the active team, routing
 * memory distill and spawned runs to that team's namespace. Omitting it uses
 * the built-in 'programming' team (default .bober/memory/ path).
 *
 * Error handling: CLI handlers MUST NOT throw. They set process.exitCode=1
 * and return on all errors. Pattern mirrors src/cli/commands/memory.ts.
 */

import type { Command } from "commander";

import { findProjectRoot } from "../../utils/fs.js";
import { loadConfig } from "../../config/loader.js";
import { resolveRoleProviders } from "../../config/role-providers.js";
import { createClient } from "../../providers/factory.js";
import { ChatSession } from "../../chat/chat-session.js";
import { loadTeam } from "../../teams/registry.js";

// ── registerChatCommand ───────────────────────────────────────────────

export function registerChatCommand(program: Command): void {
  program
    .command("chat [team]")
    .description("Start an interactive bober chat session")
    .action(async (team?: string) => {
      const projectRoot = (await findProjectRoot()) ?? process.cwd();
      try {
        const config = await loadConfig(projectRoot);
        const activeTeam = loadTeam(config, team);
        const providers = resolveRoleProviders(config);
        const client = createClient(
          providers.chat,
          config.chat?.endpoint ?? null,
          config.chat?.providerConfig,
          config.chat?.model,
          "chat",
        );

        const session = new ChatSession({
          llm: client,
          projectRoot,
          sessionId: "default",
          memoryNamespace: activeTeam.memoryNamespace || undefined,
        });

        await session.start();
      } catch (err) {
        process.stderr.write(
          `bober chat failed: ${err instanceof Error ? err.message : String(err)}\n`,
        );
        process.exitCode = 1;
      }
    });
}
