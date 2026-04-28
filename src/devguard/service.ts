import fs from "node:fs";
import path from "node:path";
import { ArtifactManager } from "./artifacts";
import { DevGuardConfig } from "./config";
import { DashboardServer } from "./dashboard";
import { renderDependencyReportMarkdown, runDependencyScan, runLintScan } from "./scanners";
import { DevGuardStore } from "./storage";
import {
  DependencyScanResult,
  GeneratedArtifact,
  LintFinding,
  RunInput,
  RunKind,
  RunSummary,
  StoredRun,
  TestsResult,
} from "./types";
import { CodexPassResult, CodexRunnerService, TestPlanPayload } from "../services/codex-runner-service";
import { toErrorMessage } from "./errors";

/** Project and git context collected before a workflow executes. */
type CollectedRunContext = {
  repoPath: string;
  profile: ReturnType<CodexRunnerService["detectProjectProfile"]>;
  git: Awaited<ReturnType<CodexRunnerService["getGitContextAsync"]>> | null;
  changedFiles: string[];
};

const MAX_CODEX_DIAGNOSTIC_CHARS = 1600;
const CODEX_DIAGNOSTIC_HEAD_CHARS = 1200;

/** Coordinates DevGuard tool runs, persistence, artifacts, dashboard links, and background jobs. */
export class DevGuardService {
  private runner: CodexRunnerService;
  private artifacts: ArtifactManager;
  private activeJobs = new Map<number, Promise<void>>();

  /** Creates a service instance backed by local storage and a dashboard server. */
  constructor(
    private config: DevGuardConfig,
    private store: DevGuardStore,
    private dashboard: DashboardServer,
  ) {
    this.runner = new CodexRunnerService({ codexHome: config.codexHome });
    this.artifacts = new ArtifactManager(config);
  }

  /** Queues the full review workflow: generated tests, lint checks, and dependency scanning. */
  async startFullReview(input: RunInput): Promise<RunSummary> {
    return this.startJob("run_full_review", input, (run) => this.executeFullReview(run));
  }

  /** Queues lint/static analysis for a repository. */
  async startLintCode(input: RunInput): Promise<RunSummary> {
    return this.startJob("lint_code", input, (run) => this.executeLintCodeOnly(run));
  }

  /** Backward-compatible entrypoint for clients that still use scan_code naming. */
  async startCodeScan(input: RunInput): Promise<RunSummary> {
    return this.startLintCode(input);
  }

  /** Queues dependency vulnerability and package-risk scanning for a repository. */
  async startDependencyScan(input: RunInput): Promise<RunSummary> {
    return this.startJob("scan_dependencies", input, (run) => this.executeDependencyScanOnly(run));
  }

  /** Queues generated test planning, test-file generation, and ephemeral execution. */
  async startTestChanges(input: RunInput): Promise<RunSummary> {
    return this.startJob("test_changes", {
      ...input,
      git_target: input.git_target || "working-tree",
    }, (run) => this.executeTestChangesOnly(run));
  }

  /** Returns the current persisted run state or throws when the run is missing. */
  getRunStatus(runId: number): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return run;
  }

  /** Returns final or in-progress run details for compatibility with older clients. */
  getRunResults(runId: number): StoredRun {
    return this.getRunStatus(runId);
  }

  /** Waits for an active in-process job to finish and then returns its persisted state. */
  async waitForRun(runId: number): Promise<StoredRun> {
    const job = this.activeJobs.get(runId);
    if (job) {
      await job;
    }
    return this.getRunStatus(runId);
  }

  /** Writes generated test files from a completed run into the real repository. */
  async commitGeneratedTests(runId: number): Promise<{ run_id: number; committed_files: string[] }> {
    const run = this.getRunStatus(runId);
    const generatedFiles = run.testsResult?.generatedFiles || [];
    if (generatedFiles.length === 0) {
      throw new Error("Run has no generated test files to apply");
    }

    const validated = this.runner.validateGeneratedFileTargets(run.repoPath, "node", generatedFiles);
    if (validated.rejected.length > 0) {
      throw new Error(`Refusing to apply rejected file targets: ${validated.rejected.map((item) => item.path).join(", ")}`);
    }

    const written = this.runner.writeAcceptedFiles(
      run.repoPath,
      validated.accepted.map((item) => ({ path: item.path, content: item.content })),
    );

    this.store.appendProgress(runId, "commit_generated_tests", `Wrote ${written.length} generated test files to the repository`);
    return { run_id: runId, committed_files: written };
  }

  /** Backward-compatible alias for commitGeneratedTests with the older response key. */
  async applyGeneratedTests(runId: number): Promise<{ run_id: number; applied_files: string[] }> {
    const result = await this.commitGeneratedTests(runId);
    return { run_id: result.run_id, applied_files: result.committed_files };
  }

  /** Creates a persisted run and starts the provided executor in the background. */
  private async startJob(
    kind: RunKind,
    input: RunInput,
    executor: (run: StoredRun) => Promise<void>,
  ): Promise<RunSummary> {
    await this.dashboard.ensureStarted();
    const repoPath = this.resolveRepoPath(input.repo_path);
    const gitTarget = input.git_target || "latest-commit";
    const model = input.model || this.config.defaultModel;
    const run = this.store.createRun({
      kind,
      status: "queued",
      repoPath,
      gitTarget,
      gitRefOrRange: input.git_ref_or_range || null,
      model,
      dashboardUrl: this.dashboard.getRunUrl(0),
      summary: this.buildQueuedSummary(kind, repoPath),
      metadata: {
        prompt: input.prompt || "",
      },
    });

    const finalRun = this.store.updateRun(run.id, {
      dashboardUrl: this.dashboard.getRunUrl(run.id),
      metadata: {
        prompt: input.prompt || "",
      },
    });

    this.store.appendProgress(finalRun.id, "queued", "Run created and waiting to start", "active");
    if (!this.dashboard.isAvailable()) {
      this.store.appendProgress(
        finalRun.id,
        "dashboard_unavailable",
        this.dashboard.getStartupError() || "Dashboard could not be started; MCP results remain available",
      );
    }
    this.store.updateRun(finalRun.id, {
      summary: this.buildQueuedSummary(kind, repoPath),
      metadata: {
        prompt: input.prompt || "",
        dashboardAvailable: this.dashboard.isAvailable(),
        dashboardError: this.dashboard.getStartupError(),
      },
    });

    const job = executor(this.getRunStatus(finalRun.id))
      .catch((error) => this.failRun(finalRun.id, toErrorMessage(error)))
      .finally(() => {
        this.activeJobs.delete(finalRun.id);
      });
    this.activeJobs.set(finalRun.id, job);

    const started = this.getRunStatus(finalRun.id);
    return {
      run_id: started.id,
      status: started.status,
      dashboard_url: started.dashboardUrl,
      started_at: started.startedAt,
      summary: started.summary,
    };
  }

  /** Executes the full end-to-end review workflow for one run. */
  private async executeFullReview(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run);
    const testsResult = await this.runTestWorkflow(run.id, context);
    const lintFindings = await this.runLintWorkflow(run.id, context.repoPath, context.changedFiles);
    const dependencyResult = await this.runDependencyWorkflow(run.id, context.repoPath);

    const summary = [
      `Full review completed for ${path.basename(context.repoPath)}`,
      `tests: ${testsResult.status}`,
      `lint findings: ${lintFindings.length}`,
      `dependency vulnerabilities: ${dependencyResult.vulnerabilityCount}`,
      `dependency risk signals: ${dependencyResult.report?.riskCount ?? 0}`,
    ].join(" | ");

    this.store.updateRun(run.id, {
      status: "completed",
      summary,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Full review completed");
  }

  /** Executes only the lint/static-analysis workflow for one run. */
  private async executeLintCodeOnly(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run, false);
    const lintFindings = await this.runLintWorkflow(run.id, context.repoPath, context.changedFiles);
    this.store.updateRun(run.id, {
      status: "completed",
      summary: `Lint completed with ${lintFindings.length} findings`,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Lint completed");
  }

  /** Executes only the dependency scanning workflow for one run. */
  private async executeDependencyScanOnly(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run, false);
    const dependencyResult = await this.runDependencyWorkflow(run.id, context.repoPath);
    this.store.updateRun(run.id, {
      status: "completed",
      summary: `Dependency scan completed with ${dependencyResult.vulnerabilityCount} vulnerability findings and ${dependencyResult.report?.riskCount ?? 0} package risk signals`,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Dependency scan completed");
  }

  /** Executes only the generated-test workflow for one run. */
  private async executeTestChangesOnly(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run);
    const testsResult = await this.runTestWorkflow(run.id, context);
    this.store.updateRun(run.id, {
      status: "completed",
      summary: `Test run completed with status ${testsResult.status}`,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Test workflow completed");
  }

  /** Collects project profile and optional git diff context for a run. */
  private async collectContext(run: StoredRun, withGit = true): Promise<CollectedRunContext> {
    this.store.updateRun(run.id, { status: "collecting_git" });
    this.store.appendProgress(run.id, "collecting_git", "Resolving repository and project profile", "active");
    const profile = this.runner.detectProjectProfile(run.repoPath);
    if (profile.ecosystem !== "node") {
      throw new Error(`Unsupported ecosystem for v1: ${profile.ecosystem}`);
    }

    const git = withGit
      ? await this.runner.getGitContextAsync(
        run.repoPath,
        run.gitTarget,
        run.gitRefOrRange || undefined,
      )
      : null;

    this.store.updateRun(run.id, {
      gitContext: git as unknown as Record<string, unknown> | null,
      metadata: {
        ...run.metadata,
        projectProfile: profile,
      },
    });
    this.store.appendProgress(run.id, "collecting_git_complete", "Repository context collected");

    return {
      repoPath: run.repoPath,
      profile,
      git,
      changedFiles: git?.changedFiles || [],
    };
  }

  /** Plans, generates, writes, and runs tests inside an ephemeral workspace. */
  private async runTestWorkflow(
    runId: number,
    context: CollectedRunContext,
  ): Promise<TestsResult> {
    const codexBin = this.runner.resolveCodexExecutable();
    if (!codexBin) {
      throw new Error("Codex binary not found. Run `devgaurd doctor` for setup details.");
    }

    const login = await this.runner.checkCodexLoginAsync(codexBin);
    if (!login.ok) {
      throw new Error(`Codex login check failed: ${login.output}`);
    }

    const testCommand = context.profile.command;
    if (!testCommand) {
      throw new Error("No supported test command detected for this repository");
    }

    if (!context.git) {
      throw new Error("Git context is required for test generation");
    }

    this.store.updateRun(runId, { status: "generating_tests" });
    this.store.appendProgress(runId, "generating_tests", "Planning and generating tests from the git diff", "active");

    const run = this.getRunStatus(runId);
    const prompt = this.runner.buildPlanPrompt({
      projectName: context.profile.packageSummary.name,
      projectProfile: context.profile,
      git: context.git,
      brief: "",
      notes: typeof run.metadata.prompt === "string" ? run.metadata.prompt : "",
      testCommand,
    });

    const planPass = await this.runner.runPlanPassAsync({
      codexBin,
      model: run.model || this.config.defaultModel,
      projectPath: context.repoPath,
      prompt,
    });
    if (planPass.status !== 0 || !planPass.payload) {
      throw new Error(formatCodexPassFailure("Planning pass", planPass));
    }
    const planErrors = this.runner.validatePlanPayload(planPass.payload);
    if (planErrors.length > 0) {
      throw new Error(`Planning payload invalid: ${planErrors.join("; ")}`);
    }
    const planPayload = planPass.payload as TestPlanPayload;

    const planArtifacts: GeneratedArtifact[] = [
      this.artifacts.saveJson(runId, "plan.json", planPass.payload),
      this.artifacts.saveText(runId, "plan.stdout.txt", planPass.stdout || ""),
      this.artifacts.saveText(runId, "plan.stderr.txt", planPass.stderr || ""),
    ];
    this.appendGeneratedArtifacts(runId, planArtifacts);
    this.store.appendProgress(runId, "planning_complete", `Planned ${planPayload.proposed_test_files.length} test file targets`);

    const workspacePath = this.runner.createEphemeralWorkspace(context.repoPath);
    try {
      this.store.appendProgress(runId, "generating_test_files", "Generating focused test files in an ephemeral workspace", "active");
      const generationPrompt = this.runner.buildGenerationPrompt({
        projectName: context.profile.packageSummary.name,
        projectProfile: context.profile,
        git: context.git,
        testCommand,
        plan: {
          summary: planPayload.summary,
          plan_text: planPayload.plan_text,
          proposed_test_files: planPayload.proposed_test_files,
        },
      });

      const generationPass = await this.runner.runGenerationPassAsync({
        codexBin,
        model: run.model || this.config.defaultModel,
        projectPath: workspacePath,
        prompt: generationPrompt,
        skipGitRepoCheck: true,
      });
      const generationArtifacts: GeneratedArtifact[] = [
        this.artifacts.saveText(runId, "generation.stdout.txt", generationPass.stdout || ""),
        this.artifacts.saveText(runId, "generation.stderr.txt", generationPass.stderr || ""),
      ];
      if (generationPass.status !== 0 || !generationPass.payload) {
        this.appendGeneratedArtifacts(runId, generationArtifacts);
        throw new Error(formatCodexPassFailure("Generation pass", generationPass));
      }
      this.appendGeneratedArtifacts(runId, generationArtifacts);

      const payloadValidation = this.runner.validateGeneratedFilesPayload(generationPass.payload);
      if (payloadValidation.errors.length > 0) {
        throw new Error(`Generated test payload invalid: ${payloadValidation.errors.join("; ")}`);
      }

      const validated = this.runner.validateGeneratedFileTargets(workspacePath, "node", payloadValidation.files);
      if (validated.rejected.length > 0) {
        throw new Error(`Generated rejected paths: ${validated.rejected.map((item) => `${item.path} (${item.reason})`).join(", ")}`);
      }
      if (validated.accepted.length === 0) {
        throw new Error("No accepted test files were generated");
      }

      this.runner.writeAcceptedFiles(
        workspacePath,
        validated.accepted.map((item) => ({ path: item.path, content: item.content })),
      );

      this.appendGeneratedArtifacts(runId, [
        this.artifacts.saveJson(runId, "generated-tests.json", validated.accepted.map((item) => ({ path: item.path, content: item.content }))),
      ]);
      this.store.appendProgress(runId, "generating_test_files_complete", `Generated ${validated.accepted.length} accepted test files`);

      this.store.updateRun(runId, { status: "running_tests" });
      this.store.appendProgress(runId, "running_tests", `Executing ${testCommand}`, "active");
      const execution = await this.runner.runTestCommandAsync(workspacePath, testCommand);
      this.artifacts.saveText(runId, "tests.stdout.txt", execution.stdout || "");
      this.artifacts.saveText(runId, "tests.stderr.txt", execution.stderr || "");

      const testsResult: TestsResult = {
        status: execution.status === 0 ? "passed" : "failed",
        testCommand,
        planSummary: planPayload.summary,
        planText: planPayload.plan_text,
        frameworkGuess: planPayload.framework_guess || "",
        generatedFiles: validated.accepted.map((item) => ({ path: item.path, content: item.content })),
        stdout: execution.stdout,
        stderr: execution.stderr,
        exitCode: execution.status,
        passedCount: execution.summary.passedCount,
        failedCount: execution.summary.failedCount,
        skippedCount: execution.summary.skippedCount,
      };

      this.store.updateRun(runId, {
        testsResult,
        generatedArtifacts: [
          ...this.getRunStatus(runId).generatedArtifacts,
          { type: "text", label: "tests.stdout.txt", filename: "tests.stdout.txt" },
          { type: "text", label: "tests.stderr.txt", filename: "tests.stderr.txt" },
        ],
      });
      this.store.appendProgress(runId, "running_tests_complete", `Test command exited with ${execution.status ?? "unknown"}`);

      return testsResult;
    } finally {
      this.runner.cleanupWorkspace(workspacePath);
    }
  }

  /** Runs lint/static checks, persists findings, and writes a JSON artifact. */
  private async runLintWorkflow(runId: number, repoPath: string, changedFiles: string[]): Promise<LintFinding[]> {
    this.store.updateRun(runId, { status: "linting_code" });
    this.store.appendProgress(runId, "linting_code", "Running lint and static code checks", "active");
    const findings = await runLintScan(repoPath, changedFiles);
    this.store.updateRun(runId, {
      lintFindings: findings,
    });
    this.artifacts.saveJson(runId, "lint-findings.json", findings);
    this.store.updateRun(runId, {
      generatedArtifacts: [
        ...this.getRunStatus(runId).generatedArtifacts,
        { type: "json", label: "lint-findings.json", filename: "lint-findings.json" },
      ],
    });
    this.store.appendProgress(runId, "linting_code_complete", `Lint found ${findings.length} findings`);
    return findings;
  }

  /** Runs dependency checks, persists findings, and writes JSON and markdown reports. */
  private async runDependencyWorkflow(runId: number, repoPath: string): Promise<DependencyScanResult> {
    this.store.updateRun(runId, { status: "scanning_dependencies" });
    this.store.appendProgress(runId, "scanning_dependencies", "Running dependency vulnerability scan", "active");
    const result = await runDependencyScan(repoPath, this.store);
    const run = this.getRunStatus(runId);
    this.store.updateRun(runId, {
      dependencyFindings: result.findings,
      metadata: {
        ...run.metadata,
        dependencyPackages: result.report?.packageSignals || [],
        dependencySummary: {
          dependencyCount: result.dependencyCount,
          vulnerabilityCount: result.vulnerabilityCount,
          riskCount: result.report?.riskCount ?? 0,
          checkedAt: result.report?.checkedAt || null,
          signatureAuditStatus: result.report?.signatureAudit.status || null,
        },
      },
    });
    this.artifacts.saveJson(runId, "dependency-report.json", result);
    this.artifacts.saveText(runId, "dependency-report.md", renderDependencyReportMarkdown(result));
    this.store.updateRun(runId, {
      generatedArtifacts: [
        ...this.getRunStatus(runId).generatedArtifacts,
        { type: "json", label: "dependency-report.json", filename: "dependency-report.json" },
        { type: "text", label: "dependency-report.md", filename: "dependency-report.md" },
      ],
    });
    this.store.appendProgress(runId, "scanning_dependencies_complete", `Dependency scan found ${result.vulnerabilityCount} vulnerability findings and ${result.report?.riskCount ?? 0} package risk signals`);
    return result;
  }

  /** Marks a run as failed while keeping the error visible in status and progress output. */
  private async failRun(runId: number, message: string): Promise<void> {
    this.store.updateRun(runId, {
      status: "failed",
      error: message,
      summary: message,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(runId, "failed", message);
  }

  /** Appends generated artifact metadata to a run without losing artifacts from earlier phases. */
  private appendGeneratedArtifacts(runId: number, artifacts: GeneratedArtifact[]): void {
    if (artifacts.length === 0) {
      return;
    }

    this.store.updateRun(runId, {
      generatedArtifacts: [...this.getRunStatus(runId).generatedArtifacts, ...artifacts],
    });
  }

  /** Resolves and validates the repository path for a run input. */
  private resolveRepoPath(repoPath?: string): string {
    const target = repoPath ? path.resolve(repoPath) : process.cwd();
    if (!fs.existsSync(target)) {
      throw new Error(`Repository path does not exist: ${target}`);
    }
    return target;
  }

  /** Builds the initial run summary shown before background work completes. */
  private buildQueuedSummary(kind: RunKind, repoPath: string): string {
    return `Queued ${kind} for ${repoPath}`;
  }
}

/** Builds a concise error message for a failed Codex planning or generation pass. */
function formatCodexPassFailure(label: string, pass: CodexPassResult<unknown>): string {
  const fields = [
    `${label} failed`,
    pass.failureCategory ? `category=${pass.failureCategory}` : null,
    pass.timeout ? `timeout after ${Math.round(pass.durationMs / 1000)}s` : null,
    pass.status !== null ? `exit=${pass.status}` : null,
    pass.signal ? `signal=${pass.signal}` : null,
    pass.parseError ? `parseError=${pass.parseError}` : null,
  ].filter((field): field is string => Boolean(field));
  const diagnostic = extractUsefulCodexOutput(pass);

  return diagnostic ? `${fields.join("; ")}\n${diagnostic}` : fields.join("; ");
}

/** Extracts useful Codex output while suppressing recurring plugin and personality warnings. */
function extractUsefulCodexOutput(pass: CodexPassResult<unknown>): string | null {
  const lines = `${pass.stderr}\n${pass.stdout}`
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !isNoisyCodexWarning(line));
  const text = lines.join("\n").trim();

  if (!text) {
    return null;
  }

  return text.length > MAX_CODEX_DIAGNOSTIC_CHARS
    ? `${text.slice(0, CODEX_DIAGNOSTIC_HEAD_CHARS)}\n...output truncated...`
    : text;
}

/** Returns whether a Codex stderr line is a known warning that hides the actionable failure. */
function isNoisyCodexWarning(line: string): boolean {
  return (
    line.includes("WARN codex_core_plugins::manifest")
    || line.includes("WARN codex_protocol::openai_models")
  );
}
