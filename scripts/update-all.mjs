#!/usr/bin/env node
// ─────────────────────────────────────────────────────────────────────────
// update-all — propagate an agent-bober change to every consuming project.
//
// agent-bober is distributed two ways at once:
//   1. CLI/engine code  → ONE copy, shared via npm symlink. `npm run build`
//      recompiles src→dist and every symlinked project picks it up for free.
//   2. Skills/agents     → COPIED into each project's .claude/ by `init`
//      (skills are inlined: SKILL.md + sorted references concatenated into a
//      single .claude/commands/<name>.md). These copies go stale on every
//      skill edit and must be re-emitted per project.
//
// This script does both: build once, then re-inline skills + copy agents into
// every target listed in scripts/sync-targets.json. The inlining format is
// kept byte-identical to src/cli/commands/init.ts (installClaudeCommands) so a
// synced project is indistinguishable from a freshly `init`-ed one.
//
// Usage:
//   node scripts/update-all.mjs                # build + sync all targets
//   node scripts/update-all.mjs --check        # dry-run: report drift, write nothing
//   node scripts/update-all.mjs --skills-only  # skip the build
//   node scripts/update-all.mjs --no-build     # alias of --skills-only
//   node scripts/update-all.mjs --discover     # add initialized projects under discoverRoots to the registry
//   node scripts/update-all.mjs /abs/path ...  # sync ONLY these paths (ignore registry)
// ─────────────────────────────────────────────────────────────────────────

import { readFile, writeFile, readdir, mkdir, stat } from "node:fs/promises";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { execSync } from "node:child_process";

const __dirname = dirname(fileURLToPath(import.meta.url));
const PKG_ROOT = resolve(__dirname, "..");
const SKILLS_ROOT = join(PKG_ROOT, "skills");
const AGENTS_ROOT = join(PKG_ROOT, "agents");
const TARGETS_FILE = join(__dirname, "sync-targets.json");

// Skill-dir → command-file map. MUST match installClaudeCommands in
// src/cli/commands/init.ts. Derived at runtime from skills/ so it can never
// drift: every skills/bober.X dir maps to bober-X.md.
async function buildSkillMap() {
  const entries = await readdir(SKILLS_ROOT, { withFileTypes: true });
  const map = {};
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!e.name.startsWith("bober.")) continue;
    // bober.code-review → bober-code-review.md
    const cmd = e.name.replace(/\./g, "-") + ".md";
    map[e.name] = cmd;
  }
  return map;
}

// Re-create the inlined command file for one skill, byte-identical to init.ts.
async function inlineSkill(skillDir) {
  const srcSkill = join(SKILLS_ROOT, skillDir, "SKILL.md");
  let content = await readFile(srcSkill, "utf-8");

  const refsDir = join(SKILLS_ROOT, skillDir, "references");
  try {
    const refFiles = await readdir(refsDir);
    for (const refFile of refFiles.sort()) {
      if (!refFile.endsWith(".md")) continue;
      const refContent = await readFile(join(refsDir, refFile), "utf-8");
      content += `\n\n---\n\n<!-- Reference: ${refFile} -->\n\n${refContent}`;
    }
  } catch {
    // No references directory — fine.
  }
  return content;
}

async function isDir(p) {
  try {
    return (await stat(p)).isDirectory();
  } catch {
    return false;
  }
}

async function fileEquals(path, expected) {
  try {
    return (await readFile(path, "utf-8")) === expected;
  } catch {
    return false; // missing → counts as changed
  }
}

// Sync skills + agents into ONE project. Returns a per-target report.
async function syncTarget(projectRoot, { check }) {
  const claudeDir = join(projectRoot, ".claude");
  const commandsDir = join(claudeDir, "commands");
  const agentsDir = join(claudeDir, "agents");

  const report = { projectRoot, commandsChanged: [], agentsChanged: [], skipped: false };

  // A target must already be a project (have a .claude/ or bober.config.json).
  // We never create .claude from scratch here — that's init's job.
  if (!(await isDir(claudeDir)) && !(await fileEquals(join(projectRoot, "bober.config.json"), "__never__"))) {
    // bober.config.json may exist even if .claude doesn't; tolerate either.
    if (!(await isDir(claudeDir))) {
      const hasCfg = await readFile(join(projectRoot, "bober.config.json"), "utf-8").then(() => true).catch(() => false);
      if (!hasCfg) {
        report.skipped = true;
        report.reason = "no .claude/ and no bober.config.json — not an agent-bober project";
        return report;
      }
    }
  }

  const skillMap = await buildSkillMap();

  // ── Commands (inlined skills) ──────────────────────────────────────
  if (!check) await mkdir(commandsDir, { recursive: true });
  for (const [skillDir, commandFile] of Object.entries(skillMap)) {
    let content;
    try {
      content = await inlineSkill(skillDir);
    } catch {
      continue; // SKILL.md missing — skip, mirrors init's behaviour
    }
    const dest = join(commandsDir, commandFile);
    if (!(await fileEquals(dest, content))) {
      report.commandsChanged.push(commandFile);
      if (!check) await writeFile(dest, content, "utf-8");
    }
  }

  // ── Agents (verbatim) ──────────────────────────────────────────────
  if (!check) await mkdir(agentsDir, { recursive: true });
  let agentFiles = [];
  try {
    agentFiles = await readdir(AGENTS_ROOT);
  } catch {
    /* no agents dir in package — unusual but tolerate */
  }
  for (const agentFile of agentFiles) {
    if (!agentFile.endsWith(".md")) continue;
    const content = await readFile(join(AGENTS_ROOT, agentFile), "utf-8");
    const dest = join(agentsDir, agentFile);
    if (!(await fileEquals(dest, content))) {
      report.agentsChanged.push(agentFile);
      if (!check) await writeFile(dest, content, "utf-8");
    }
  }

  return report;
}

// Walk discoverRoots and return any initialized project (has a bober-plan.md
// command — the marker that init ran there). Bounded depth to stay safe/fast.
async function discover(roots) {
  const found = new Set();
  async function walk(dir, depth) {
    if (depth > 4) return;
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    // Initialized? marker file present.
    const marker = join(dir, ".claude", "commands", "bober-plan.md");
    if (await readFile(marker, "utf-8").then(() => true).catch(() => false)) {
      found.add(dir);
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist") continue;
      await walk(join(dir, e.name), depth + 1);
    }
  }
  for (const r of roots) await walk(r, 0);
  return [...found];
}

async function loadRegistry() {
  const raw = JSON.parse(await readFile(TARGETS_FILE, "utf-8"));
  return raw;
}

async function main() {
  const argv = process.argv.slice(2);
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const pathArgs = argv.filter((a) => !a.startsWith("--"));
  const check = flags.has("--check");
  const skillsOnly = flags.has("--skills-only") || flags.has("--no-build");

  // ── Optional: discovery mode (mutates the registry, then exits) ─────
  if (flags.has("--discover")) {
    const reg = await loadRegistry();
    const discovered = await discover(reg.discoverRoots ?? []);
    const before = new Set(reg.targets);
    for (const d of discovered) before.add(d);
    reg.targets = [...before].sort();
    await writeFile(TARGETS_FILE, JSON.stringify(reg, null, 2) + "\n", "utf-8");
    console.log(`Discovered ${discovered.length} initialized project(s); registry now has ${reg.targets.length}:`);
    for (const t of reg.targets) console.log(`  - ${t}`);
    return;
  }

  // ── 1. Build the CLI (the shared half) ─────────────────────────────
  if (!skillsOnly && !check) {
    console.log("▸ Building CLI (src → dist)…");
    execSync("npm run build", { cwd: PKG_ROOT, stdio: "inherit" });
    console.log("  ✓ dist rebuilt — every symlinked project now runs current code.\n");
  } else if (check) {
    console.log("▸ --check: dry run, nothing will be written.\n");
  } else {
    console.log("▸ --skills-only: skipping build.\n");
  }

  // ── 2. Resolve targets ─────────────────────────────────────────────
  let targets;
  if (pathArgs.length > 0) {
    targets = pathArgs.map((p) => resolve(p));
  } else {
    const reg = await loadRegistry();
    targets = reg.targets ?? [];
  }
  if (targets.length === 0) {
    console.error("No targets. Add paths to scripts/sync-targets.json or pass them as args (or run --discover).");
    process.exit(1);
  }

  // ── 3. Sync skills + agents into each target ───────────────────────
  console.log(`▸ Syncing skills + agents into ${targets.length} project(s):\n`);
  let totalChanged = 0;
  for (const t of targets) {
    const r = await syncTarget(t, { check });
    if (r.skipped) {
      console.log(`  ⊘ ${t}\n      skipped: ${r.reason}`);
      continue;
    }
    const n = r.commandsChanged.length + r.agentsChanged.length;
    totalChanged += n;
    if (n === 0) {
      console.log(`  ✓ ${t}\n      already up to date`);
    } else {
      console.log(`  ${check ? "✎" : "✓"} ${t}`);
      if (r.commandsChanged.length) console.log(`      commands ${check ? "would update" : "updated"}: ${r.commandsChanged.length} (${r.commandsChanged.slice(0, 5).join(", ")}${r.commandsChanged.length > 5 ? ", …" : ""})`);
      if (r.agentsChanged.length) console.log(`      agents ${check ? "would update" : "updated"}: ${r.agentsChanged.length} (${r.agentsChanged.join(", ")})`);
    }
  }

  console.log(
    `\n${check ? "Drift check complete" : "Sync complete"}: ${totalChanged} file(s) ${check ? "out of date" : "written"} across ${targets.length} project(s).`,
  );
  if (check && totalChanged > 0) process.exitCode = 1; // CI-friendly: drift → nonzero
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
