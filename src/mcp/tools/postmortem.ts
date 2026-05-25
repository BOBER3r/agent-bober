// ── bober_postmortem_get tool ─────────────────────────────────────────
//
// Reads .bober/incidents/<id>/postmortem.md and returns { content, sections, citations }.
// Sections are parsed by splitting on ## headers.
// Citations are extracted with the same regex used internally in src/incident/postmortem.ts.
//
// Sprint 6 (cockpit-integration)

import { readFile } from "node:fs/promises";
import { join, isAbsolute } from "node:path";
import { cwd } from "node:process";

import { registerTool } from "./registry.js";

// Same regex used internally in src/incident/postmortem.ts countCitations function
const CITATION_RE =
  /\([a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?(?:,\s*[a-z0-9_./-]+(?:#(?:L?\d+|[a-z0-9-]+))?)?\)/gi;

function parseSections(md: string): Array<{ name: string; content: string }> {
  const out: Array<{ name: string; content: string }> = [];
  const re = /^## (.+)$/gm;
  const matches = [...md.matchAll(re)];
  for (let i = 0; i < matches.length; i++) {
    const match = matches[i]!;
    const start = match.index!;
    const end = i + 1 < matches.length ? matches[i + 1]!.index! : md.length;
    out.push({ name: match[1]!.trim(), content: md.slice(start, end).trim() });
  }
  return out;
}

export function registerPostmortemTool(): void {
  registerTool({
    name: "bober_postmortem_get",
    description:
      "Read .bober/incidents/<id>/postmortem.md and return { content, sections, citations }. " +
      "Sections are parsed from ## headers. Citations use the same regex as src/incident/postmortem.ts. " +
      "Returns a soft-error JSON if the postmortem file does not exist.",
    inputSchema: {
      type: "object",
      properties: {
        incidentId: {
          type: "string",
          description: "Incident ID whose postmortem to read.",
        },
        projectPath: {
          type: "string",
          description: "Absolute project root (defaults to cwd).",
        },
      },
      required: ["incidentId"],
      additionalProperties: false,
    },
    handler: async (args: Record<string, unknown>): Promise<string> => {
      const incidentId = typeof args.incidentId === "string" ? args.incidentId.trim() : "";
      if (!incidentId) {
        return JSON.stringify({ error: "incidentId is required and must be a non-empty string." });
      }

      const projectPath = typeof args.projectPath === "string" ? args.projectPath : cwd();
      if (typeof args.projectPath === "string" && !isAbsolute(args.projectPath)) {
        return JSON.stringify({ error: "projectPath must be absolute" });
      }

      const pmPath = join(projectPath, ".bober", "incidents", incidentId, "postmortem.md");

      let content: string;
      try {
        content = await readFile(pmPath, "utf-8");
      } catch (err) {
        if ((err as { code?: string }).code === "ENOENT") {
          return JSON.stringify({ error: `No postmortem found for incident ${incidentId}` });
        }
        return JSON.stringify({
          error: `Failed to read postmortem: ${err instanceof Error ? err.message : String(err)}`,
        });
      }

      const sections = parseSections(content);
      const citations = content.match(CITATION_RE) ?? [];

      return JSON.stringify({ content, sections, citations }, null, 2);
    },
  });
}
