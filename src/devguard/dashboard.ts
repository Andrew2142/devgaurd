import express, { Request, Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { Server } from "node:http";
import { DASHBOARD_CSS, renderLiveRunScript } from "./dashboard-assets";
import { DevGuardConfig } from "./config";
import { DevGuardStore } from "./storage";
import {
  DependencyFinding,
  DependencyPackageSignal,
  DependencyScanResult,
  GeneratedArtifact,
  LintFinding,
  ProgressEntry,
  StoredRun,
  TestsResult,
} from "./types";

/** Hosts the local HTML dashboard and JSON run endpoints for DevGuard runs. */
export class DashboardServer {
  private app = express();
  private server: Server | null = null;
  private actualPort: number | null = null;
  private started = false;
  private disabled = false;
  private startupError: string | null = null;

  /** Creates a dashboard bound to the provided config and run store. */
  constructor(
    private config: DevGuardConfig,
    private store: DevGuardStore,
  ) {
    this.configureRoutes();
  }

  /** Starts the dashboard if possible and records startup failures without throwing. */
  async ensureStarted(): Promise<void> {
    if (this.started || this.disabled) {
      return;
    }

    try {
      const port = await this.findAvailablePort(this.config.dashboardPort);
      await new Promise<void>((resolve, reject) => {
        this.server = this.app.listen(port, this.config.dashboardHost, () => {
          this.actualPort = port;
          this.started = true;
          resolve();
        });
        this.server.on("error", reject);
      });
    } catch (error) {
      this.disabled = true;
      this.startupError = error instanceof Error ? error.message : "Unknown dashboard startup error";
    }
  }

  /** Returns the dashboard base URL or a sentinel URL when the dashboard is unavailable. */
  getBaseUrl(): string {
    if (!this.started) {
      return "dashboard-unavailable://local-ui";
    }
    const port = this.actualPort ?? this.config.dashboardPort;
    return `http://${this.config.dashboardHost}:${port}`;
  }

  /** Builds the dashboard URL for a specific run. */
  getRunUrl(runId: number): string {
    return `${this.getBaseUrl()}/runs/${runId}`;
  }

  /** Reports whether the dashboard successfully started. */
  isAvailable(): boolean {
    return this.started;
  }

  /** Returns the startup error captured when the dashboard could not bind. */
  getStartupError(): string | null {
    return this.startupError;
  }

  /** Closes the HTTP server when it is running. */
  async close(): Promise<void> {
    if (!this.server) {
      return;
    }

    await new Promise<void>((resolve, reject) => {
      this.server?.close((error) => {
        if (error) {
          reject(error);
          return;
        }

        resolve();
      });
    });
    this.server = null;
    this.started = false;
  }

  /** Registers dashboard HTML, API, and artifact routes. */
  private configureRoutes(): void {
    this.app.get("/", (_req, res) => res.redirect("/runs"));
    this.app.get("/health", (_req, res) => res.json({ ok: true, service: "devgaurd-dashboard" }));
    this.app.get("/api/runs/:id", (req, res) => this.sendRun(req, res));
    this.app.get("/runs", (_req, res) => {
      const runs = this.store.listRuns(50);
      const stats = summarizeRuns(runs);
      res.type("html").send(this.renderLayout("devgaurd Runs", `
        <header class="page-header">
          <div>
            <p class="eyebrow">Local MCP Console</p>
            <h1>devgaurd</h1>
            <p class="muted">Recent tool runs, generated artifacts, and scan results.</p>
          </div>
          <div class="metric-strip" aria-label="Run summary">
            ${this.renderMetric("Total", String(stats.total))}
            ${this.renderMetric("Running", String(stats.running))}
            ${this.renderMetric("Completed", String(stats.completed))}
            ${this.renderMetric("Failed", String(stats.failed))}
          </div>
        </header>
        <section class="panel">
          <div class="section-heading">
            <div>
              <h2>Recent Runs</h2>
              <p class="muted">Latest 50 persisted MCP-triggered runs.</p>
            </div>
          </div>
          ${this.renderRunList(runs)}
        </section>
      `));
    });
    this.app.get("/runs/:id", (req, res) => this.renderRun(req, res));
    this.app.get("/artifacts/:runId/:filename", (req, res) => this.sendArtifact(req, res));
  }

  /** Renders a single run detail page with live polling hooks. */
  private renderRun(req: Request, res: Response): void {
    const runId = parseInt(getRouteParam(req.params.id), 10);
    if (!Number.isFinite(runId)) {
      res.status(400).type("html").send(this.renderLayout("Invalid Run Id", "<h1>Invalid run id</h1>"));
      return;
    }
    const run = this.store.getRun(runId);
    if (!run) {
      res.status(404).type("html").send(this.renderLayout("Run Not Found", "<h1>Run not found</h1>"));
      return;
    }

    const viewRun = this.withDashboardMetadata(run);
    const dependencyPackages = this.getDependencyPackages(viewRun);
    const dependencyStats = summarizeDependencyPackages(dependencyPackages);
    const liveScript = renderLiveRunScript(run.id);

    const body = `
      <a class="back" href="/runs">Runs</a>
      <header class="detail-header">
        <div>
          <p class="eyebrow">Run #${viewRun.id}</p>
          <h1>${escapeHtml(formatRunKind(viewRun.kind))}</h1>
          <p class="summary-line" data-run-summary>${escapeHtml(viewRun.summary)}</p>
          <p class="error${viewRun.error ? "" : " hidden"}" data-run-error>${escapeHtml(viewRun.error || "")}</p>
        </div>
        <span class="${statusClass(viewRun.status)}" data-run-status>${escapeHtml(viewRun.status)}</span>
      </header>
      <div class="metric-strip detail-metrics" aria-label="Run details">
        ${this.renderMetric("Repository", path.basename(viewRun.repoPath), "data-run-repo")}
        ${this.renderMetric("Started", formatDate(viewRun.startedAt), "data-run-started")}
        ${this.renderMetric("Completed", viewRun.completedAt ? formatDate(viewRun.completedAt) : "-", "data-run-completed")}
        ${this.renderMetric("Artifacts", String(viewRun.generatedArtifacts.length), "data-run-artifact-count")}
      </div>
      <p class="live-state" data-live-state>Live updates every 2 seconds while the run is active.</p>
      <div class="content-grid">
        <section class="panel">
          <div class="section-heading">
            <h2>Progress</h2>
          </div>
          <ol class="timeline" data-run-progress>${this.renderProgressEntries(viewRun.progressLog)}</ol>
        </section>
        <section class="panel">
          <div class="section-heading">
            <h2>Artifacts</h2>
          </div>
          <div data-run-artifacts>${this.renderArtifacts(viewRun.id, viewRun.generatedArtifacts)}</div>
        </section>
      </div>
      <section class="panel">
        <div class="section-heading">
          <h2>Tests</h2>
        </div>
        <div data-run-tests>${this.renderTestsResult(viewRun.testsResult)}</div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <h2>Lint Findings</h2>
          <span class="count-pill" data-run-lint-count>${viewRun.lintFindings.length}</span>
        </div>
        <div data-run-lint>${this.renderLintFindings(viewRun.lintFindings)}</div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <h2>Dependency Vulnerabilities</h2>
          <span class="count-pill" data-run-dependency-count>${viewRun.dependencyFindings.length}</span>
        </div>
        <div data-run-dependencies>${this.renderDependencyFindings(viewRun.dependencyFindings)}</div>
      </section>
      <section class="panel">
        <div class="section-heading">
          <div>
            <h2>Dependencies Checked</h2>
            <p class="muted"><span data-run-package-count>${dependencyPackages.length}</span> total · <span data-run-direct-package-count>${dependencyStats.direct}</span> declared · <span data-run-transitive-package-count>${dependencyStats.transitive}</span> transitive · <span data-run-risk-package-count>${dependencyStats.riskFlags}</span> risk signals</p>
          </div>
        </div>
        <div data-run-package-list>${this.renderDependencyPackageList(dependencyPackages)}</div>
      </section>
      ${liveScript}
    `;

    res.type("html").send(this.renderLayout(`Run ${run.id}`, body));
  }

  /** Sends one run as JSON for live dashboard polling. */
  private sendRun(req: Request, res: Response): void {
    const runId = parseInt(getRouteParam(req.params.id), 10);
    if (!Number.isFinite(runId)) {
      res.status(400).json({ error: "Invalid run id" });
      return;
    }

    const run = this.store.getRun(runId);
    if (!run) {
      res.status(404).json({ error: "Run not found" });
      return;
    }

    res.json(this.withDashboardMetadata(run));
  }

  /** Sends a stored artifact file for a run after validating the route params. */
  private sendArtifact(req: Request, res: Response): void {
    const runId = parseInt(getRouteParam(req.params.runId), 10);
    const filename = path.basename(getRouteParam(req.params.filename));
    if (!Number.isFinite(runId) || !filename) {
      res.status(400).send("Invalid artifact path");
      return;
    }
    const fullPath = path.join(this.config.artifactsDir, String(runId), filename);
    if (!fs.existsSync(fullPath)) {
      res.status(404).send("Artifact not found");
      return;
    }
    res.sendFile(fullPath);
  }

  /** Renders the recent runs table for the dashboard index. */
  private renderRunList(runs: StoredRun[]): string {
    if (runs.length === 0) {
      return "<p class=\"empty-state\">No runs yet.</p>";
    }

    return `
      <div class="table-wrap">
        <table>
          <thead>
            <tr><th>Run</th><th>Tool</th><th>Status</th><th>Summary</th><th>Started</th><th>Repo</th></tr>
          </thead>
          <tbody>
            ${runs.map((run) => this.renderRunRow(run)).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  /** Renders one row in the recent runs table. */
  private renderRunRow(run: StoredRun): string {
    return `
      <tr>
        <td><a class="run-link" href="/runs/${run.id}">#${run.id}</a></td>
        <td>${escapeHtml(formatRunKind(run.kind))}</td>
        <td><span class="${statusClass(run.status)}">${escapeHtml(run.status)}</span></td>
        <td class="summary-cell">${escapeHtml(run.summary)}</td>
        <td>${escapeHtml(formatDate(run.startedAt))}</td>
        <td class="path-cell">${escapeHtml(path.basename(run.repoPath))}</td>
      </tr>
    `;
  }

  /** Renders a small labeled metric used in headers. */
  private renderMetric(label: string, value: string, valueAttribute = ""): string {
    const attribute = valueAttribute ? ` ${valueAttribute}` : "";

    return `
      <div class="metric">
        <span>${escapeHtml(label)}</span>
        <strong${attribute}>${escapeHtml(value)}</strong>
      </div>
    `;
  }

  /** Renders progress entries as a compact timeline. */
  private renderProgressEntries(entries: ProgressEntry[]): string {
    if (entries.length === 0) {
      return "<li class=\"empty-state\">No progress yet.</li>";
    }

    return entries.map((entry) => `
      <li>
        <span class="${entry.status === "active" ? "dot active" : "dot"}"></span>
        <div>
          <strong>${escapeHtml(entry.step)}</strong>
          <p>${escapeHtml(entry.message)}</p>
          <time>${escapeHtml(formatDate(entry.ts))}</time>
        </div>
      </li>
    `).join("");
  }

  /** Renders generated artifacts as compact action links. */
  private renderArtifacts(runId: number, artifacts: GeneratedArtifact[]): string {
    if (artifacts.length === 0) {
      return "<p class=\"empty-state\">No artifacts.</p>";
    }

    return `
      <div class="artifact-list">
        ${artifacts.map((artifact) => {
          const href = `/artifacts/${runId}/${encodeURIComponent(artifact.filename)}`;
          return `<a class="artifact-link" href="${href}">${escapeHtml(artifact.label)}</a>`;
        }).join("")}
      </div>
    `;
  }

  /** Renders generated-test workflow results without leading with raw JSON. */
  private renderTestsResult(result: TestsResult | null): string {
    if (!result) {
      return "<p class=\"empty-state\">No test result for this run.</p>";
    }

    const files = result.generatedFiles || [];
    return `
      <div class="metric-strip compact">
        ${this.renderMetric("Status", result.status)}
        ${this.renderMetric("Exit", result.exitCode == null ? "-" : String(result.exitCode))}
        ${this.renderMetric("Passed", result.passedCount == null ? "-" : String(result.passedCount))}
        ${this.renderMetric("Failed", result.failedCount == null ? "-" : String(result.failedCount))}
      </div>
      <p class="muted">Command: <code>${escapeHtml(result.testCommand || "-")}</code></p>
      ${files.length > 0 ? `<h3>Generated Files</h3><ul class="plain-list">${files.map((file) => `<li><code>${escapeHtml(file.path)}</code></li>`).join("")}</ul>` : ""}
      ${this.renderOutputDetails("stdout", result.stdout)}
      ${this.renderOutputDetails("stderr", result.stderr)}
    `;
  }

  /** Renders collapsible command output when present. */
  private renderOutputDetails(label: string, value?: string): string {
    if (!value?.trim()) {
      return "";
    }

    return `
      <details class="output-block">
        <summary>${escapeHtml(label)}</summary>
        <pre>${escapeHtml(value)}</pre>
      </details>
    `;
  }

  /** Renders lint findings as a table with a clean empty state. */
  private renderLintFindings(findings: LintFinding[]): string {
    if (findings.length === 0) {
      return "<p class=\"empty-state\">No lint findings.</p>";
    }

    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Severity</th><th>Rule</th><th>File</th><th>Message</th></tr></thead>
          <tbody>
            ${findings.slice(0, 100).map((finding) => `
              <tr>
                <td>${escapeHtml(finding.severity)}</td>
                <td><code>${escapeHtml(finding.rule)}</code></td>
                <td><code>${escapeHtml(`${finding.filePath}${finding.line ? `:${finding.line}` : ""}`)}</code></td>
                <td>${escapeHtml(finding.message)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  /** Renders OSV vulnerability findings as a table with a clear healthy state. */
  private renderDependencyFindings(findings: DependencyFinding[]): string {
    if (findings.length === 0) {
      return "<p class=\"empty-state\">No known vulnerabilities for the locked dependency versions.</p>";
    }

    return `
      <div class="table-wrap">
        <table>
          <thead><tr><th>Package</th><th>Severity</th><th>Advisory</th><th>Summary</th></tr></thead>
          <tbody>
            ${findings.slice(0, 100).map((finding) => `
              <tr>
                <td><code>${escapeHtml(`${finding.packageName}@${finding.version}`)}</code></td>
                <td>${escapeHtml(finding.severity)}</td>
                <td><code>${escapeHtml(finding.advisoryId)}</code></td>
                <td>${escapeHtml(finding.summary)}</td>
              </tr>
            `).join("")}
          </tbody>
        </table>
      </div>
    `;
  }

  /** Renders a compact dependency inventory table for dependency scan runs. */
  private renderDependencyPackageList(packages: DependencyPackageSignal[]): string {
    if (packages.length === 0) {
      return "<p class=\"empty-state\">No dependency inventory stored for this run.</p>";
    }

    const direct = packages.filter((item) => item.direct);
    const transitive = packages.filter((item) => !item.direct);

    return `
      ${this.renderDependencyPackageTable("Declared Dependencies", direct)}
      <details class="dependency-details" open>
        <summary>Transitive Dependencies (${transitive.length})</summary>
        ${this.renderDependencyPackageTable("", transitive)}
      </details>
    `;
  }

  /** Renders one dependency package table. */
  private renderDependencyPackageTable(label: string, packages: DependencyPackageSignal[]): string {
    if (packages.length === 0) {
      return label ? `<h3>${escapeHtml(label)}</h3><p class="empty-state">None.</p>` : "<p class=\"empty-state\">None.</p>";
    }

    const rows = packages.slice(0, 250).map((item) => `
      <tr>
        <td><code>${escapeHtml(item.packageName)}</code></td>
        <td>${escapeHtml(item.version)}</td>
        <td>${item.devDependency ? "dev" : "prod"}</td>
        <td>${escapeHtml(item.riskFlags.length > 0 ? item.riskFlags.join(", ") : "none")}</td>
      </tr>
    `).join("");

    return `
      ${label ? `<h3>${escapeHtml(label)}</h3>` : ""}
      <div class="table-wrap dependency-table-wrap">
        <table class="dependency-table">
          <thead>
            <tr><th>Package</th><th>Version</th><th>Scope</th><th>Risk flags</th></tr>
          </thead>
          <tbody>${rows}</tbody>
        </table>
      </div>
    `;
  }

  /** Adds dashboard-only metadata, such as artifact-backed dependency inventory, to a run response. */
  private withDashboardMetadata(run: StoredRun): StoredRun {
    const dependencyPackages = this.getDependencyPackages(run);
    if (dependencyPackages.length === 0) {
      return run;
    }

    return {
      ...run,
      metadata: {
        ...run.metadata,
        dependencyPackages,
      },
    };
  }

  /** Reads dependency inventory from run metadata or the dependency-report artifact. */
  private getDependencyPackages(run: StoredRun): DependencyPackageSignal[] {
    const metadataPackages = getMetadataDependencyPackages(run);
    if (metadataPackages.length > 0) {
      return metadataPackages;
    }

    return this.getArtifactDependencyPackages(run.id);
  }

  /** Reads dependency inventory from dependency-report.json for older runs. */
  private getArtifactDependencyPackages(runId: number): DependencyPackageSignal[] {
    const artifactPath = path.join(this.config.artifactsDir, String(runId), "dependency-report.json");
    if (!fs.existsSync(artifactPath)) {
      return [];
    }

    try {
      const payload = JSON.parse(fs.readFileSync(artifactPath, "utf8")) as DependencyScanResult;
      return (payload.report?.packageSignals || []).filter(isDependencyPackageSignal);
    } catch {
      return [];
    }
  }

  /** Renders the shared HTML shell and dashboard styles. */
  private renderLayout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>${DASHBOARD_CSS}</style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
  }

  /** Finds a free dashboard port near the configured preferred port. */
  private async findAvailablePort(startPort: number): Promise<number> {
    for (let port = startPort; port < startPort + 20; port += 1) {
      try {
        await new Promise<void>((resolve, reject) => {
          const tester = this.app.listen(port, this.config.dashboardHost, () => {
            tester.close(() => resolve());
          });
          tester.on("error", reject);
        });
        return port;
      } catch {
        continue;
      }
    }

    throw new Error("Unable to find a free dashboard port");
  }
}

/** Escapes text before embedding it into server-rendered HTML. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** Normalizes Express route params that can arrive as a string array. */
function getRouteParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] || "" : value || "";
}

/** Formats an ISO date for compact dashboard display. */
function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return date.toLocaleString("en", {
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/** Formats internal run kind names for human-facing headings. */
function formatRunKind(value: string): string {
  return value
    .split("_")
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ");
}

/** Builds the CSS class list for a run status badge. */
function statusClass(status: string): string {
  const normalized = status.replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
  return `status-pill status-${normalized}`;
}

/** Summarizes recent run statuses for the dashboard index. */
function summarizeRuns(runs: StoredRun[]): { total: number; running: number; completed: number; failed: number } {
  return {
    total: runs.length,
    running: runs.filter((run) => !["completed", "failed"].includes(run.status)).length,
    completed: runs.filter((run) => run.status === "completed").length,
    failed: runs.filter((run) => run.status === "failed").length,
  };
}

/** Summarizes package inventory counts for dependency-scan dashboard sections. */
function summarizeDependencyPackages(packages: DependencyPackageSignal[]): {
  direct: number;
  transitive: number;
  riskFlags: number;
} {
  return {
    direct: packages.filter((item) => item.direct).length,
    transitive: packages.filter((item) => !item.direct).length,
    riskFlags: packages.reduce((total, item) => total + item.riskFlags.length, 0),
  };
}

/** Extracts the dependency package inventory stored in run metadata. */
function getMetadataDependencyPackages(run: StoredRun): DependencyPackageSignal[] {
  const packages = run.metadata.dependencyPackages;
  if (!Array.isArray(packages)) {
    return [];
  }

  return packages.filter(isDependencyPackageSignal);
}

/** Validates one dependency package row from untyped run metadata. */
function isDependencyPackageSignal(value: unknown): value is DependencyPackageSignal {
  if (!value || typeof value !== "object") {
    return false;
  }

  const item = value as Partial<DependencyPackageSignal>;
  return (
    typeof item.packageName === "string"
    && typeof item.version === "string"
    && typeof item.direct === "boolean"
    && typeof item.devDependency === "boolean"
    && Array.isArray(item.riskFlags)
  );
}
