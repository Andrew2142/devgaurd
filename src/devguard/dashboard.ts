import express, { Request, Response } from "express";
import fs from "fs";
import path from "path";
import { Server } from "http";
import { DevGuardConfig } from "./config";
import { DevGuardStore } from "./storage";
import { StoredRun } from "./types";

export class DashboardServer {
  private app = express();
  private server: Server | null = null;
  private actualPort: number | null = null;
  private started = false;
  private disabled = false;
  private startupError: string | null = null;

  constructor(
    private config: DevGuardConfig,
    private store: DevGuardStore,
  ) {
    this.configureRoutes();
  }

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

  getBaseUrl(): string {
    if (!this.started) {
      return "dashboard-unavailable://local-ui";
    }
    const port = this.actualPort ?? this.config.dashboardPort;
    return `http://${this.config.dashboardHost}:${port}`;
  }

  getRunUrl(runId: number): string {
    return `${this.getBaseUrl()}/runs/${runId}`;
  }

  isAvailable(): boolean {
    return this.started;
  }

  getStartupError(): string | null {
    return this.startupError;
  }

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

  private configureRoutes(): void {
    this.app.get("/", (_req, res) => res.redirect("/runs"));
    this.app.get("/health", (_req, res) => res.json({ ok: true, service: "devguard-dashboard" }));
    this.app.get("/runs", (_req, res) => {
      const runs = this.store.listRuns(50);
      res.type("html").send(this.renderLayout("DevGuard Runs", `
        <h1>DevGuard Runs</h1>
        <p class="muted">Recent MCP-triggered reviews and scans.</p>
        <div class="list">
          ${runs.map((run) => this.renderRunCard(run)).join("") || "<p>No runs yet.</p>"}
        </div>
      `));
    });
    this.app.get("/runs/:id", (req, res) => this.renderRun(req, res));
    this.app.get("/artifacts/:runId/:filename", (req, res) => this.sendArtifact(req, res));
  }

  private renderRun(req: Request, res: Response): void {
    const runId = parseInt(req.params.id, 10);
    const run = this.store.getRun(runId);
    if (!run) {
      res.status(404).type("html").send(this.renderLayout("Run Not Found", "<h1>Run not found</h1>"));
      return;
    }

    const artifactList = run.generatedArtifacts.map((artifact) => {
      const href = `/artifacts/${run.id}/${encodeURIComponent(artifact.filename)}`;
      return `<li><a href="${href}">${escapeHtml(artifact.label)}</a></li>`;
    }).join("");

    const body = `
      <a class="back" href="/runs">Back to runs</a>
      <h1>${escapeHtml(run.kind)} #${run.id}</h1>
      <div class="grid">
        <div class="card"><strong>Status</strong><span>${escapeHtml(run.status)}</span></div>
        <div class="card"><strong>Repo</strong><span>${escapeHtml(run.repoPath)}</span></div>
        <div class="card"><strong>Started</strong><span>${escapeHtml(run.startedAt)}</span></div>
        <div class="card"><strong>Completed</strong><span>${escapeHtml(run.completedAt || "-")}</span></div>
      </div>
      <section>
        <h2>Summary</h2>
        <p>${escapeHtml(run.summary)}</p>
        ${run.error ? `<p class="error">${escapeHtml(run.error)}</p>` : ""}
      </section>
      <section>
        <h2>Progress</h2>
        <ul>${run.progressLog.map((entry) => `<li>${escapeHtml(entry.ts)} · ${escapeHtml(entry.step)} · ${escapeHtml(entry.message)}</li>`).join("")}</ul>
      </section>
      <section>
        <h2>Tests</h2>
        <pre>${escapeHtml(JSON.stringify(run.testsResult, null, 2))}</pre>
      </section>
      <section>
        <h2>Code Findings (${run.codeFindings.length})</h2>
        <pre>${escapeHtml(JSON.stringify(run.codeFindings.slice(0, 100), null, 2))}</pre>
      </section>
      <section>
        <h2>Dependency Findings (${run.dependencyFindings.length})</h2>
        <pre>${escapeHtml(JSON.stringify(run.dependencyFindings.slice(0, 100), null, 2))}</pre>
      </section>
      <section>
        <h2>Artifacts</h2>
        <ul>${artifactList || "<li>No artifacts</li>"}</ul>
      </section>
    `;

    res.type("html").send(this.renderLayout(`Run ${run.id}`, body));
  }

  private sendArtifact(req: Request, res: Response): void {
    const runId = parseInt(req.params.runId, 10);
    const filename = path.basename(req.params.filename);
    const fullPath = path.join(this.config.artifactsDir, String(runId), filename);
    if (!fs.existsSync(fullPath)) {
      res.status(404).send("Artifact not found");
      return;
    }
    res.sendFile(fullPath);
  }

  private renderRunCard(run: StoredRun): string {
    return `
      <a class="run-card" href="/runs/${run.id}">
        <div class="row"><strong>${escapeHtml(run.kind)}</strong><span>${escapeHtml(run.status)}</span></div>
        <div class="muted">${escapeHtml(run.summary)}</div>
        <div class="tiny">${escapeHtml(run.repoPath)}</div>
      </a>
    `;
  }

  private renderLayout(title: string, body: string): string {
    return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>${escapeHtml(title)}</title>
    <style>
      :root { color-scheme: light; --bg: #f4f2ea; --panel: #fffdf7; --ink: #23201b; --muted: #6b6257; --accent: #1b6a5a; --border: #d8cfbe; --danger: #a52a2a; }
      body { margin: 0; font-family: "IBM Plex Sans", "Segoe UI", sans-serif; background: radial-gradient(circle at top, #fff8dd 0%, var(--bg) 55%); color: var(--ink); }
      main { max-width: 1100px; margin: 0 auto; padding: 2rem 1rem 4rem; }
      h1, h2 { font-family: Georgia, "Times New Roman", serif; }
      .list { display: grid; gap: 1rem; }
      .run-card, .card, section { display: block; background: var(--panel); border: 1px solid var(--border); border-radius: 18px; padding: 1rem 1.1rem; box-shadow: 0 8px 24px rgba(35, 32, 27, 0.06); text-decoration: none; color: inherit; }
      .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(220px, 1fr)); gap: 0.75rem; }
      .row { display: flex; justify-content: space-between; gap: 1rem; align-items: center; }
      .muted { color: var(--muted); }
      .tiny { color: var(--muted); font-size: 0.9rem; margin-top: 0.35rem; }
      .back { display: inline-block; margin-bottom: 1rem; color: var(--accent); }
      .error { color: var(--danger); }
      pre { white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-size: 0.9rem; }
      ul { padding-left: 1.1rem; }
    </style>
  </head>
  <body>
    <main>${body}</main>
  </body>
</html>`;
  }

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

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
