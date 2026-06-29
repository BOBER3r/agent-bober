/** `bober telegram` — start the Telegram long-polling bot (Sprint 1 of spec-20260628-telegram-frontend). */
import chalk from "chalk";
import type { Command } from "commander";

import { GrammyTransport, startPollLoop } from "../../telegram/bot.js";

// ── registerTelegramCommand ───────────────────────────────────────────

/**
 * Registers `agent-bober telegram` with Commander.
 * Running the command reads TELEGRAM_BOT_TOKEN from the environment, starts a
 * local getUpdates long-polling loop, and blocks until Ctrl+C (SIGINT/SIGTERM).
 * If TELEGRAM_BOT_TOKEN is absent, writes a message naming the variable to stderr,
 * sets process.exitCode = 1, and returns (stopCondition #3).
 */
export function registerTelegramCommand(program: Command): void {
  program
    .command("telegram")
    .description(
      "Start the Telegram long-polling bot (reads TELEGRAM_BOT_TOKEN and TELEGRAM_ALLOWED_USERS from env)",
    )
    .action(async () => {
      const token = process.env["TELEGRAM_BOT_TOKEN"];
      if (!token) {
        process.stderr.write(
          chalk.red(
            "TELEGRAM_BOT_TOKEN is not set — " +
              "export TELEGRAM_BOT_TOKEN=<your-bot-token> and try again.\n",
          ),
        );
        process.exitCode = 1;
        return;
      }

      try {
        const transport = new GrammyTransport(token);
        const ac = new AbortController();

        process.stdout.write(
          chalk.green("Telegram bot started — polling for updates (Ctrl+C to stop).\n"),
        );

        process.on("SIGINT", () => {
          ac.abort();
        });
        process.on("SIGTERM", () => {
          ac.abort();
        });

        await startPollLoop(transport, ac.signal);
        process.stdout.write(chalk.green("Telegram bot stopped.\n"));
      } catch (err) {
        // CLI handlers MUST NOT throw — set exitCode and return (Pattern D).
        process.stderr.write(
          chalk.red(
            `Failed to start Telegram bot: ${err instanceof Error ? err.message : String(err)}\n`,
          ),
        );
        process.exitCode = 1;
      }
    });
}
