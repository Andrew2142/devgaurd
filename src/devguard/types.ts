/** Supported git scopes that DevGuard tools can inspect. */
export type GitTargetMode = "latest-commit" | "working-tree" | "custom";

/** Persisted run kinds, including public tools and compatibility aliases. */
export type RunKind =
  | "lint_code"
  | "scan_dependencies"
  | "test_changes"
  | "run_full_review"
  | "scan_code";

/** Lifecycle states stored for a DevGuard run. */
export type RunStatus =
  | "queued"
  | "collecting_git"
  | "generating_tests"
  | "running_tests"
  | "linting_code"
  | "scanning_code"
  | "scanning_dependencies"
  | "completed"
  | "failed";

/** One human-readable progress entry attached to a run. */
export type ProgressEntry = {
  step: string;
  message: string;
  ts: string;
  status: "active" | "done";
};

/** Metadata for an artifact written under the run artifact directory. */
export type GeneratedArtifact = {
  type: string;
  label: string;
  filename: string;
};

/** Shared MCP input shape for tools that start a run. */
export type RunInput = {
  repo_path?: string;
  git_target?: GitTargetMode;
  git_ref_or_range?: string;
  prompt?: string;
  model?: string;
};

/** Result of the generated test workflow and its execution output. */
export type TestsResult = {
  status: "passed" | "failed" | "not_run";
  testCommand: string | null;
  planSummary?: string;
  planText?: string;
  frameworkGuess?: string;
  generatedFiles?: Array<{ path: string; content: string }>;
  stdout?: string;
  stderr?: string;
  exitCode?: number | null;
  passedCount?: number | null;
  failedCount?: number | null;
  skippedCount?: number | null;
};

/** One normalized lint, consistency, or security finding. */
export type LintFinding = {
  tier: number;
  category: string;
  rule: string;
  severity: "error" | "warning" | "info";
  message: string;
  filePath: string;
  line: number | null;
  column: number | null;
  source: string;
  snippet: string | null;
};

/** Backward-compatible alias for older code-scan naming. */
export type CodeFinding = LintFinding;

/** One dependency vulnerability finding returned from OSV data. */
export type DependencyFinding = {
  packageName: string;
  version: string;
  direct: boolean;
  devDependency: boolean;
  advisoryId: string;
  summary: string;
  severity: string;
  aliases: string[];
  references: string[];
};

/** Registry metadata signal for one locked dependency version. */
export type DependencyPackageSignal = {
  packageName: string;
  version: string;
  direct: boolean;
  devDependency: boolean;
  registry: {
    checked: boolean;
    found: boolean;
    deprecated: boolean;
    hasInstallScript: boolean;
    hasRegistrySignature: boolean;
    integrity: string | null;
    tarball: string | null;
    error: string | null;
  };
  riskFlags: string[];
};

/** Result of npm registry signature/provenance verification. */
export type DependencySignatureAudit = {
  status: "passed" | "failed" | "skipped" | "unavailable";
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  message: string;
};

/** Structured dependency report with vulnerability, registry, and signature details. */
export type DependencyReport = {
  checkedAt: string;
  summary: string;
  sources: string[];
  signatureAudit: DependencySignatureAudit;
  packageSignals: DependencyPackageSignal[];
  riskCount: number;
};

/** Complete dependency scan result returned by scan_dependencies. */
export type DependencyScanResult = {
  dependencyCount: number;
  vulnerabilityCount: number;
  findings: DependencyFinding[];
  report?: DependencyReport;
};

/** Full persisted run state exposed by status and dashboard APIs. */
export type StoredRun = {
  id: number;
  kind: RunKind;
  status: RunStatus;
  repoPath: string;
  gitTarget: GitTargetMode;
  gitRefOrRange: string | null;
  model: string | null;
  dashboardUrl: string;
  summary: string;
  error: string | null;
  startedAt: string;
  completedAt: string | null;
  createdAt: string;
  updatedAt: string;
  progressLog: ProgressEntry[];
  gitContext: Record<string, unknown> | null;
  testsResult: TestsResult | null;
  lintFindings: LintFinding[];
  dependencyFindings: DependencyFinding[];
  generatedArtifacts: GeneratedArtifact[];
  metadata: Record<string, unknown>;
};

/** Compact response returned immediately after a run is queued. */
export type RunSummary = {
  run_id: number;
  status: RunStatus;
  dashboard_url: string;
  started_at: string;
  summary: string;
};

/** One local environment check returned by devgaurd doctor. */
export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};
