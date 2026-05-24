// Source-of-truth graph types for the harness integration.
// Mirrors arch-20260524-port-code-review-graph-architecture.md §Data Model.

import type { z } from "zod";
import type { GraphSectionSchema } from "../config/schema.js";

export type GraphSection = z.infer<typeof GraphSectionSchema>;

export type PrereqResult =
  | { ok: true; version: string }
  | { ok: false; reason: "MISSING" | "INCOMPATIBLE"; hint: string };

export type GraphManifest = {
  schemaVersion: 1;
  tokensaveVersion: string;
  createdAt: string;
  lastSyncAt: string;
  indexedFileCount: number;
  languageTier: string;
  lastSyncedHeadSha: string | null;
  pendingFiles: string[];
};

export type StalenessVerdict =
  | { stale: false }
  | {
      stale: true;
      reason: "HEAD_DIFFERS" | "NEWER_MTIME" | "NO_MANIFEST";
      detail: string;
      newerFiles?: string[];
    };
