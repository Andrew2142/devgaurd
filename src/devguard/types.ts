export type GitTargetMode = "latest-commit" | "working-tree" | "custom";

export type RunKind =
  | "run_full_review"
  | "scan_code"
  | "scan_dependencies"
  | "test_changes";

export type RunStatus =
  | "queued"
  | "collecting_git"
  | "generating_tests"
  | "running_tests"
  | "scanning_code"
  | "scanning_dependencies"
  | "completed"
  | "failed";

export type ProgressEntry = {
  step: string;
  message: string;
  ts: string;
  status: "active" | "done";
};

export type GeneratedArtifact = {
  type: string;
  label: string;
  filename: string;
};

export type RunInput = {
  repo_path?: string;
  git_target?: GitTargetMode;
  git_ref_or_range?: string;
  prompt?: string;
  model?: string;
};

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

export type CodeFinding = {
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

export type DependencyScanResult = {
  dependencyCount: number;
  vulnerabilityCount: number;
  findings: DependencyFinding[];
};

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
  codeFindings: CodeFinding[];
  dependencyFindings: DependencyFinding[];
  generatedArtifacts: GeneratedArtifact[];
  metadata: Record<string, unknown>;
};

export type RunSummary = {
  run_id: number;
  status: RunStatus;
  dashboard_url: string;
  started_at: string;
  summary: string;
};

export type DoctorCheck = {
  name: string;
  ok: boolean;
  message: string;
};
