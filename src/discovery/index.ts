/**
 * Barrel exports for src/discovery.
 *
 * Public surface:
 * - scanProject() -- the main orchestration function
 * - DiscoveryReport and all sub-types
 * - Individual sub-scanner functions (for selective use or testing)
 */

export { scanProject } from "./scanner.js";
export { synthesizePrinciples, validatePrinciplesMarkdown } from "./synthesizer.js";

export type {
  DiscoveryReport,
  PackageScriptsReport,
  BoberCommandCategory,
  CommandMapping,
  CIChecksReport,
  CIWorkflow,
  CIStep,
  CICategory,
  GitConventionsReport,
  CodeConventionsReport,
  FileNamingStyle,
  FileNamingReport,
  ImportStyleReport,
  ExportStyleReport,
  TypeScriptPatternsReport,
  TestConventionsReport,
  TestFramework,
  MockingLibrary,
  DocumentationReport,
  DocFile,
  DetectedStackReport,
} from "./types.js";

// Sub-scanners exported individually for selective use
export { scanPackageScripts } from "./scanners/package-scripts.js";
export { scanCIChecks } from "./scanners/ci-checks.js";
export { scanGitConventions } from "./scanners/git-conventions.js";
export { scanCodeConventions } from "./scanners/code-conventions.js";
export { scanTestConventions } from "./scanners/test-conventions.js";
export { scanDocumentation } from "./scanners/documentation.js";
