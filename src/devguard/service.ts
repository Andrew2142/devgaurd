import fs from "fs";
import path from "path";
import { ArtifactManager } from "./artifacts";
import { DevGuardConfig } from "./config";
import { DashboardServer } from "./dashboard";
import { runCodeScan, runDependencyScan } from "./scanners";
import { DevGuardStore } from "./storage";
import {
  GeneratedArtifact,
  RunInput,
  RunKind,
  RunSummary,
  StoredRun,
  TestsResult,
} from "./types";
import { CodexRunnerService } from "../services/codex-runner-service";
import { toErrorMessage } from "./errors";

export class DevGuardService {
  private runner = new CodexRunnerService();
  private artifacts: ArtifactManager;
  private activeJobs = new Map<number, Promise<void>>();

  constructor(
    private config: DevGuardConfig,
    private store: DevGuardStore,
    private dashboard: DashboardServer,
  ) {
    this.artifacts = new ArtifactManager(config);
  }

  async startFullReview(input: RunInput): Promise<RunSummary> {
    return this.startJob("run_full_review", input, (run) => this.executeFullReview(run));
  }

  async startCodeScan(input: RunInput): Promise<RunSummary> {
    return this.startJob("scan_code", input, (run) => this.executeCodeScanOnly(run));
  }

  async startDependencyScan(input: RunInput): Promise<RunSummary> {
    return this.startJob("scan_dependencies", input, (run) => this.executeDependencyScanOnly(run));
  }

  async startTestChanges(input: RunInput): Promise<RunSummary> {
    return this.startJob("test_changes", input, (run) => this.executeTestChangesOnly(run));
  }

  getRunStatus(runId: number): StoredRun {
    const run = this.store.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }
    return run;
  }

  getRunResults(runId: number): StoredRun {
    return this.getRunStatus(runId);
  }

  async waitForRun(runId: number): Promise<StoredRun> {
    const job = this.activeJobs.get(runId);
    if (job) {
      await job;
    }
    return this.getRunStatus(runId);
  }

  async applyGeneratedTests(runId: number): Promise<{ run_id: number; applied_files: string[] }> {
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

    this.store.appendProgress(runId, "apply_generated_tests", `Applied ${written.length} generated test files`);
    return { run_id: runId, applied_files: written };
  }

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

  private async executeFullReview(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run);
    const testsResult = await this.runTestWorkflow(run.id, context);
    const codeFindings = await this.runCodeWorkflow(run.id, context.repoPath, context.changedFiles);
    const dependencyResult = await this.runDependencyWorkflow(run.id, context.repoPath);

    const summary = [
      `Full review completed for ${path.basename(context.repoPath)}`,
      `tests: ${testsResult.status}`,
      `code findings: ${codeFindings.length}`,
      `dependency findings: ${dependencyResult.vulnerabilityCount}`,
    ].join(" | ");

    this.store.updateRun(run.id, {
      status: "completed",
      summary,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Full review completed");
  }

  private async executeCodeScanOnly(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run, false);
    const codeFindings = await this.runCodeWorkflow(run.id, context.repoPath, context.changedFiles);
    this.store.updateRun(run.id, {
      status: "completed",
      summary: `Code scan completed with ${codeFindings.length} findings`,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Code scan completed");
  }

  private async executeDependencyScanOnly(run: StoredRun): Promise<void> {
    const context = await this.collectContext(run, false);
    const dependencyResult = await this.runDependencyWorkflow(run.id, context.repoPath);
    this.store.updateRun(run.id, {
      status: "completed",
      summary: `Dependency scan completed with ${dependencyResult.vulnerabilityCount} vulnerability findings`,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(run.id, "completed", "Dependency scan completed");
  }

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

  private async collectContext(run: StoredRun, withGit = true): Promise<{
    repoPath: string;
    profile: ReturnType<CodexRunnerService["detectProjectProfile"]>;
    git: Awaited<ReturnType<CodexRunnerService["getGitContextAsync"]>> | null;
    changedFiles: string[];
  }> {
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

  private async runTestWorkflow(
    runId: number,
    context: {
      repoPath: string;
      profile: ReturnType<CodexRunnerService["detectProjectProfile"]>;
      git: Awaited<ReturnType<CodexRunnerService["getGitContextAsync"]>> | null;
      changedFiles: string[];
    },
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
      throw new Error(`Planning pass failed: ${planPass.stderr || planPass.stdout || "Unknown error"}`);
    }
    const planErrors = this.runner.validatePlanPayload(planPass.payload);
    if (planErrors.length > 0) {
      throw new Error(`Planning payload invalid: ${planErrors.join("; ")}`);
    }

    const artifacts: GeneratedArtifact[] = [
      this.artifacts.saveJson(runId, "plan.json", planPass.payload),
      this.artifacts.saveText(runId, "plan.stdout.txt", planPass.stdout || ""),
      this.artifacts.saveText(runId, "plan.stderr.txt", planPass.stderr || ""),
    ];

    const workspacePath = this.runner.createEphemeralWorkspace(context.repoPath);
    try {
      const generationPrompt = this.runner.buildGenerationPrompt({
        projectName: context.profile.packageSummary.name,
        projectProfile: context.profile,
        git: context.git,
        testCommand,
        plan: {
          summary: planPass.payload.summary,
          plan_text: planPass.payload.plan_text,
          proposed_test_files: planPass.payload.proposed_test_files,
        },
      });

      const generationPass = await this.runner.runGenerationPassAsync({
        codexBin,
        model: run.model || this.config.defaultModel,
        projectPath: workspacePath,
        prompt: generationPrompt,
        skipGitRepoCheck: true,
      });
      if (generationPass.status !== 0 || !generationPass.payload) {
        throw new Error(`Generation pass failed: ${generationPass.stderr || generationPass.stdout || "Unknown error"}`);
      }

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

      artifacts.push(
        this.artifacts.saveJson(runId, "generated-tests.json", validated.accepted.map((item) => ({ path: item.path, content: item.content }))),
        this.artifacts.saveText(runId, "generation.stdout.txt", generationPass.stdout || ""),
        this.artifacts.saveText(runId, "generation.stderr.txt", generationPass.stderr || ""),
      );

      this.store.updateRun(runId, {
        generatedArtifacts: [...this.getRunStatus(runId).generatedArtifacts, ...artifacts],
      });

      this.store.updateRun(runId, { status: "running_tests" });
      this.store.appendProgress(runId, "running_tests", `Executing ${testCommand}`, "active");
      const execution = await this.runner.runTestCommandAsync(workspacePath, testCommand);
      this.artifacts.saveText(runId, "tests.stdout.txt", execution.stdout || "");
      this.artifacts.saveText(runId, "tests.stderr.txt", execution.stderr || "");

      const testsResult: TestsResult = {
        status: execution.status === 0 ? "passed" : "failed",
        testCommand,
        planSummary: planPass.payload.summary,
        planText: planPass.payload.plan_text,
        frameworkGuess: planPass.payload.framework_guess || "",
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

  private async runCodeWorkflow(runId: number, repoPath: string, changedFiles: string[]) {
    this.store.updateRun(runId, { status: "scanning_code" });
    this.store.appendProgress(runId, "scanning_code", "Running static code analysis", "active");
    const findings = await runCodeScan(repoPath, changedFiles);
    this.store.updateRun(runId, {
      codeFindings: findings,
    });
    this.artifacts.saveJson(runId, "code-findings.json", findings);
    this.store.updateRun(runId, {
      generatedArtifacts: [
        ...this.getRunStatus(runId).generatedArtifacts,
        { type: "json", label: "code-findings.json", filename: "code-findings.json" },
      ],
    });
    this.store.appendProgress(runId, "scanning_code_complete", `Code scan found ${findings.length} findings`);
    return findings;
  }

  private async runDependencyWorkflow(runId: number, repoPath: string) {
    this.store.updateRun(runId, { status: "scanning_dependencies" });
    this.store.appendProgress(runId, "scanning_dependencies", "Running dependency vulnerability scan", "active");
    const result = await runDependencyScan(repoPath, this.store);
    this.store.updateRun(runId, {
      dependencyFindings: result.findings,
    });
    this.artifacts.saveJson(runId, "dependency-findings.json", result);
    this.store.updateRun(runId, {
      generatedArtifacts: [
        ...this.getRunStatus(runId).generatedArtifacts,
        { type: "json", label: "dependency-findings.json", filename: "dependency-findings.json" },
      ],
    });
    this.store.appendProgress(runId, "scanning_dependencies_complete", `Dependency scan found ${result.vulnerabilityCount} vulnerability findings`);
    return result;
  }

  private async failRun(runId: number, message: string): Promise<void> {
    this.store.updateRun(runId, {
      status: "failed",
      error: message,
      summary: message,
      completedAt: new Date().toISOString(),
    });
    this.store.appendProgress(runId, "failed", message);
  }

  private resolveRepoPath(repoPath?: string): string {
    const target = repoPath ? path.resolve(repoPath) : process.cwd();
    if (!fs.existsSync(target)) {
      throw new Error(`Repository path does not exist: ${target}`);
    }
    return target;
  }

  private buildQueuedSummary(kind: RunKind, repoPath: string): string {
    return `Queued ${kind} for ${repoPath}`;
  }
}
