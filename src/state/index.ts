import { join } from "node:path";
import { ensureDir } from "./helpers.js";

export {
  saveContract,
  loadContract,
  listContracts,
  updateContract,
} from "./sprint-state.js";

export {
  saveSpec,
  loadSpec,
  loadLatestSpec,
  listSpecs,
} from "./plan-state.js";

export {
  // Zod schemas
  PhaseSchema,
  HistoryEntrySchema,
  // Types
  type Phase,
  type HistoryEntry,
  // Functions
  appendHistory,
  loadHistory,
  updateProgress,
} from "./history.js";

export {
  saveResearch,
  readResearch,
  listResearch,
} from "./research-state.js";

export {
  saveDesign,
  readDesign,
} from "./design-state.js";

export {
  saveOutline,
  readOutline,
} from "./outline-state.js";

export {
  saveArchitecture,
  readArchitecture,
  saveADR,
  readADRs,
  listArchitectures,
} from "./architect-state.js";

export {
  saveBriefing,
  readBriefing,
  listBriefings,
} from "./briefing-state.js";

const BOBER_DIR = ".bober";
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings"] as const;

/**
 * Ensure the `.bober/` directory and all required subdirectories exist,
 * including the `research/` subdirectory for research documents.
 */
export async function ensureBoberDir(projectRoot: string): Promise<void> {
  const boberRoot = join(projectRoot, BOBER_DIR);
  await ensureDir(boberRoot);

  for (const sub of SUBDIRS) {
    await ensureDir(join(boberRoot, sub));
  }
}
