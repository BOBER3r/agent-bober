/**
 * Command classifier for the deploy module (Sprint 20).
 *
 * classifyCommand(commandText) returns 'safe' | 'risky' based solely on the
 * COMMAND CONTENT — never on the agent's self-declared classification.
 *
 * This is the safety guarantee against multi-command Bash invocations such as
 * `echo 'safe' && kubectl scale ...`. The classifier scans the entire command
 * string for state-mutating verbs before any execution occurs.
 *
 * Pattern sources:
 * - agents/bober-diagnoser.md:188-198 (forbidden command list)
 * - skills/bober.runbook/SKILL.md (risky-step examples)
 * - Sprint 20 contract evaluatorNotes: multi-command gate requirement.
 *
 * Default-deny: when in doubt, classify risky.
 */

/** Risky patterns — matched against the full command string.
 *  Most-specific patterns listed first to avoid false positives on substrings. */
const RISKY_PATTERNS: ReadonlyArray<RegExp> = [
  // kubectl mutators
  /\bkubectl\s+(delete|apply|patch|edit|scale|rollout|exec\b.*--\s+(?!.*\bget\b))/,
  // docker mutators
  /\bdocker\s+(rm|stop|kill|restart|run|exec\b.*(?:bash|sh))/,
  // git mutators
  /\bgit\s+(reset\s+--hard|push|rebase|commit|revert|clean)/,
  // terraform / helm
  /\b(terraform\s+(apply|destroy)|helm\s+(install|upgrade|uninstall|rollback))\b/,
  // file mutation: rm, rmdir, mv, cp with overwrite intent
  /(?:^|\s)(rm|rmdir)\s+/,
  /(?:^|\s)(mv|cp)\s+.*\s+\S+/, // mv/cp with destination argument (potential overwrite)
  // shell redirect to file (> or >>)
  /(?:^|[\s;|&])[^>]*>[>]?\s*\S+/,
  // chmod / chown
  /\bchmod\b|\bchown\b/,
  // service / process control
  /\bsystemctl\s+(start|stop|restart|enable|disable|mask|unmask)\b/,
  /\bservice\s+\S+\s+(start|stop|restart)\b/,
  /\b(kill|pkill|killall)\b/,
  // package install
  /\b(npm\s+install|pip\s+install|apt(\s+|-get\s+)install|brew\s+install|yarn\s+add|gem\s+install|cargo\s+install)\b/,
  // privilege escalation
  /(?:^|\s)sudo\s+/,
  // state-mutating HTTP
  /\bcurl\b[^|]*\s-X\s+(POST|PUT|PATCH|DELETE)\b/i,
  // wget downloading executables (heuristic)
  /\bwget\s+[^|]*\.(sh|bin|exe)\b/i,
  // AWS mutation
  /\baws\s+(ec2|elbv2|route53)\s+(create|delete|modify|put|update)/i,
  // GCloud mutation
  /\bgcloud\s+\S+\s+(create|delete|update|set)\b/i,
  // Database migrations (heuristic — covers common runners)
  /\b(flyway\s+migrate|liquibase\s+update|alembic\s+upgrade|rake\s+db:migrate|knex\s+migrate)\b/i,
  // Secret rotation (heuristic)
  /\b(vault\s+(rotate|write|delete)|aws\s+secretsmanager\s+(rotate|put|delete|update))\b/i,
];

/**
 * Safe explicit allowlist — used as SHORT-CIRCUIT only when the ENTIRE command
 * matches (no chain operators present). Any command with && / || / ; chains is
 * evaluated via RISKY_PATTERNS first before reaching this list.
 */
const SAFE_SINGLE_COMMAND_PATTERNS: ReadonlyArray<RegExp> = [
  /^kubectl\s+(get|describe|logs|top|version|config\s+view)\b[^&;|]*$/,
  /^docker\s+(ps|logs|inspect|images|version)\b[^&;|]*$/,
  /^(grep|rg|ag|find|cat|head|tail|less|wc|awk|jq|yq)\b[^&;|]*$/,
  /^git\s+(log|diff|show|blame|status|rev-parse|describe)\b[^&;|]*$/,
  /^curl\b(?![^|]*\s-X\s+(POST|PUT|PATCH|DELETE))[^&;|]*$/i,
  /^(ps|top|htop|lsof|netstat|ss|dig|nslookup|host|ping|traceroute|df|du|free|uname|uptime|date)\b[^&;|]*$/,
  /^(sed\s+-n|awk)\b[^&;|]*$/, // read-only sed (-n only)
];

/**
 * Classify a command string by blast radius.
 *
 * Rules:
 * 1. Scan the full command string for any risky pattern (takes priority over allowlist).
 * 2. If no risky pattern matched AND the command has no chain operators (&&/||/;/|),
 *    check if it matches the safe allowlist.
 * 3. When in doubt → risky (default-deny).
 *
 * @param commandText - The raw shell command string.
 * @returns 'safe' if the command is confirmed read-only/reversible; 'risky' otherwise.
 */
export function classifyCommand(commandText: string): "safe" | "risky" {
  const trimmed = commandText.trim();
  if (trimmed.length === 0) return "safe"; // empty / no-op

  // Step 1: Scan for risky patterns first — this catches multi-command invocations.
  for (const pattern of RISKY_PATTERNS) {
    if (pattern.test(trimmed)) return "risky";
  }

  // Step 2: If no risky pattern matched, check if the whole command is a known-safe single command.
  // A command with chain operators (&&, ||, ;, |) that passed risky-scan is still examined:
  // pipe (|) alone can be safe (e.g., kubectl get pods | head) but && / || / ; chains to
  // other commands need more scrutiny. Here we allow simple pipes to safe commands.
  const hasRiskyChainOperator = /&&|\|\|/.test(trimmed);
  const hasSemicolon = /;(?!\s*$)/.test(trimmed); // semicolons not at end
  if (!hasRiskyChainOperator && !hasSemicolon) {
    // Strip any trailing pipe chain and classify the base command.
    const baseCommand = trimmed.split("|")[0].trim();
    for (const safe of SAFE_SINGLE_COMMAND_PATTERNS) {
      if (safe.test(baseCommand)) return "safe";
    }
  }

  // Step 3: When in doubt, classify risky (default-deny).
  return "risky";
}
