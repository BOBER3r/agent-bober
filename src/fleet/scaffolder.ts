import { mkdir, writeFile, readdir, stat } from "node:fs/promises";
import { resolve, join } from "node:path";
import { execa } from "execa";
import { buildChildConfig } from "./child-config.js";
import type { FleetChild } from "./manifest.js";

// ── Types ────────────────────────────────────────────────────────────

export interface ScaffoldResult {
  folder: string;
  absPath: string;
  configWritten: boolean;
  gitInitialized: boolean;
  error?: string;
}

// ── Scaffolder ───────────────────────────────────────────────────────

export class ChildScaffolder {
  async scaffold(
    rootDir: string,
    child: FleetChild,
    blackboard?: { dbPath: string; namespace: string; maxRounds: number },
  ): Promise<ScaffoldResult> {
    const absPath = resolve(rootDir, child.folder);

    // 1. Non-empty safety check — bail untouched if folder exists and has entries
    try {
      const statResult = await stat(absPath);
      if (statResult.isDirectory()) {
        const entries = await readdir(absPath);
        if (entries.length > 0) {
          return {
            folder: child.folder,
            absPath,
            configWritten: false,
            gitInitialized: false,
            error: "folder exists and is non-empty",
          };
        }
      }
    } catch {
      // stat failed → folder does not exist, proceed to create
    }

    // 2. Create the directory (recursive so intermediate dirs are made)
    try {
      await mkdir(absPath, { recursive: true });
    } catch (err) {
      return {
        folder: child.folder,
        absPath,
        configWritten: false,
        gitInitialized: false,
        error: `mkdir failed: ${(err as Error).message}`,
      };
    }

    // 3. Write bober.config.json using the Zod-valid config from buildChildConfig
    try {
      const config = buildChildConfig(child);
      if (blackboard) {
        config.fleet = {
          blackboardDbPath: blackboard.dbPath,
          blackboardNamespace: blackboard.namespace,
          blackboardSubject: child.folder,
          maxRounds: blackboard.maxRounds,
        };
      }
      const configJson = JSON.stringify(config, null, 2);
      await writeFile(join(absPath, "bober.config.json"), configJson, "utf-8");
    } catch (err) {
      return {
        folder: child.folder,
        absPath,
        configWritten: false,
        gitInitialized: false,
        error: `writeFile failed: ${(err as Error).message}`,
      };
    }

    // 4. git init — reject:false so a non-zero exit is captured, not thrown
    let gitInitialized = false;
    let gitError: string | undefined;
    try {
      const gitResult = await execa("git", ["init"], {
        cwd: absPath,
        reject: false,
      });
      if (gitResult.exitCode === 0) {
        gitInitialized = true;
      } else {
        gitError = `git init exited ${gitResult.exitCode}: ${gitResult.stderr}`;
      }
    } catch (err) {
      gitError = `git init spawn error: ${(err as Error).message}`;
    }

    return {
      folder: child.folder,
      absPath,
      configWritten: true,
      gitInitialized,
      ...(gitError !== undefined ? { error: gitError } : {}),
    };
  }
}
