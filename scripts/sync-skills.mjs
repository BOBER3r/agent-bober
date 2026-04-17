#!/usr/bin/env node
// Reverse-inline: take a `.claude/commands/<skill>.md` (which is SKILL.md +
// inlined references concatenated by `agent-bober init`) and split it back
// into `skills/<skill>/SKILL.md` + `skills/<skill>/references/<name>.md`.
//
// Idempotent and safe: writes only inside `skills/`. Strips trailing
// `--- + blank line + <!-- Reference: ... -->` separator that init.ts adds
// when concatenating.
//
// Usage:  node scripts/sync-skills.mjs <skill-key>:<command-file> ...
//   e.g.: node scripts/sync-skills.mjs bober.plan:bober-plan.md \
//                                     bober.run:bober-run.md \
//                                     bober.sprint:bober-sprint.md

import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, dirname } from "node:path";

const REF_RE = /\n+---\n+<!-- Reference: ([^>]+?) -->\n+/g;

async function syncSkill(skillKey, cmdFile) {
  const localPath = join(".claude/commands", cmdFile);
  const content = await readFile(localPath, "utf-8");

  // Split the file at every "<!-- Reference: foo.md -->" marker, capturing
  // the filename. The first segment is SKILL.md; subsequent segments are
  // each named reference, in order.
  const parts = [];
  let lastIdx = 0;
  let lastName = null;
  let m;
  REF_RE.lastIndex = 0;
  while ((m = REF_RE.exec(content)) !== null) {
    parts.push({ name: lastName, body: content.slice(lastIdx, m.index) });
    lastName = m[1].trim();
    lastIdx = m.index + m[0].length;
  }
  parts.push({ name: lastName, body: content.slice(lastIdx) });

  const skillDir = join("skills", skillKey);
  const refDir = join(skillDir, "references");

  // Write SKILL.md (the first part, name === null)
  const head = parts[0];
  if (head.name !== null) {
    throw new Error(`First segment of ${cmdFile} should be SKILL.md, got reference ${head.name}`);
  }
  // Trim trailing whitespace so SKILL.md doesn't grow with stray newlines
  const headBody = head.body.replace(/\s+$/, "") + "\n";
  await writeFile(join(skillDir, "SKILL.md"), headBody, "utf-8");
  console.log(`  ${skillKey}/SKILL.md  (${headBody.split("\n").length} lines)`);

  // Write references — dedupe by name (some files have duplicate refs from
  // bad re-inits; the last copy wins, but we warn).
  const seen = new Map();
  for (const p of parts.slice(1)) {
    if (!p.name) continue;
    if (seen.has(p.name)) {
      console.warn(`  ⚠ duplicate reference ${p.name} in ${cmdFile} — last copy wins`);
    }
    seen.set(p.name, p.body);
  }

  if (seen.size > 0) {
    await mkdir(refDir, { recursive: true });
    for (const [name, body] of seen) {
      const trimmed = body.replace(/^\s+|\s+$/g, "") + "\n";
      await writeFile(join(refDir, name), trimmed, "utf-8");
      console.log(`  ${skillKey}/references/${name}  (${trimmed.split("\n").length} lines)`);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  if (args.length === 0) {
    console.error("Usage: node scripts/sync-skills.mjs <skillKey>:<commandFile> ...");
    process.exit(1);
  }

  for (const arg of args) {
    const [skillKey, cmdFile] = arg.split(":");
    if (!skillKey || !cmdFile) {
      console.error(`Bad arg "${arg}" — expected <skillKey>:<commandFile>`);
      process.exit(1);
    }
    console.log(`Syncing ${skillKey} from .claude/commands/${cmdFile}:`);
    await syncSkill(skillKey, cmdFile);
  }

  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
