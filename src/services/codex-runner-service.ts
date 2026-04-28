import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CommandResult, runCommandAsync, runCommandSync, withEnv } from "../utils/process";
import { CodexExecutableResolver } from "./codex-executable-resolver";
import {
  buildGenerationPrompt as buildGenerationPromptText,
  buildPlanPrompt as buildPlanPromptText,
} from "./codex-prompt-builder";
import { GitContextService } from "./git-context-service";
import {
  validateGeneratedFilesPayload as validateGeneratedFilesPayloadShape,
  validateGeneratedFileTargets as validateGeneratedFileTargetPaths,
  validatePlanPayload as validatePlanPayloadShape,
} from "./generated-test-validator";
import { detectProjectProfile as detectProjectProfileFromFiles } from "./project-profile-service";

/** Git metadata and diff content passed into Codex prompt builders. */
export interface GitContext {
  mode: "latest-commit" | "working-tree" | "custom";
  resolvedRange: string;
  head: string;
  base: string | null;
  changedFiles: string[];
  changedTestFiles: string[];
  summary: string;
  diff: string;
  diffTruncated: boolean;
}

/** Detected project ecosystem and test-command metadata. */
export interface ProjectProfile {
  ecosystem: string;
  language: string;
  packageManager: string;
  command: string | null;
  packageSummary: {
    name: string;
    scripts?: Record<string, string>;
  };
}

/** Result returned after a Codex CLI planning or generation pass. */
export interface CodexPassResult<T> {
  status: number | null;
  signal: NodeJS.Signals | null;
  durationMs: number;
  stdout: string;
  stderr: string;
  payload: T | null;
  parseError: string | null;
  timeout: boolean;
  failureCategory: string | null;
  command: string;
}

/** One generated file proposed by the Codex generation pass. */
export interface GeneratedFilePayload {
  path: string;
  content: string;
}

/** Structured test plan emitted by the Codex planning pass. */
export interface TestPlanPayload {
  summary: string;
  proposed_test_files: string[];
  recommended_command: string;
  risks: string[];
  plan_text: string;
  framework_guess?: string;
}

const DEFAULT_CODEX_TIMEOUT_MS = 300000;
const DEFAULT_TEST_TIMEOUT_MS = 120000;
const DEFAULT_MAX_DIFF_CHARS = 30000;
const IGNORE_DIRS = new Set([
  ".git",
  ".next",
  ".angular",
  "build",
  "coverage",
  "dist",
  "node_modules",
  "vendor",
]);

const REPO_ROOT = path.resolve(__dirname, "..", "..");
const PLAN_SCHEMA_PATH = path.join(REPO_ROOT, "scripts", "schemas", "codex-test-plan.schema.json");
const FILES_SCHEMA_PATH = path.join(REPO_ROOT, "scripts", "schemas", "codex-test-files.schema.json");

/** Runs Codex planning/generation passes and safely executes generated tests. */
export class CodexRunnerService {
  private readonly executableResolver = new CodexExecutableResolver();
  private readonly gitContextService = new GitContextService(
    (projectPath, args) => this.runGit(projectPath, args),
    (projectPath, args) => this.runGitAsync(projectPath, args),
  );

  /** Creates a runner with optional Codex home isolation. */
  constructor(private options: { codexHome?: string } = {}) {}

  /** Resolves the Codex CLI binary used for planning and test generation. */
  resolveCodexExecutable(bin = "codex"): string | null {
    return this.executableResolver.resolveCodexExecutable(bin);
  }

  /** Checks whether the resolved Codex CLI has an active login session. */
  checkCodexLogin(codexBin: string): { ok: boolean; output: string } {
    const result = this.runCommand(
      codexBin,
      ["login", "status"],
      undefined,
      undefined,
      30000,
      this.getCodexEnv(),
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      ok: result.status === 0 && /logged in/i.test(output),
      output,
    };
  }

  /** Checks Codex login state asynchronously for long-running MCP jobs. */
  async checkCodexLoginAsync(codexBin: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.runCommandAsync(
      codexBin,
      ["login", "status"],
      undefined,
      undefined,
      30000,
      this.getCodexEnv(),
    );
    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      ok: result.status === 0 && /logged in/i.test(output),
      output,
    };
  }

  /** Verifies that the target path is inside a git work tree. */
  ensureGitRepo(projectPath: string): void {
    this.gitContextService.ensureGitRepo(projectPath);
  }

  /** Collects git diff metadata for the requested target in synchronous workflows. */
  getGitContext(
    projectPath: string,
    gitTarget: "latest-commit" | "working-tree" | "custom",
    gitRange?: string,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
  ): GitContext {
    return this.gitContextService.getGitContext(projectPath, gitTarget, gitRange, maxDiffChars);
  }

  /** Collects git diff metadata for the requested target in asynchronous workflows. */
  async getGitContextAsync(
    projectPath: string,
    gitTarget: "latest-commit" | "working-tree" | "custom",
    gitRange?: string,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
  ): Promise<GitContext> {
    return this.gitContextService.getGitContextAsync(projectPath, gitTarget, gitRange, maxDiffChars);
  }

  /** Detects the repository ecosystem, package manager, and test command. */
  detectProjectProfile(projectPath: string): ProjectProfile {
    return detectProjectProfileFromFiles(projectPath);
  }

  /** Builds the read-only prompt that asks Codex to plan test coverage. */
  buildPlanPrompt(context: {
    projectName: string;
    projectProfile: ProjectProfile;
    git: GitContext;
    brief: string;
    notes: string;
    testCommand: string | null;
  }): string {
    return buildPlanPromptText(context);
  }

  /** Builds the prompt that asks Codex to emit generated test files as JSON. */
  buildGenerationPrompt(context: {
    projectName: string;
    projectProfile: ProjectProfile;
    git: GitContext;
    testCommand: string | null;
    plan: {
      summary: string;
      plan_text: string;
      proposed_test_files: string[];
    };
  }): string {
    return buildGenerationPromptText(context);
  }

  /** Runs the synchronous Codex planning pass and parses the schema-constrained output. */
  runPlanPass(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
  }): CodexPassResult<unknown> {
    return this.runCodexPass({
      codexBin: params.codexBin,
      model: params.model,
      schemaPath: PLAN_SCHEMA_PATH,
      prompt: params.prompt,
      projectPath: params.projectPath,
      timeoutMs: params.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
      label: "plan",
    });
  }

  /** Runs the asynchronous Codex planning pass and parses the schema-constrained output. */
  async runPlanPassAsync(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
  }): Promise<CodexPassResult<unknown>> {
    return this.runCodexPassAsync({
      codexBin: params.codexBin,
      model: params.model,
      schemaPath: PLAN_SCHEMA_PATH,
      prompt: params.prompt,
      projectPath: params.projectPath,
      timeoutMs: params.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
      label: "plan",
    });
  }

  /** Runs the synchronous Codex generation pass and parses generated test-file JSON. */
  runGenerationPass(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
    skipGitRepoCheck?: boolean;
  }): CodexPassResult<unknown> {
    return this.runCodexPass({
      codexBin: params.codexBin,
      model: params.model,
      schemaPath: FILES_SCHEMA_PATH,
      prompt: params.prompt,
      projectPath: params.projectPath,
      timeoutMs: params.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
      label: "generate",
      skipGitRepoCheck: params.skipGitRepoCheck ?? false,
    });
  }

  /** Runs the asynchronous Codex generation pass and parses generated test-file JSON. */
  async runGenerationPassAsync(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
    skipGitRepoCheck?: boolean;
  }): Promise<CodexPassResult<unknown>> {
    return this.runCodexPassAsync({
      codexBin: params.codexBin,
      model: params.model,
      schemaPath: FILES_SCHEMA_PATH,
      prompt: params.prompt,
      projectPath: params.projectPath,
      timeoutMs: params.timeoutMs ?? DEFAULT_CODEX_TIMEOUT_MS,
      label: "generate",
      skipGitRepoCheck: params.skipGitRepoCheck ?? false,
    });
  }

  /** Validates a Codex planning response before the service trusts its fields. */
  validatePlanPayload(payload: unknown): string[] {
    return validatePlanPayloadShape(payload);
  }

  /** Validates and normalizes generated test files returned by Codex. */
  validateGeneratedFilesPayload(payload: unknown): { errors: string[]; files: GeneratedFilePayload[] } {
    return validateGeneratedFilesPayloadShape(payload);
  }

  /** Accepts only generated files that stay inside known test-only locations. */
  validateGeneratedFileTargets(projectRoot: string, ecosystem: string, files: GeneratedFilePayload[]) {
    return validateGeneratedFileTargetPaths(projectRoot, ecosystem, files);
  }

  /** Copies a repository into a temporary workspace while excluding heavy generated directories. */
  createEphemeralWorkspace(projectPath: string): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devgaurd-code-tester-"));
    const destination = path.join(workspaceRoot, path.basename(projectPath));
    fs.cpSync(projectPath, destination, {
      recursive: true,
      force: true,
      filter: (src) => {
        const rel = path.relative(projectPath, src);
        if (!rel) return true;
        return !rel.split(path.sep).some((segment) => IGNORE_DIRS.has(segment));
      },
    });
    this.linkNodeModulesIfAvailable(projectPath, destination);
    return destination;
  }

  /** Links local dependencies into the ephemeral workspace so test commands can use dev tools. */
  private linkNodeModulesIfAvailable(projectPath: string, destination: string): void {
    const sourceNodeModules = path.join(projectPath, "node_modules");
    const destinationNodeModules = path.join(destination, "node_modules");
    if (!fs.existsSync(sourceNodeModules) || fs.existsSync(destinationNodeModules)) {
      return;
    }

    try {
      fs.symlinkSync(sourceNodeModules, destinationNodeModules, "junction");
    } catch {
      // Best effort: repositories without installed dependencies will report the
      // missing tool through the normal test command output.
    }
  }

  /** Removes the temporary workspace created for generated test execution. */
  cleanupWorkspace(workspacePath: string): void {
    fs.rmSync(path.dirname(workspacePath), { recursive: true, force: true });
  }

  /** Writes accepted generated test files into a workspace or repository. */
  writeAcceptedFiles(
    workspacePath: string,
    acceptedFiles: Array<{ path: string; content: string }>,
  ): string[] {
    const writtenFiles: string[] = [];

    for (const file of acceptedFiles) {
      const absolutePath = path.join(workspacePath, file.path);
      fs.mkdirSync(path.dirname(absolutePath), { recursive: true });
      fs.writeFileSync(absolutePath, file.content, "utf8");
      writtenFiles.push(file.path);
    }

    return writtenFiles;
  }

  /** Runs a repository test command through the user's shell and extracts a compact summary. */
  runTestCommand(projectPath: string, commandText: string, timeoutMs = DEFAULT_TEST_TIMEOUT_MS) {
    const shell = process.env.SHELL || "/bin/bash";
    const startedMs = Date.now();
    const result = this.runCommand(shell, ["-lc", commandText], projectPath, undefined, timeoutMs);

    return {
      durationMs: Date.now() - startedMs,
      command: commandText,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: this.extractTestSummary(`${result.stdout}\n${result.stderr}`),
      timeout: result.error?.code === "ETIMEDOUT",
    };
  }

  /** Runs a repository test command asynchronously and extracts a compact summary. */
  async runTestCommandAsync(projectPath: string, commandText: string, timeoutMs = DEFAULT_TEST_TIMEOUT_MS) {
    const shell = process.env.SHELL || "/bin/bash";
    const startedMs = Date.now();
    const result = await this.runCommandAsync(shell, ["-lc", commandText], projectPath, undefined, timeoutMs);

    return {
      durationMs: Date.now() - startedMs,
      command: commandText,
      status: result.status,
      signal: result.signal,
      stdout: result.stdout,
      stderr: result.stderr,
      summary: this.extractTestSummary(`${result.stdout}\n${result.stderr}`),
      timeout: result.error?.code === "ETIMEDOUT",
    };
  }

  /** Executes a Codex pass synchronously and loads the JSON message written by the CLI. */
  private runCodexPass(params: {
    codexBin: string;
    model: string;
    schemaPath: string;
    prompt: string;
    projectPath: string;
    timeoutMs: number;
    label: string;
    skipGitRepoCheck?: boolean;
  }): CodexPassResult<unknown> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-runner-"));
    const outputFile = path.join(tempDir, `${params.label}-last-message.json`);
    const args = [
      "exec",
      ...(params.model ? ["-m", params.model] : []),
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      ...(params.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      "--sandbox",
      "read-only",
      "--cd",
      params.projectPath,
      "--output-schema",
      params.schemaPath,
      "--output-last-message",
      outputFile,
      "-",
    ];

    const startedMs = Date.now();
    const result = this.runCommand(
      params.codexBin,
      args,
      params.projectPath,
      params.prompt,
      params.timeoutMs,
      this.getCodexEnv(),
    );
    const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
    let payload: unknown = null;
    let parseError: string | null = null;

    if (outputText) {
      try {
        payload = JSON.parse(outputText);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    const timedOut = result.error?.code === "ETIMEDOUT";

    return {
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedMs,
      stdout: result.stdout,
      stderr: result.stderr,
      payload,
      parseError,
      timeout: timedOut,
      failureCategory: result.status === 0 ? null : (timedOut ? "timeout" : this.classifyCodexFailure(result)),
      command: [params.codexBin, ...args].join(" "),
    };
  }

  /** Executes a Codex pass asynchronously and loads the JSON message written by the CLI. */
  private async runCodexPassAsync(params: {
    codexBin: string;
    model: string;
    schemaPath: string;
    prompt: string;
    projectPath: string;
    timeoutMs: number;
    label: string;
    skipGitRepoCheck?: boolean;
  }): Promise<CodexPassResult<unknown>> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-runner-"));
    const outputFile = path.join(tempDir, `${params.label}-last-message.json`);
    const args = [
      "exec",
      ...(params.model ? ["-m", params.model] : []),
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--ignore-rules",
      ...(params.skipGitRepoCheck ? ["--skip-git-repo-check"] : []),
      "--sandbox",
      "read-only",
      "--cd",
      params.projectPath,
      "--output-schema",
      params.schemaPath,
      "--output-last-message",
      outputFile,
      "-",
    ];

    const startedMs = Date.now();
    const result = await this.runCommandAsync(
      params.codexBin,
      args,
      params.projectPath,
      params.prompt,
      params.timeoutMs,
      this.getCodexEnv(),
    );
    const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
    let payload: unknown = null;
    let parseError: string | null = null;

    if (outputText) {
      try {
        payload = JSON.parse(outputText);
      } catch (error) {
        parseError = error instanceof Error ? error.message : String(error);
      }
    }

    const timedOut = result.error?.code === "ETIMEDOUT";

    return {
      status: result.status,
      signal: result.signal,
      durationMs: Date.now() - startedMs,
      stdout: result.stdout,
      stderr: result.stderr,
      payload,
      parseError,
      timeout: timedOut,
      failureCategory: result.status === 0 ? null : (timedOut ? "timeout" : this.classifyCodexFailure(result)),
      command: [params.codexBin, ...args].join(" "),
    };
  }

  /** Maps Codex process failures into stable categories for diagnostics. */
  private classifyCodexFailure(output: CommandResult): string {
    if (output.error?.code === "ETIMEDOUT") {
      return "timeout";
    }

    if (output.error?.code === "EPERM") {
      return "environment";
    }

    const combined = `${output.stdout}\n${output.stderr}`.toLowerCase();

    if (combined.includes("not logged") || combined.includes("please log in")) {
      return "auth";
    }

    if (combined.includes("not inside a trusted directory") || combined.includes("skip-git-repo-check")) {
      return "workspace-trust";
    }

    if (
      combined.includes("failed to connect to websocket")
      || combined.includes("dns error")
      || combined.includes("could not resolve host")
      || combined.includes("operation not permitted")
      || combined.includes("timed out")
      || combined.includes("error sending request")
    ) {
      return "network";
    }

    if (combined.includes("output schema") || combined.includes("unexpected")) {
      return "schema";
    }

    return "execution";
  }

  /** Extracts common passed, failed, and skipped counts from test runner output. */
  private extractTestSummary(output: string) {
    const normalized = output.replace(/\x1B\[[0-9;]*m/g, "");
    const summary = {
      passedCount: null as number | null,
      failedCount: null as number | null,
      skippedCount: null as number | null,
    };

    let match = normalized.match(/(\d+)\s+passed/i);
    if (match) summary.passedCount = Number(match[1]);

    match = normalized.match(/(\d+)\s+failed/i);
    if (match) summary.failedCount = Number(match[1]);

    match = normalized.match(/(\d+)\s+skipped/i);
    if (match) summary.skippedCount = Number(match[1]);

    return summary;
  }

  /** Runs a git command synchronously and throws a detailed error on failure. */
  private runGit(projectPath: string, gitArgs: string[]): string {
    const result = this.runCommand("git", gitArgs, projectPath, undefined, 30000);
    if (result.error && result.error.code === "EPERM") {
      throw new Error(
        "Git command failed because nested child-process execution is blocked in the current environment (EPERM). Re-run on a normal user machine.",
      );
    }

    if (result.error || result.status !== 0) {
      const message = result.error
        ? result.error.message
        : (result.stderr || result.stdout || "Unknown git error").trim();
      throw new Error(`Git command failed: git ${gitArgs.join(" ")}\n${message}`);
    }

    return result.stdout.trim();
  }

  /** Runs a git command asynchronously and throws a detailed error on failure. */
  private async runGitAsync(projectPath: string, gitArgs: string[]): Promise<string> {
    const result = await this.runCommandAsync("git", gitArgs, projectPath, undefined, 30000);
    if (result.error && result.error.code === "EPERM") {
      throw new Error(
        "Git command failed because nested child-process execution is blocked in the current environment (EPERM). Re-run on a normal user machine.",
      );
    }

    if (result.error || result.status !== 0) {
      const message = result.error
        ? result.error.message
        : (result.stderr || result.stdout || "Unknown git error").trim();
      throw new Error(`Git command failed: git ${gitArgs.join(" ")}\n${message}`);
    }

    return result.stdout.trim();
  }

  /** Executes a synchronous child process with normalized environment handling. */
  private runCommand(
    command: string,
    args: string[],
    cwd?: string,
    input?: string,
    timeout?: number,
    envOverrides?: NodeJS.ProcessEnv,
  ): CommandResult {
    return runCommandSync(command, args, {
      cwd,
      input,
      env: withEnv(envOverrides),
      timeoutMs: timeout,
    });
  }

  /** Executes an asynchronous child process with normalized environment handling. */
  private runCommandAsync(
    command: string,
    args: string[],
    cwd?: string,
    input?: string,
    timeout?: number,
    envOverrides?: NodeJS.ProcessEnv,
  ): Promise<CommandResult> {
    return runCommandAsync(command, args, {
      cwd,
      input,
      env: withEnv(envOverrides),
      timeoutMs: timeout,
    });
  }

  /** Returns the environment override that points Codex at DevGuard-managed auth. */
  private getCodexEnv(): NodeJS.ProcessEnv | undefined {
    if (!this.options.codexHome) {
      return undefined;
    }

    return { CODEX_HOME: this.options.codexHome };
  }
}
