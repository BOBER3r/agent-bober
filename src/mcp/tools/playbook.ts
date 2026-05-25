// ── bober_playbook_list + bober_playbook_search tools ─────────────────
//
// Two thin adapters over loadPlaybooks + searchPlaybooks from src/incident/playbook-search.ts.
// No business logic here — all logic delegated to the underlying helpers.
//
// Sprint 6 (cockpit-integration)

import { cwd } from "node:process";
import { isAbsolute } from "node:path";

import { registerTool } from "./registry.js";
import {
  loadPlaybooks,
  searchPlaybooks,
  HIGH_CONFIDENCE_THRESHOLD,
  LOW_CONFIDENCE_THRESHOLD,
} from "../../incident/playbook-search.js";

function classifyTier(confidence: number): "high" | "suggestion" | "low" {
  if (confidence >= HIGH_CONFIDENCE_THRESHOLD) return "high";
  if (confidence >= LOW_CONFIDENCE_THRESHOLD) return "suggestion";
  return "low";
}

export function registerPlaybookTools(): void {
  // ── bober_playbook_list ─────────────────────────────────────────────
  registerTool({
    name: "bober_playbook_list",
    description:
      "List all playbooks from .bober/playbooks/. " +
      "Delegates to loadPlaybooks from src/incident/playbook-search.ts. " +
      "Returns [{ name, classification, applicableSymptoms }].",
    inputSchema: {
      type: "object",
      properties: {
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      let playbooks;
      try {
        playbooks = await loadPlaybooks(projectPath);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to load playbooks: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        playbooks.map((p) => ({
          name: p.name,
          classification: p.classification,
          applicableSymptoms: p.applicableSymptoms,
        })),
        null,
        2,
      );
    },
  });

  // ── bober_playbook_search ───────────────────────────────────────────
  registerTool({
    name: "bober_playbook_search",
    description:
      "Search playbooks matching a symptom. " +
      "Delegates to searchPlaybooks from src/incident/playbook-search.ts. " +
      "Returns [{ name, confidence, tier, matchedTokens }] sorted descending by confidence.",
    inputSchema: {
      type: "object",
      properties: {
        symptom: {
          type: "string",
          description: "Free-text symptom to search for.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      required: ["symptom"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const symptom = typeof args.symptom === "string" ? args.symptom.trim() : "";
      if (!symptom) {
        return JSON.stringify({ error: "symptom is required and must be a non-empty string." });
      }

      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      let matches;
      try {
        matches = await searchPlaybooks(symptom, projectPath);
      } catch (err) {
        return JSON.stringify({
          error: `Failed to search playbooks: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      return JSON.stringify(
        matches.map((m) => ({
          name: m.playbook.name,
          confidence: m.confidence,
          tier: classifyTier(m.confidence),
          matchedTokens: m.matchedTokens,
        })),
        null,
        2,
      );
    },
  });
}
