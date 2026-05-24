import { stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { execa } from "execa";
import { glob } from "glob";
import { ensureDir, fileExists, readJson, writeJson } from "../utils/fs.js";
import type { GraphManifest, StalenessVerdict } from "./types.js";

export class GraphArtifactStore {
  private readonly graphDir: string;
  private readonly manifestPath: string;

  constructor(
    private readonly projectRoot: string,
    manifestRelPath = ".bober/graph/manifest.json",
  ) {
    this.manifestPath = resolve(projectRoot, manifestRelPath);
    this.graphDir = resolve(projectRoot, ".bober/graph");
  }

  async ensureLayout(): Promise<void> {
    await ensureDir(this.graphDir);
  }

  async readManifest(): Promise<GraphManifest | null> {
    if (!(await fileExists(this.manifestPath))) return null;
    try {
      return await readJson<GraphManifest>(this.manifestPath);
    } catch (err) {
      console.error(
        `[GraphArtifactStore] Malformed manifest at ${this.manifestPath}:`,
        err instanceof Error ? err.message : err,
      );
      return null;
    }
  }

  async writeManifest(m: GraphManifest): Promise<void> {
    await this.ensureLayout();
    await writeJson(this.manifestPath, m);
  }

  async staleness(): Promise<StalenessVerdict> {
    const manifest = await this.readManifest();
    if (!manifest) {
      return { stale: true, reason: "NO_MANIFEST", detail: "No manifest exists yet" };
    }

    // ── Git HEAD-SHA path ──
    const head = await this.gitHeadSha();
    if (head) {
      if (manifest.lastSyncedHeadSha === head) {
        return { stale: false };
      }
      return {
        stale: true,
        reason: "HEAD_DIFFERS",
        detail: `HEAD ${head} != lastSyncedHeadSha ${manifest.lastSyncedHeadSha ?? "null"}`,
      };
    }

    // ── mtime fallback (non-git repo or git unavailable) ──
    const newer = await this.filesNewerThan(manifest.lastSyncAt);
    if (newer.length > 0) {
      return {
        stale: true,
        reason: "NEWER_MTIME",
        detail: `${newer.length} file(s) modified after lastSyncAt`,
        newerFiles: newer.slice(0, 20),
      };
    }
    return { stale: false };
  }

  private async gitHeadSha(): Promise<string | null> {
    try {
      const r = await execa("git", ["rev-parse", "HEAD"], {
        cwd: this.projectRoot,
        reject: false,
        timeout: 2000,
      });
      if (r.exitCode !== 0) return null;
      return r.stdout.trim() || null;
    } catch {
      return null;
    }
  }

  private async filesNewerThan(isoTime: string): Promise<string[]> {
    const cutoff = Date.parse(isoTime);
    if (Number.isNaN(cutoff)) return [];
    const candidates = await glob("**/*", {
      cwd: this.projectRoot,
      nodir: true,
      ignore: ["node_modules/**", ".git/**", "dist/**", ".bober/**"],
    });
    const newer: string[] = [];
    for (const rel of candidates) {
      try {
        const s = await stat(join(this.projectRoot, rel));
        if (s.mtimeMs > cutoff) newer.push(rel);
      } catch {
        /* skip */
      }
    }
    return newer;
  }
}
