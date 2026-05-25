/**
 * CLI blocking checkpoint mechanism.
 *
 * Prints the checkpoint id + artifact summary + an `a/r/e` prompt to stderr,
 * blocks on stdin via readline until valid input is received, and:
 *   - 'a' / 'approve' → { approved: true }
 *   - 'r' / 'reject'  → prompts for feedback, returns { approved: false, feedback }
 *   - 'e' / 'edit'    → opens $EDITOR with artifact text, reads back on save,
 *                        returns { edit: true, editDelta: { before, after } }
 *
 * Falls back to the noop mechanism (auto-approve) when stdin is not a TTY,
 * and writes a warning to stderr.
 *
 * Sprint 8 — colocated in mechanisms/ per Sprint 7 precedent.
 */

import { createInterface } from "node:readline";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";
import { writeFile, readFile, unlink } from "node:fs/promises";
import type { Readable } from "node:stream";
import type {
  CheckpointArtifact,
  CheckpointId,
  CheckpointMechanism,
  CheckpointOutcome,
} from "../types.js";
import { NoopCheckpointMechanism } from "../noop.js";

/** Fallback mechanism used when stdin is not a TTY. */
const DEFAULT_NOOP = new NoopCheckpointMechanism();

/**
 * Renders a human-readable summary of an artifact to a string.
 * Sprint 11 will add per-type renderers; for now we use a generic text summary.
 */
function renderArtifact(
  checkpoint: CheckpointId,
  artifact: CheckpointArtifact,
): string {
  const lines: string[] = [];
  const art = artifact as Record<string, unknown> | null | undefined;

  // Header line
  lines.push(`[Checkpoint: ${checkpoint}] Artifact ready.`);

  if (art && typeof art === "object") {
    // Optional path line
    if (typeof art["path"] === "string") {
      lines.push(`  Path: ${art["path"]}`);
    }

    // Text summary
    let textContent: string | null = null;
    if (typeof art["text"] === "string") {
      textContent = art["text"];
    } else if (typeof art["content"] === "string") {
      textContent = art["content"];
    }

    if (textContent !== null) {
      const textLines = textContent.split("\n");
      const totalLines = textLines.length;
      const shown = textLines.slice(0, 40);
      lines.push(`  Lines: ${totalLines}${totalLines > 40 ? " (first 40 shown)" : ""}`);
      lines.push("  ---");
      for (const l of shown) {
        lines.push(`  ${l}`);
      }
      if (totalLines > 40) {
        lines.push(`  ... (${totalLines - 40} more lines)`);
      }
      lines.push("  ---");
    }
  }

  return lines.join("\n");
}

/**
 * Asks a question via readline and resolves with the user's answer.
 */
function ask(
  rl: ReturnType<typeof createInterface>,
  question: string,
): Promise<string> {
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      resolve(answer.trim());
    });
  });
}

/**
 * Opens $EDITOR (or nano as fallback) with the artifact text in a temp file.
 * Returns { before, after } — a simple text delta.
 * The temp file is always deleted, even if the editor exits non-zero.
 */
async function editArtifact(
  initialText: string,
  editor: string,
): Promise<{ before: string; after: string }> {
  const tmpPath = join(
    tmpdir(),
    `bober-checkpoint-${randomBytes(8).toString("hex")}.txt`,
  );
  await writeFile(tmpPath, initialText, "utf-8");
  try {
    await new Promise<void>((resolve, reject) => {
      // Support editors like "code --wait" by splitting on whitespace.
      const [cmd, ...extraArgs] = editor.split(/\s+/);
      const child = spawn(cmd, [...extraArgs, tmpPath], { stdio: "inherit" });
      child.on("exit", () => {
        // Non-zero exit is treated as "saved as-is" — do not reject.
        // The finally block will still clean up.
        resolve();
      });
      child.on("error", reject);
    });
    const after = await readFile(tmpPath, "utf-8");
    return { before: initialText, after };
  } finally {
    // Always delete the temp file — even on spawn error or non-zero exit.
    await unlink(tmpPath).catch(() => {
      // Ignore — file may not exist if spawn never created it.
    });
  }
}

export class CliCheckpointMechanism implements CheckpointMechanism {
  /**
   * @param fallback - Injected noop-like mechanism used when stdin is not a TTY.
   *                   Defaults to a fresh NoopCheckpointMechanism instance.
   *                   Injecting allows tests to spy on the fallback path.
   * @param stdin    - Readable stream to read user input from.
   *                   Defaults to process.stdin; inject a pre-stuffed Readable
   *                   for performance benchmarks / non-TTY unit tests.
   * @param editor   - Editor command override ($EDITOR env var is used when
   *                   this is not supplied; falls back to "nano").
   */
  constructor(
    private readonly fallback: CheckpointMechanism = DEFAULT_NOOP,
    private readonly stdin: Readable = process.stdin as Readable,
    private readonly editor?: string,
  ) {}

  async request(
    checkpoint: CheckpointId,
    artifact: CheckpointArtifact,
  ): Promise<CheckpointOutcome> {
    // TTY guard — fall back to noop in CI / non-interactive environments.
    if (!process.stdin.isTTY) {
      process.stderr.write(
        `warn: CLI checkpoint "${checkpoint}" requested but stdin is not a TTY; auto-approving via noop.\n`,
      );
      return this.fallback.request(checkpoint, artifact);
    }

    // Render the artifact summary to stderr.
    const summary = renderArtifact(checkpoint, artifact);
    process.stderr.write(`${summary}\n`);
    process.stderr.write(`  Approve (a), Reject (r), Edit (e)? `);

    const rl = createInterface({ input: this.stdin, crlfDelay: Infinity });

    try {
      // Read action — loop until valid input.
      let action = "";
      while (true) {
        action = await ask(rl, "");
        const normalized = action.toLowerCase();
        if (
          normalized === "a" ||
          normalized === "approve" ||
          normalized === "r" ||
          normalized === "reject" ||
          normalized === "e" ||
          normalized === "edit"
        ) {
          break;
        }
        process.stderr.write(
          `  Invalid input "${action}". Enter a (approve), r (reject), or e (edit): `,
        );
      }

      const normalized = action.toLowerCase();

      // Approve branch.
      if (normalized === "a" || normalized === "approve") {
        return { approved: true };
      }

      // Reject branch — prompt for feedback.
      if (normalized === "r" || normalized === "reject") {
        process.stderr.write(`  Why are you rejecting? Feedback (one line): `);
        const feedback = await ask(rl, "");
        return { approved: false, feedback };
      }

      // Edit branch — open $EDITOR with the artifact text.
      const resolvedEditor =
        this.editor ?? process.env["EDITOR"] ?? "nano";

      // Derive initial text from artifact.
      const art = artifact as Record<string, unknown> | null | undefined;
      let initialText = "";
      if (art && typeof art === "object") {
        if (typeof art["text"] === "string") {
          initialText = art["text"];
        } else if (typeof art["content"] === "string") {
          initialText = art["content"];
        } else {
          initialText = JSON.stringify(art, null, 2);
        }
      } else if (typeof artifact === "string") {
        initialText = artifact;
      } else {
        initialText = JSON.stringify(artifact, null, 2);
      }

      const editDelta = await editArtifact(initialText, resolvedEditor);
      return { edit: true, editDelta };
    } finally {
      rl.close();
    }
  }
}
