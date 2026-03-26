import chalk from "chalk";

// ── Types ──────────────────────────────────────────────────────────

export type LogLevel = "debug" | "info" | "warn" | "error";

// ── Logger ─────────────────────────────────────────────────────────

export class Logger {
  verbose = false;

  /** Informational message (cyan prefix). */
  info(message: string, ...args: unknown[]): void {
    console.log(chalk.cyan("info"), message, ...args);
  }

  /** Success message (green prefix + checkmark). */
  success(message: string, ...args: unknown[]): void {
    console.log(chalk.green("  ✓"), message, ...args);
  }

  /** Warning message (yellow prefix). */
  warn(message: string, ...args: unknown[]): void {
    console.warn(chalk.yellow("warn"), message, ...args);
  }

  /** Error message (red prefix). */
  error(message: string, ...args: unknown[]): void {
    console.error(chalk.red("error"), message, ...args);
  }

  /** Debug message — only shown when verbose mode is enabled. */
  debug(message: string, ...args: unknown[]): void {
    if (!this.verbose) return;
    console.log(chalk.gray("debug"), message, ...args);
  }

  /**
   * Print a prominent phase transition header.
   *
   * Example output:
   * ```
   * ═══ PLANNING PHASE ═══
   * ```
   */
  phase(name: string): void {
    const banner = `═══ ${name.toUpperCase()} ═══`;
    console.log();
    console.log(chalk.bold.magenta(banner));
    console.log();
  }

  /**
   * Print a sprint status update.
   *
   * @param id     Sprint identifier.
   * @param status Current status label.
   */
  sprint(id: string, status: string): void {
    const tag = chalk.bold.blue(`[${id}]`);
    console.log(`${tag} ${status}`);
  }

  /**
   * Print a simple text-based progress indicator.
   *
   * Example: `[████████░░░░░░░░] 4/10 Generating...`
   *
   * @param current Completed items.
   * @param total   Total items.
   * @param label   Optional description.
   */
  progress(current: number, total: number, label?: string): void {
    const width = 20;
    const filled = Math.round((current / Math.max(total, 1)) * width);
    const empty = width - filled;
    const bar =
      chalk.green("█".repeat(filled)) + chalk.gray("░".repeat(empty));
    const suffix = label ? ` ${label}` : "";
    console.log(`  [${bar}] ${current}/${total}${suffix}`);
  }
}

/**
 * Singleton logger instance used across the application.
 */
export const logger = new Logger();
