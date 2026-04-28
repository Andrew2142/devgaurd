import type { GitContext } from "./codex-runner-service";

/** Git target mode supported by the context service. */
type GitTarget = GitContext["mode"];
/** Synchronous function that runs git and returns stdout. */
type SyncGitRunner = (projectPath: string, args: string[]) => string;
/** Asynchronous function that runs git and returns stdout. */
type AsyncGitRunner = (projectPath: string, args: string[]) => Promise<string>;

/** Builds normalized git context for latest-commit, working-tree, and custom-range reviews. */
export class GitContextService {
  /** Creates a git context service with injected sync and async git runners. */
  constructor(
    private readonly runGit: SyncGitRunner,
    private readonly runGitAsync: AsyncGitRunner,
  ) {}

  /** Verifies synchronously that a project path is inside a git work tree. */
  ensureGitRepo(projectPath: string): void {
    const output = this.runGit(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (output !== "true") {
      throw new Error("Target project is not inside a git work tree");
    }
  }

  /** Verifies asynchronously that a project path is inside a git work tree. */
  async ensureGitRepoAsync(projectPath: string): Promise<void> {
    const output = await this.runGitAsync(projectPath, ["rev-parse", "--is-inside-work-tree"]);
    if (output !== "true") {
      throw new Error("Target project is not inside a git work tree");
    }
  }

  /** Resolves git context synchronously for the requested target mode. */
  getGitContext(
    projectPath: string,
    gitTarget: GitTarget,
    gitRange: string | undefined,
    maxDiffChars: number,
  ): GitContext {
    this.ensureGitRepo(projectPath);

    if (gitTarget === "latest-commit") {
      return this.getLatestCommitContext(projectPath, maxDiffChars);
    }

    if (gitTarget === "working-tree") {
      return this.getWorkingTreeContext(projectPath, maxDiffChars);
    }

    return this.getCustomRangeContext(projectPath, gitRange, maxDiffChars);
  }

  /** Resolves git context asynchronously for the requested target mode. */
  async getGitContextAsync(
    projectPath: string,
    gitTarget: GitTarget,
    gitRange: string | undefined,
    maxDiffChars: number,
  ): Promise<GitContext> {
    await this.ensureGitRepoAsync(projectPath);

    if (gitTarget === "latest-commit") {
      return this.getLatestCommitContextAsync(projectPath, maxDiffChars);
    }

    if (gitTarget === "working-tree") {
      return this.getWorkingTreeContextAsync(projectPath, maxDiffChars);
    }

    return this.getCustomRangeContextAsync(projectPath, gitRange, maxDiffChars);
  }

  /** Builds context for the most recent commit against its first parent. */
  private getLatestCommitContext(projectPath: string, maxDiffChars: number): GitContext {
    const head = this.runGit(projectPath, ["rev-parse", "HEAD"]);
    let base: string;

    try {
      base = this.runGit(projectPath, ["rev-parse", "HEAD~1"]);
    } catch {
      throw new Error("Latest-commit mode requires at least two commits");
    }

    const range = `${base}..${head}`;
    const changedFiles = this.getChangedFiles(projectPath, range);
    const diff = this.runGit(projectPath, ["diff", "--unified=3", range]);
    const summary = this.runGit(projectPath, ["show", "--stat", "--summary", "--format=fuller", head]);

    return this.buildContext("latest-commit", range, head, base, changedFiles, summary, diff, maxDiffChars);
  }

  /** Builds context asynchronously for the most recent commit against its first parent. */
  private async getLatestCommitContextAsync(projectPath: string, maxDiffChars: number): Promise<GitContext> {
    const head = await this.runGitAsync(projectPath, ["rev-parse", "HEAD"]);
    let base: string;

    try {
      base = await this.runGitAsync(projectPath, ["rev-parse", "HEAD~1"]);
    } catch {
      throw new Error("Latest-commit mode requires at least two commits");
    }

    const range = `${base}..${head}`;
    const changedFiles = await this.getChangedFilesAsync(projectPath, range);
    const diff = await this.runGitAsync(projectPath, ["diff", "--unified=3", range]);
    const summary = await this.runGitAsync(projectPath, ["show", "--stat", "--summary", "--format=fuller", head]);

    return this.buildContext("latest-commit", range, head, base, changedFiles, summary, diff, maxDiffChars);
  }

  /** Builds context for staged and unstaged working-tree changes. */
  private getWorkingTreeContext(projectPath: string, maxDiffChars: number): GitContext {
    const stagedFiles = this.parseGitLines(this.runGit(projectPath, ["diff", "--cached", "--name-only"]));
    const unstagedFiles = this.parseGitLines(this.runGit(projectPath, ["diff", "--name-only"]));
    const changedFiles = Array.from(new Set([...stagedFiles, ...unstagedFiles]));

    if (changedFiles.length === 0) {
      throw new Error("Working-tree mode requires staged or unstaged changes");
    }

    const stagedDiff = this.runGit(projectPath, ["diff", "--cached", "--unified=3"]);
    const unstagedDiff = this.runGit(projectPath, ["diff", "--unified=3"]);
    const diff = this.formatWorkingTreeDiff(stagedDiff, unstagedDiff);

    return this.buildContext(
      "working-tree",
      "working-tree",
      this.runGit(projectPath, ["rev-parse", "HEAD"]),
      null,
      changedFiles,
      this.runGit(projectPath, ["status", "--short"]),
      diff,
      maxDiffChars,
    );
  }

  /** Builds context asynchronously for staged and unstaged working-tree changes. */
  private async getWorkingTreeContextAsync(projectPath: string, maxDiffChars: number): Promise<GitContext> {
    const stagedFiles = this.parseGitLines(await this.runGitAsync(projectPath, ["diff", "--cached", "--name-only"]));
    const unstagedFiles = this.parseGitLines(await this.runGitAsync(projectPath, ["diff", "--name-only"]));
    const changedFiles = Array.from(new Set([...stagedFiles, ...unstagedFiles]));

    if (changedFiles.length === 0) {
      throw new Error("Working-tree mode requires staged or unstaged changes");
    }

    const stagedDiff = await this.runGitAsync(projectPath, ["diff", "--cached", "--unified=3"]);
    const unstagedDiff = await this.runGitAsync(projectPath, ["diff", "--unified=3"]);
    const diff = this.formatWorkingTreeDiff(stagedDiff, unstagedDiff);

    return this.buildContext(
      "working-tree",
      "working-tree",
      await this.runGitAsync(projectPath, ["rev-parse", "HEAD"]),
      null,
      changedFiles,
      await this.runGitAsync(projectPath, ["status", "--short"]),
      diff,
      maxDiffChars,
    );
  }

  /** Builds context for a caller-supplied commit or commit range. */
  private getCustomRangeContext(projectPath: string, gitRange: string | undefined, maxDiffChars: number): GitContext {
    const resolvedRange = this.normalizeCustomGitRange(gitRange);
    const changedFiles = this.getChangedFiles(projectPath, resolvedRange);

    if (changedFiles.length === 0) {
      throw new Error(`Custom git range produced no changed files: ${resolvedRange}`);
    }

    const diff = this.runGit(projectPath, ["diff", "--unified=3", resolvedRange]);
    const summary = this.runGit(projectPath, ["show", "--stat", "--summary", "--format=fuller", resolvedRange]);
    const [base, head] = resolvedRange.split("..");

    return this.buildContext("custom", resolvedRange, head || gitRange || resolvedRange, base || null, changedFiles, summary, diff, maxDiffChars);
  }

  /** Builds context asynchronously for a caller-supplied commit or commit range. */
  private async getCustomRangeContextAsync(projectPath: string, gitRange: string | undefined, maxDiffChars: number): Promise<GitContext> {
    const resolvedRange = this.normalizeCustomGitRange(gitRange);
    const changedFiles = await this.getChangedFilesAsync(projectPath, resolvedRange);

    if (changedFiles.length === 0) {
      throw new Error(`Custom git range produced no changed files: ${resolvedRange}`);
    }

    const diff = await this.runGitAsync(projectPath, ["diff", "--unified=3", resolvedRange]);
    const summary = await this.runGitAsync(projectPath, ["show", "--stat", "--summary", "--format=fuller", resolvedRange]);
    const [base, head] = resolvedRange.split("..");

    return this.buildContext("custom", resolvedRange, head || gitRange || resolvedRange, base || null, changedFiles, summary, diff, maxDiffChars);
  }

  /** Lists files changed in a git diff range. */
  private getChangedFiles(projectPath: string, range: string): string[] {
    return this.parseGitLines(this.runGit(projectPath, ["diff", "--name-only", range]));
  }

  /** Lists files changed in a git diff range asynchronously. */
  private async getChangedFilesAsync(projectPath: string, range: string): Promise<string[]> {
    return this.parseGitLines(await this.runGitAsync(projectPath, ["diff", "--name-only", range]));
  }

  /** Creates the normalized GitContext object shared with Codex prompts. */
  private buildContext(
    mode: GitTarget,
    resolvedRange: string,
    head: string,
    base: string | null,
    changedFiles: string[],
    summary: string,
    diff: string,
    maxDiffChars: number,
  ): GitContext {
    return {
      mode,
      resolvedRange,
      head,
      base,
      changedFiles,
      changedTestFiles: changedFiles.filter((filePath) => this.isTestLikePath(filePath)),
      summary,
      diff: diff.slice(0, maxDiffChars),
      diffTruncated: diff.length > maxDiffChars,
    };
  }

  /** Normalizes custom git input into a range accepted by git diff. */
  private normalizeCustomGitRange(gitRange: string | undefined): string {
    const trimmed = gitRange?.trim() || "";
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

    const firstCommit = commitIds[0];
    const lastCommit = commitIds[commitIds.length - 1];
    return `${firstCommit}^..${lastCommit}`;
  }

  /** Combines staged and unstaged diffs with labels for the prompt. */
  private formatWorkingTreeDiff(stagedDiff: string, unstagedDiff: string): string {
    return [
      "### STAGED DIFF ###",
      stagedDiff || "(none)",
      "",
      "### UNSTAGED DIFF ###",
      unstagedDiff || "(none)",
    ].join("\n");
  }

  /** Splits newline-delimited git output into non-empty trimmed lines. */
  private parseGitLines(output: string): string[] {
    return output
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
  }

  /** Detects whether a changed path appears to be a test file. */
  private isTestLikePath(filePath: string): boolean {
    return /(^|\/)(tests?|__tests__)\/|(\.test\.|\.spec\.)|Test\.php$|_test\.go$|(^|\/)src\/test\//i.test(filePath);
  }
}
