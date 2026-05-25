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

export {
  saveReview,
  readReview,
  listReviews,
} from "./review-state.js";

export {
  savePending,
  readPending,
  listPending,
  saveApproved,
  saveRejected,
  deletePending,
  pendingExists,
  type PendingMarker,
  type ApprovedMarker,
  type RejectedMarker,
} from "./approval-state.js";

const BOBER_DIR = ".bober";
const SUBDIRS = ["contracts", "specs", "research", "designs", "outlines", "architecture", "briefings", "reviews", "approvals"] as const;

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
