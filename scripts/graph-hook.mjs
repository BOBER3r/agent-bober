#!/usr/bin/env node
/**
 * PostToolUse hook for Edit|Write tools.
 *
 * Claude Code invokes this script after every Edit/Write tool call,
 * passing tool metadata via stdin (JSON) per the hook contract.
 *
 * Contract:
 *   - Read bober.config.json sync; exit 0 if graph.enabled=false or graph.autoSync=false.
 *   - Read JSON payload from stdin (Claude Code hook protocol).
 *   - Extract file paths (tool_input.file_path for Edit/Write).
 *   - Validate each path is inside the project root (sandboxPath logic mirrored
 *     from src/orchestrator/tools/handlers.ts:31-45).
 *   - Append one JSON line to .bober/graph/.hook-queue.jsonl: {ts, tool, paths}.
 *   - Exit 0 in <50ms. No tokensave invocation here.
 *
 * Cross-platform notes:
 *   - Shebang is present but Windows uses the hooks.json command directly:
 *     "command": "node scripts/graph-hook.mjs" (NOT a bare path).
 *   - All path operations use node:path, no shell quoting.
 *   - Uses fs SYNC calls only (readFileSync, appendFileSync) so the script
 *     can return as soon as the event loop drains. No promises.
 */

import { readFileSync, appendFileSync, mkdirSync, existsSync } from "node:fs";
import { resolve, relative, isAbsolute, dirname } from "node:path";

const PROJECT_ROOT = process.cwd();

// ── Helpers ────────────────────────────────────────────────────────

/**
 * Mirror of src/orchestrator/tools/handlers.ts:31-45 sandboxPath.
 * Returns null instead of throwing when the path is outside the sandbox,
 * so the hook script can silently drop + log an incident rather than crash.
 */
function sandboxPath(projectRoot, inputPath) {
  if (typeof inputPath !== "string" || !inputPath) return null;
  const abs = isAbsolute(inputPath) ? resolve(inputPath) : resolve(projectRoot, inputPath);
  const rel = relative(projectRoot, abs);
  if (rel.startsWith("..") || isAbsolute(rel)) return null;
  return abs;
}

function readConfigSync() {
  for (const candidate of ["bober.config.json", ".bober/config.json"]) {
    const p = resolve(PROJECT_ROOT, candidate);
    if (existsSync(p)) {
      try {
        return JSON.parse(readFileSync(p, "utf-8"));
      } catch {
        return null;
      }
    }
  }
  return null;
}

function readStdinSync() {
  // Read up to 64KB from stdin synchronously via file descriptor 0.
  try {
    return readFileSync(0, "utf-8");
  } catch {
    return "";
  }
}

function appendSandboxDropIncident(file) {
  // Best-effort; mirrors IncidentLog.append for the "sandbox-drop" variant.
  try {
    const incidentsPath = resolve(PROJECT_ROOT, ".bober/graph/incidents.jsonl");
    mkdirSync(dirname(incidentsPath), { recursive: true });
    appendFileSync(
      incidentsPath,
      JSON.stringify({
        ts: new Date().toISOString(),
        event: "sandbox-drop",
        file,
        source: "graph-hook",
      }) + "\n",
      "utf-8",
    );
  } catch {
    // ignore — never block the tool call
  }
}

// ── Main ───────────────────────────────────────────────────────────

function main() {
  const config = readConfigSync();
  const graph = config?.graph;

  // Early exit when graph is disabled or autoSync is off.
  // The hook entry stays registered in hooks.json (per s8-c9) but does nothing.
  if (!graph || graph.enabled === false) return 0;
  if (graph.autoSync === false) return 0;

  const raw = readStdinSync();
  let payload = {};
  try {
    payload = raw.trim() ? JSON.parse(raw) : {};
  } catch {
    // Malformed payload — exit cleanly with a warning; never crash.
    process.stderr.write("[graph-hook] Warning: malformed stdin payload\n");
    return 0;
  }

  // Claude Code hook payload shape:
  //   { tool_name, tool_input: { file_path?, edits?[{file_path?}] }, ... }
  const tool = payload.tool_name ?? "unknown";
  const candidatePaths = [];
  const ti = payload.tool_input ?? {};
  if (typeof ti.file_path === "string") candidatePaths.push(ti.file_path);
  if (Array.isArray(ti.edits)) {
    for (const e of ti.edits) {
      if (typeof e?.file_path === "string") candidatePaths.push(e.file_path);
    }
  }

  // Sandbox-validate every path. Drop any path outside the project root
  // with a silent incident log.
  const validated = [];
  for (const p of candidatePaths) {
    const sb = sandboxPath(PROJECT_ROOT, p);
    if (sb === null) appendSandboxDropIncident(p);
    else validated.push(sb);
  }
  if (validated.length === 0) return 0;

  // Append to IPC queue file. mkdir is defensive.
  const queueFile = resolve(PROJECT_ROOT, ".bober/graph/.hook-queue.jsonl");
  try {
    mkdirSync(dirname(queueFile), { recursive: true });
    appendFileSync(
      queueFile,
      JSON.stringify({
        ts: new Date().toISOString(),
        tool,
        paths: validated,
      }) + "\n",
      "utf-8",
    );
  } catch {
    // Best-effort; never block the tool call
  }

  return 0;
}

process.exit(main());
