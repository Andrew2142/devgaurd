import fs from "fs";
import path from "path";
import { DatabaseSync } from "node:sqlite";
import { DevGuardConfig, ensureDevGuardDirs } from "./config";
import {
  CodeFinding,
  DependencyFinding,
  GeneratedArtifact,
  GitTargetMode,
  ProgressEntry,
  RunKind,
  RunStatus,
  StoredRun,
  TestsResult,
} from "./types";

type RunInsert = {
  kind: RunKind;
  status: RunStatus;
  repoPath: string;
  gitTarget: GitTargetMode;
  gitRefOrRange: string | null;
  model: string | null;
  dashboardUrl: string;
  summary: string;
  metadata?: Record<string, unknown>;
};

type RunPatch = Partial<{
  status: RunStatus;
  dashboardUrl: string;
  summary: string;
  error: string | null;
  completedAt: string | null;
  progressLog: ProgressEntry[];
  gitContext: Record<string, unknown> | null;
  testsResult: TestsResult | null;
  codeFindings: CodeFinding[];
  dependencyFindings: DependencyFinding[];
  generatedArtifacts: GeneratedArtifact[];
  metadata: Record<string, unknown>;
}>;

export class DevGuardStore {
  private db: DatabaseSync;

  constructor(private config: DevGuardConfig) {
    ensureDevGuardDirs(config);
    fs.mkdirSync(path.dirname(config.dbPath), { recursive: true });
    this.db = new DatabaseSync(config.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS runs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        kind TEXT NOT NULL,
        status TEXT NOT NULL,
        repo_path TEXT NOT NULL,
        git_target TEXT NOT NULL,
        git_ref_or_range TEXT,
        model TEXT,
        dashboard_url TEXT NOT NULL,
        summary TEXT NOT NULL,
        error TEXT,
        started_at TEXT NOT NULL,
        completed_at TEXT,
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        progress_log TEXT NOT NULL,
        git_context TEXT,
        tests_result TEXT,
        code_findings TEXT NOT NULL,
        dependency_findings TEXT NOT NULL,
        generated_artifacts TEXT NOT NULL,
        metadata TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS advisory_cache (
        cache_key TEXT PRIMARY KEY,
        response_json TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_runs_created_at ON runs(created_at DESC);
    `);
  }

  createRun(input: RunInsert): StoredRun {
    const now = new Date().toISOString();
    const statement = this.db.prepare(`
      INSERT INTO runs (
        kind, status, repo_path, git_target, git_ref_or_range, model, dashboard_url,
        summary, error, started_at, completed_at, created_at, updated_at, progress_log,
        git_context, tests_result, code_findings, dependency_findings, generated_artifacts, metadata
      ) VALUES (
        ?, ?, ?, ?, ?, ?, ?, ?, NULL, ?, NULL, ?, ?, ?, NULL, NULL, ?, ?, ?, ?
      )
    `);

    const result = statement.run(
      input.kind,
      input.status,
      input.repoPath,
      input.gitTarget,
      input.gitRefOrRange,
      input.model,
      input.dashboardUrl,
      input.summary,
      now,
      now,
      now,
      this.toJson([]),
      this.toJson([]),
      this.toJson([]),
      this.toJson([]),
      this.toJson(input.metadata || {}),
    );

    return this.getRun(Number(result.lastInsertRowid))!;
  }

  getRun(runId: number): StoredRun | null {
    const row = this.db.prepare("SELECT * FROM runs WHERE id = ?").get(runId) as Record<string, unknown> | undefined;
    return row ? this.mapRun(row) : null;
  }

  listRuns(limit = 20): StoredRun[] {
    const rows = this.db.prepare("SELECT * FROM runs ORDER BY created_at DESC LIMIT ?").all(limit) as Record<string, unknown>[];
    return rows.map((row) => this.mapRun(row));
  }

  updateRun(runId: number, patch: RunPatch): StoredRun {
    const current = this.getRun(runId);
    if (!current) {
      throw new Error(`Run ${runId} not found`);
    }

    const next: StoredRun = {
      ...current,
      status: patch.status ?? current.status,
      dashboardUrl: patch.dashboardUrl ?? current.dashboardUrl,
      summary: patch.summary ?? current.summary,
      error: patch.error !== undefined ? patch.error : current.error,
      completedAt: patch.completedAt !== undefined ? patch.completedAt : current.completedAt,
      updatedAt: new Date().toISOString(),
      progressLog: patch.progressLog ?? current.progressLog,
      gitContext: patch.gitContext !== undefined ? patch.gitContext : current.gitContext,
      testsResult: patch.testsResult !== undefined ? patch.testsResult : current.testsResult,
      codeFindings: patch.codeFindings ?? current.codeFindings,
      dependencyFindings: patch.dependencyFindings ?? current.dependencyFindings,
      generatedArtifacts: patch.generatedArtifacts ?? current.generatedArtifacts,
      metadata: patch.metadata ?? current.metadata,
    };

    this.db.prepare(`
      UPDATE runs
      SET status = ?, dashboard_url = ?, summary = ?, error = ?, completed_at = ?, updated_at = ?, progress_log = ?,
          git_context = ?, tests_result = ?, code_findings = ?, dependency_findings = ?,
          generated_artifacts = ?, metadata = ?
      WHERE id = ?
    `).run(
      next.status,
      next.dashboardUrl,
      next.summary,
      next.error,
      next.completedAt,
      next.updatedAt,
      this.toJson(next.progressLog),
      this.toJson(next.gitContext),
      this.toJson(next.testsResult),
      this.toJson(next.codeFindings),
      this.toJson(next.dependencyFindings),
      this.toJson(next.generatedArtifacts),
      this.toJson(next.metadata),
      runId,
    );

    return this.getRun(runId)!;
  }

  appendProgress(runId: number, step: string, message: string, status: "active" | "done" = "done"): StoredRun {
    const run = this.getRun(runId);
    if (!run) {
      throw new Error(`Run ${runId} not found`);
    }

    const nextLog: ProgressEntry[] = run.progressLog.map((entry) => ({
      ...entry,
      status: entry.status === "active" ? "done" : "done",
    }));
    nextLog.push({
      step,
      message,
      status,
      ts: new Date().toISOString(),
    });

    return this.updateRun(runId, { progressLog: nextLog });
  }

  getCachedAdvisory(cacheKey: string): unknown | null {
    const row = this.db.prepare("SELECT response_json FROM advisory_cache WHERE cache_key = ?").get(cacheKey) as { response_json?: string } | undefined;
    if (!row?.response_json) {
      return null;
    }

    return this.fromJson(row.response_json, null);
  }

  putCachedAdvisory(cacheKey: string, payload: unknown): void {
    this.db.prepare(`
      INSERT INTO advisory_cache(cache_key, response_json, updated_at)
      VALUES(?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        response_json = excluded.response_json,
        updated_at = excluded.updated_at
    `).run(cacheKey, this.toJson(payload), new Date().toISOString());
  }

  private mapRun(row: Record<string, unknown>): StoredRun {
    return {
      id: Number(row.id),
      kind: String(row.kind) as RunKind,
      status: String(row.status) as RunStatus,
      repoPath: String(row.repo_path),
      gitTarget: String(row.git_target) as GitTargetMode,
      gitRefOrRange: row.git_ref_or_range == null ? null : String(row.git_ref_or_range),
      model: row.model == null ? null : String(row.model),
      dashboardUrl: String(row.dashboard_url),
      summary: String(row.summary),
      error: row.error == null ? null : String(row.error),
      startedAt: String(row.started_at),
      completedAt: row.completed_at == null ? null : String(row.completed_at),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      progressLog: this.fromJson(row.progress_log, []),
      gitContext: this.fromJson(row.git_context, null),
      testsResult: this.fromJson(row.tests_result, null),
      codeFindings: this.fromJson(row.code_findings, []),
      dependencyFindings: this.fromJson(row.dependency_findings, []),
      generatedArtifacts: this.fromJson(row.generated_artifacts, []),
      metadata: this.fromJson(row.metadata, {}),
    };
  }

  private toJson(value: unknown): string {
    return JSON.stringify(value ?? null);
  }

  private fromJson<T>(value: unknown, fallback: T): T {
    if (typeof value !== "string" || value.trim() === "") {
      return fallback;
    }

    try {
      return JSON.parse(value) as T;
    } catch {
      return fallback;
    }
  }
}
