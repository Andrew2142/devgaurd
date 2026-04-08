import fs from "fs";
import os from "os";
import path from "path";
import { spawn, spawnSync } from "child_process";

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

export interface GeneratedFilePayload {
  path: string;
  content: string;
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

const PLAN_SCHEMA_PATH = path.join(process.cwd(), "scripts", "schemas", "codex-test-plan.schema.json");
const FILES_SCHEMA_PATH = path.join(process.cwd(), "scripts", "schemas", "codex-test-files.schema.json");

type CommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
};

export class CodexRunnerService {
  resolveCodexExecutable(bin = "codex"): string | null {
    if (bin && path.isAbsolute(bin) && fs.existsSync(bin)) {
      return bin;
    }

    const direct = this.findExecutable(bin);
    if (direct) {
      return direct;
    }

    for (const candidate of this.collectCodexCandidates(bin)) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return null;
  }

  checkCodexLogin(codexBin: string): { ok: boolean; output: string } {
    const result = this.runCommand(codexBin, ["login", "status"], undefined, undefined, 30000);
    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      ok: result.status === 0 && /logged in/i.test(output),
      output,
    };
  }

  async checkCodexLoginAsync(codexBin: string): Promise<{ ok: boolean; output: string }> {
    const result = await this.runCommandAsync(codexBin, ["login", "status"], undefined, undefined, 30000);
    const output = `${result.stdout}\n${result.stderr}`.trim();

    return {
      ok: result.status === 0 && /logged in/i.test(output),
      output,
    };
  }

  ensureGitRepo(projectPath: string): void {
    const output = this.runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (output !== "true") {
      throw new Error("Target project is not inside a git work tree");
    }
  }

  getGitContext(
    projectPath: string,
    gitTarget: "latest-commit" | "working-tree" | "custom",
    gitRange?: string,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
  ): GitContext {
    this.ensureGitRepo(projectPath);

    if (gitTarget === "latest-commit") {
      const head = this.runGit(projectPath, ["rev-parse", "HEAD"]);
      let base: string;

      try {
        base = this.runGit(projectPath, ["rev-parse", "HEAD~1"]);
      } catch {
        throw new Error("Latest-commit mode requires at least two commits");
      }

      const changedFiles = this.runGit(projectPath, ["diff", "--name-only", `${base}..${head}`])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const diff = this.runGit(projectPath, ["diff", "--unified=3", `${base}..${head}`]);
      const summary = this.runGit(projectPath, ["show", "--stat", "--summary", "--format=fuller", head]);

      return {
        mode: gitTarget,
        resolvedRange: `${base}..${head}`,
        head,
        base,
        changedFiles,
        changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
        summary,
        diff: diff.slice(0, maxDiffChars),
        diffTruncated: diff.length > maxDiffChars,
      };
    }

    if (gitTarget === "working-tree") {
      const stagedFiles = this.runGit(projectPath, ["diff", "--cached", "--name-only"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const unstagedFiles = this.runGit(projectPath, ["diff", "--name-only"])
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const changedFiles = Array.from(new Set([...stagedFiles, ...unstagedFiles]));

      if (changedFiles.length === 0) {
        throw new Error("Working-tree mode requires staged or unstaged changes");
      }

      const stagedDiff = this.runGit(projectPath, ["diff", "--cached", "--unified=3"]);
      const unstagedDiff = this.runGit(projectPath, ["diff", "--unified=3"]);

      return {
        mode: gitTarget,
        resolvedRange: "working-tree",
        head: this.runGit(projectPath, ["rev-parse", "HEAD"]),
        base: null,
        changedFiles,
        changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
        summary: this.runGit(projectPath, ["status", "--short"]),
        diff: [
          "### STAGED DIFF ###",
          stagedDiff || "(none)",
          "",
          "### UNSTAGED DIFF ###",
          unstagedDiff || "(none)",
        ].join("\n").slice(0, maxDiffChars),
        diffTruncated: (stagedDiff.length + unstagedDiff.length) > maxDiffChars,
      };
    }

    if (!gitRange) {
      throw new Error("Custom git range is required");
    }

    const resolvedRange = gitRange.includes("..") ? gitRange : `${gitRange}^..${gitRange}`;
    const changedFiles = this.runGit(projectPath, ["diff", "--name-only", resolvedRange])
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (changedFiles.length === 0) {
      throw new Error(`Custom git range produced no changed files: ${resolvedRange}`);
    }

    const diff = this.runGit(projectPath, ["diff", "--unified=3", resolvedRange]);
    const summary = this.runGit(projectPath, ["show", "--stat", "--summary", "--format=fuller", resolvedRange]);
    const [base, head] = resolvedRange.split("..");

    return {
      mode: gitTarget,
      resolvedRange,
      head: head || gitRange,
      base: base || null,
      changedFiles,
      changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
      summary,
      diff: diff.slice(0, maxDiffChars),
      diffTruncated: diff.length > maxDiffChars,
    };
  }

  async getGitContextAsync(
    projectPath: string,
    gitTarget: "latest-commit" | "working-tree" | "custom",
    gitRange?: string,
    maxDiffChars = DEFAULT_MAX_DIFF_CHARS,
  ): Promise<GitContext> {
    await this.ensureGitRepoAsync(projectPath);

    if (gitTarget === "latest-commit") {
      const head = await this.runGitAsync(projectPath, ["rev-parse", "HEAD"]);
      let base: string;

      try {
        base = await this.runGitAsync(projectPath, ["rev-parse", "HEAD~1"]);
      } catch {
        throw new Error("Latest-commit mode requires at least two commits");
      }

      const changedFiles = (await this.runGitAsync(projectPath, ["diff", "--name-only", `${base}..${head}`]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const diff = await this.runGitAsync(projectPath, ["diff", "--unified=3", `${base}..${head}`]);
      const summary = await this.runGitAsync(projectPath, ["show", "--stat", "--summary", "--format=fuller", head]);

      return {
        mode: gitTarget,
        resolvedRange: `${base}..${head}`,
        head,
        base,
        changedFiles,
        changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
        summary,
        diff: diff.slice(0, maxDiffChars),
        diffTruncated: diff.length > maxDiffChars,
      };
    }

    if (gitTarget === "working-tree") {
      const stagedFiles = (await this.runGitAsync(projectPath, ["diff", "--cached", "--name-only"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const unstagedFiles = (await this.runGitAsync(projectPath, ["diff", "--name-only"]))
        .split("\n")
        .map((line) => line.trim())
        .filter(Boolean);
      const changedFiles = Array.from(new Set([...stagedFiles, ...unstagedFiles]));

      if (changedFiles.length === 0) {
        throw new Error("Working-tree mode requires staged or unstaged changes");
      }

      const stagedDiff = await this.runGitAsync(projectPath, ["diff", "--cached", "--unified=3"]);
      const unstagedDiff = await this.runGitAsync(projectPath, ["diff", "--unified=3"]);

      return {
        mode: gitTarget,
        resolvedRange: "working-tree",
        head: await this.runGitAsync(projectPath, ["rev-parse", "HEAD"]),
        base: null,
        changedFiles,
        changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
        summary: await this.runGitAsync(projectPath, ["status", "--short"]),
        diff: [
          "### STAGED DIFF ###",
          stagedDiff || "(none)",
          "",
          "### UNSTAGED DIFF ###",
          unstagedDiff || "(none)",
        ].join("\n").slice(0, maxDiffChars),
        diffTruncated: (stagedDiff.length + unstagedDiff.length) > maxDiffChars,
      };
    }

    if (!gitRange) {
      throw new Error("Custom git range is required");
    }

    const resolvedRange = this.normalizeCustomGitRange(gitRange);
    const changedFiles = (await this.runGitAsync(projectPath, ["diff", "--name-only", resolvedRange]))
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);

    if (changedFiles.length === 0) {
      throw new Error(`Custom git range produced no changed files: ${resolvedRange}`);
    }

    const diff = await this.runGitAsync(projectPath, ["diff", "--unified=3", resolvedRange]);
    const summary = await this.runGitAsync(projectPath, ["show", "--stat", "--summary", "--format=fuller", resolvedRange]);
    const [base, head] = resolvedRange.split("..");

    return {
      mode: gitTarget,
      resolvedRange,
      head: head || gitRange,
      base: base || null,
      changedFiles,
      changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
      summary,
      diff: diff.slice(0, maxDiffChars),
      diffTruncated: diff.length > maxDiffChars,
    };
  }

  private normalizeCustomGitRange(gitRange: string): string {
    const trimmed = gitRange.trim();
    if (!trimmed) {
      throw new Error("Custom git range is required");
    }

    if (trimmed.includes("..")) {
      return trimmed;
    }

    const commitIds = trimmed
      .split(/[\s,]+/)
      .map((value) => value.trim())
      .filter(Boolean);

    if (commitIds.length === 0) {
      throw new Error("Custom git range is required");
    }

    if (commitIds.length === 1) {
      return `${commitIds[0]}^..${commitIds[0]}`;
    }

    return `${commitIds[0]}^..${commitIds[commitIds.length - 1]}`;
  }

  detectProjectProfile(projectPath: string): ProjectProfile {
    const packageJsonPath = path.join(projectPath, "package.json");
    const composerJsonPath = path.join(projectPath, "composer.json");
    const pyprojectPath = path.join(projectPath, "pyproject.toml");
    const goModPath = path.join(projectPath, "go.mod");
    const cargoTomlPath = path.join(projectPath, "Cargo.toml");
    const pomXmlPath = path.join(projectPath, "pom.xml");

    if (fs.existsSync(packageJsonPath)) {
      const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8"));
      const packageManager = fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))
        ? "pnpm"
        : fs.existsSync(path.join(projectPath, "yarn.lock"))
          ? "yarn"
          : "npm";
      const scriptCommand = pkg.scripts && typeof pkg.scripts.test === "string"
        ? `${packageManager} test`
        : null;
      const inferredCommand = scriptCommand
        || (pkg.devDependencies && pkg.devDependencies.vitest ? `${packageManager} exec vitest run` : null)
        || (pkg.devDependencies && pkg.devDependencies.jest ? `${packageManager} exec jest --runInBand` : null)
        || null;

      return {
        ecosystem: "node",
        language: "javascript/typescript",
        packageManager,
        command: inferredCommand,
        packageSummary: {
          name: pkg.name || path.basename(projectPath),
          scripts: pkg.scripts || {},
        },
      };
    }

    if (fs.existsSync(composerJsonPath)) {
      const composer = JSON.parse(fs.readFileSync(composerJsonPath, "utf8"));
      const inferredCommand = composer.scripts && composer.scripts.test
        ? "composer test"
        : fs.existsSync(path.join(projectPath, "vendor", "bin", "pest"))
          ? "vendor/bin/pest"
          : fs.existsSync(path.join(projectPath, "vendor", "bin", "phpunit"))
            ? "vendor/bin/phpunit"
            : null;

      return {
        ecosystem: "php",
        language: "php",
        packageManager: "composer",
        command: inferredCommand,
        packageSummary: {
          name: composer.name || path.basename(projectPath),
        },
      };
    }

    if (fs.existsSync(pyprojectPath) || fs.existsSync(path.join(projectPath, "requirements.txt"))) {
      return {
        ecosystem: "python",
        language: "python",
        packageManager: "pip",
        command: fs.existsSync(path.join(projectPath, "pytest.ini")) || fs.existsSync(path.join(projectPath, "tests"))
          ? "pytest"
          : "python -m unittest",
        packageSummary: {
          name: path.basename(projectPath),
        },
      };
    }

    if (fs.existsSync(pomXmlPath)) {
      return {
        ecosystem: "java",
        language: "java",
        packageManager: "maven",
        command: "mvn test",
        packageSummary: { name: path.basename(projectPath) },
      };
    }

    if (fs.existsSync(goModPath)) {
      return {
        ecosystem: "go",
        language: "go",
        packageManager: "go",
        command: "go test ./...",
        packageSummary: { name: path.basename(projectPath) },
      };
    }

    if (fs.existsSync(cargoTomlPath)) {
      return {
        ecosystem: "rust",
        language: "rust",
        packageManager: "cargo",
        command: "cargo test",
        packageSummary: { name: path.basename(projectPath) },
      };
    }

    return {
      ecosystem: "unknown",
      language: "unknown",
      packageManager: "unknown",
      command: null,
      packageSummary: {
        name: path.basename(projectPath),
      },
    };
  }

 

  buildPlanPrompt(context: {
    projectName: string;
    projectProfile: ProjectProfile;
    git: GitContext;
    brief: string;
    notes: string;
    testCommand: string | null;
  }): string {
    const brief = context.brief || "(none)";
    const notes = context.notes || "(none)";
    const testCommand = context.testCommand || "(not detected)";
     

    return `You are helping with a backend spike for a local Codex-driven code tester.

Analyze the git change set and propose test coverage only. Do not modify files. Do not include markdown fences.
The final plan_text should focus on what behaviours, edge cases, regressions, and risks need coverage.
Do not make the plan_text read like implementation instructions, file-edit steps, or framework mechanics.

Project:
- Name: ${context.projectName}
- Ecosystem: ${context.projectProfile.ecosystem}
- Language: ${context.projectProfile.language}
- Package manager: ${context.projectProfile.packageManager}
- Detected test command: ${testCommand}

Git target:
- Mode: ${context.git.mode}
- Resolved range: ${context.git.resolvedRange}
- Changed files count: ${context.git.changedFiles.length}
- Changed test files count: ${context.git.changedTestFiles.length}

Saved testing brief:
${brief}

Specific testing focus from the user:
${notes}

 

Git summary:
${context.git.summary}

Changed files:
${context.git.changedFiles.join("\n")}

Diff excerpt:
${context.git.diff}

Return JSON only with:
- summary: string
- proposed_test_files: string[]
- recommended_command: string
- risks: string[]
- plan_text: string
- framework_guess: string
`;
  }

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
 
    return `You are generating tests for a local Codex spike.

Hard rules:
- Return JSON only. No markdown fences.
- Do not modify or propose production source files.
- Only generate new or updated test files.
- Keep file paths relative to the repository root.
- Prefer the established test style and naming conventions already present in the repo.

Project:
- Name: ${context.projectName}
- Ecosystem: ${context.projectProfile.ecosystem}
- Language: ${context.projectProfile.language}
- Package manager: ${context.projectProfile.packageManager}
- Test command: ${context.testCommand || "(not detected)"}

Confirmed plan:
${context.plan.plan_text}

Plan summary:
${context.plan.summary}

Suggested files:
${context.plan.proposed_test_files.join("\n")}

Changed files:
${context.git.changedFiles.join("\n")}

Diff excerpt:
${context.git.diff}

Return JSON only with:
- files: array of { path: string, content: string }
`;
  }

  runPlanPass(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
  }): CodexPassResult<any> {
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

  async runPlanPassAsync(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
  }): Promise<CodexPassResult<any>> {
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

  runGenerationPass(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
    skipGitRepoCheck?: boolean;
  }): CodexPassResult<any> {
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

  async runGenerationPassAsync(params: {
    codexBin: string;
    model: string;
    projectPath: string;
    prompt: string;
    timeoutMs?: number;
    skipGitRepoCheck?: boolean;
  }): Promise<CodexPassResult<any>> {
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

  validatePlanPayload(payload: any): string[] {
    const errors: string[] = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return ["Plan payload must be a JSON object"];
    }

    if (typeof payload.summary !== "string" || payload.summary.trim() === "") {
      errors.push("summary must be a non-empty string");
    }

    if (!Array.isArray(payload.proposed_test_files) || payload.proposed_test_files.some((item: unknown) => typeof item !== "string")) {
      errors.push("proposed_test_files must be an array of strings");
    }

    if (typeof payload.recommended_command !== "string" || payload.recommended_command.trim() === "") {
      errors.push("recommended_command must be a non-empty string");
    }

    if (!Array.isArray(payload.risks) || payload.risks.some((item: unknown) => typeof item !== "string")) {
      errors.push("risks must be an array of strings");
    }

    if (typeof payload.plan_text !== "string" || payload.plan_text.trim() === "") {
      errors.push("plan_text must be a non-empty string");
    }

    if (payload.framework_guess != null && typeof payload.framework_guess !== "string") {
      errors.push("framework_guess must be a string when provided");
    }

    return errors;
  }

  validateGeneratedFilesPayload(payload: any): { errors: string[]; files: GeneratedFilePayload[] } {
    const errors: string[] = [];

    if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
      return { errors: ["Generated files payload must be a JSON object"], files: [] };
    }

    if (!Array.isArray(payload.files) || payload.files.length === 0) {
      return { errors: ["files must be a non-empty array"], files: [] };
    }

    const normalizedFiles: GeneratedFilePayload[] = [];

    for (const file of payload.files) {
      if (!file || typeof file !== "object" || Array.isArray(file)) {
        errors.push("Each file entry must be an object");
        continue;
      }

      if (typeof file.path !== "string" || file.path.trim() === "") {
        errors.push("Each file path must be a non-empty string");
        continue;
      }

      if (typeof file.content !== "string" || file.content.trim() === "") {
        errors.push(`Generated file ${file.path} has empty content`);
        continue;
      }

      normalizedFiles.push({
        path: file.path.trim().replace(/\\/g, "/"),
        content: file.content,
      });
    }

    return { errors, files: normalizedFiles };
  }

  validateGeneratedFileTargets(projectRoot: string, ecosystem: string, files: GeneratedFilePayload[]) {
    const allowedPatterns = this.getAllowedPatterns(ecosystem);
    const accepted: Array<{ path: string; absolutePath: string; content: string }> = [];
    const rejected: Array<{ path: string; reason: string }> = [];
    const resolvedProjectRoot = path.resolve(projectRoot);

    for (const file of files) {
      const relativePath = file.path.replace(/^\.?\//, "");
      const resolved = path.resolve(resolvedProjectRoot, relativePath);
      const isInsideRoot = resolved === resolvedProjectRoot || resolved.startsWith(`${resolvedProjectRoot}${path.sep}`);
      const matchesAllowedPattern = allowedPatterns.some((pattern) => pattern.test(relativePath));

      if (path.isAbsolute(file.path) || !isInsideRoot || relativePath === "") {
        rejected.push({ path: file.path, reason: "Path escapes the repository root or is absolute" });
        continue;
      }

      if (!matchesAllowedPattern) {
        rejected.push({ path: file.path, reason: "Path is not a recognized test-only location" });
        continue;
      }

      accepted.push({
        path: relativePath,
        absolutePath: resolved,
        content: file.content,
      });
    }

    return { accepted, rejected };
  }

  createEphemeralWorkspace(projectPath: string): string {
    const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-code-tester-"));
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
    return destination;
  }

  cleanupWorkspace(workspacePath: string): void {
    fs.rmSync(path.dirname(workspacePath), { recursive: true, force: true });
  }

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

  private runCodexPass(params: {
    codexBin: string;
    model: string;
    schemaPath: string;
    prompt: string;
    projectPath: string;
    timeoutMs: number;
    label: string;
    skipGitRepoCheck?: boolean;
  }): CodexPassResult<any> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-runner-"));
    const outputFile = path.join(tempDir, `${params.label}-last-message.json`);
    const args = [
      "exec",
      ...(params.model ? ["-m", params.model] : []),
      "--json",
      "--ephemeral",
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
    const result = this.runCommand(params.codexBin, args, params.projectPath, params.prompt, params.timeoutMs);
    const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
    let payload: any = null;
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

  private async runCodexPassAsync(params: {
    codexBin: string;
    model: string;
    schemaPath: string;
    prompt: string;
    projectPath: string;
    timeoutMs: number;
    label: string;
    skipGitRepoCheck?: boolean;
  }): Promise<CodexPassResult<any>> {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "codex-local-runner-"));
    const outputFile = path.join(tempDir, `${params.label}-last-message.json`);
    const args = [
      "exec",
      ...(params.model ? ["-m", params.model] : []),
      "--json",
      "--ephemeral",
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
    const result = await this.runCommandAsync(params.codexBin, args, params.projectPath, params.prompt, params.timeoutMs);
    const outputText = fs.existsSync(outputFile) ? fs.readFileSync(outputFile, "utf8").trim() : "";
    let payload: any = null;
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

 
  private isTestLikePath(filePath: string): boolean {
    return /(^|\/)(tests?|__tests__)\/|(\.test\.|\.spec\.)|Test\.php$|_test\.go$|(^|\/)src\/test\//i.test(filePath);
  }

  private getAllowedPatterns(ecosystem: string): RegExp[] {
    switch (ecosystem) {
      case "node":
        return [/(\btests?\b|__tests__)\/.+/i, /.+\.(test|spec)\.[^.]+$/i];
      case "php":
        return [/(^|\/)tests\/.+/i, /.+Test\.php$/i];
      case "python":
        return [/(^|\/)tests\/.+\.py$/i, /(^|\/)test_[^/]+\.py$/i, /.+_test\.py$/i];
      case "java":
        return [/^src\/test\/.+/i];
      case "go":
        return [/.+_test\.go$/i];
      case "rust":
        return [/^tests\/.+/i];
      default:
        return [
          /(\btests?\b|__tests__)\/.+/i,
          /.+\.(test|spec)\.[^.]+$/i,
          /.+Test\.php$/i,
          /.+_test\.go$/i,
          /^src\/test\/.+/i,
        ];
    }
  }

  private collectCodexCandidates(bin: string): string[] {
    const candidates: string[] = [];

    if (bin && bin !== "codex") {
      candidates.push(this.expandHome(bin));
    }

    if (process.env.CODEX_BIN) {
      candidates.push(this.expandHome(process.env.CODEX_BIN));
    }

    const pathEntries = (process.env.PATH || "")
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of pathEntries) {
      candidates.push(path.join(entry, "codex"));
    }

    const home = os.homedir();
    const commonRoots = [
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions"),
      path.join(home, ".cursor", "extensions"),
    ];

    for (const root of commonRoots) {
      if (!fs.existsSync(root)) continue;

      let extensionDirs: string[] = [];
      try {
        extensionDirs = fs.readdirSync(root);
      } catch {
        continue;
      }

      for (const dir of extensionDirs) {
        if (!/openai\.chatgpt/i.test(dir)) continue;
        candidates.push(path.join(root, dir, "bin", "linux-x86_64", "codex"));
        candidates.push(path.join(root, dir, "bin", "darwin-aarch64", "codex"));
        candidates.push(path.join(root, dir, "bin", "darwin-x86_64", "codex"));
        candidates.push(path.join(root, dir, "bin", "win32-x86_64", "codex.exe"));
      }
    }

    return Array.from(new Set(candidates.map((candidate) => this.expandHome(candidate)).filter(Boolean)));
  }

  private expandHome(filePath: string): string {
    if (filePath === "~") return os.homedir();
    if (filePath.startsWith("~/")) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  private findExecutable(bin: string): string | null {
    const result = this.runCommand("which", [bin], undefined, undefined, 10000);
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  }

  private async ensureGitRepoAsync(projectPath: string): Promise<void> {
    const output = await this.runGitAsync(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (output !== "true") {
      throw new Error("Target project is not inside a git work tree");
    }
  }

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

  private runCommand(
    command: string,
    args: string[],
    cwd?: string,
    input?: string,
    timeout?: number,
  ): CommandResult {
    const result = spawnSync(command, args, {
      cwd,
      input,
      encoding: "utf8",
      env: process.env,
      timeout,
      maxBuffer: 16 * 1024 * 1024,
    });

    return {
      status: result.status,
      signal: result.signal,
      stdout: result.stdout || "",
      stderr: result.stderr || "",
      error: (result.error as NodeJS.ErrnoException | undefined) || null,
    };
  }

  private runCommandAsync(
    command: string,
    args: string[],
    cwd?: string,
    input?: string,
    timeout?: number,
  ): Promise<CommandResult> {
    return new Promise((resolve) => {
      let stdout = "";
      let stderr = "";
      let settled = false;
      let timeoutHandle: NodeJS.Timeout | null = null;
      let timeoutError: NodeJS.ErrnoException | null = null;

      const finish = (result: CommandResult) => {
        if (settled) return;
        settled = true;
        if (timeoutHandle) {
          clearTimeout(timeoutHandle);
        }
        resolve(result);
      };

      try {
        const child = spawn(command, args, {
          cwd,
          env: process.env,
          stdio: "pipe",
        });

        child.stdout.on("data", (chunk) => {
          stdout += chunk.toString();
        });

        child.stderr.on("data", (chunk) => {
          stderr += chunk.toString();
        });

        child.on("error", (error) => {
          finish({
            status: null,
            signal: null,
            stdout,
            stderr,
            error: error as NodeJS.ErrnoException,
          });
        });

        child.on("close", (status, signal) => {
          finish({
            status,
            signal,
            stdout,
            stderr,
            error: timeoutError,
          });
        });

        if (typeof input === "string" && input.length > 0) {
          child.stdin.write(input);
        }
        child.stdin.end();

        if (timeout && timeout > 0) {
          timeoutHandle = setTimeout(() => {
            const error = new Error(`Command timed out after ${timeout}ms`) as NodeJS.ErrnoException;
            error.code = "ETIMEDOUT";
            timeoutError = error;
            child.kill("SIGTERM");
          }, timeout);
        }
      } catch (error) {
        finish({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: error as NodeJS.ErrnoException,
        });
      }
    });
  }
}
