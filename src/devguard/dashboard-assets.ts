/** Styles for the local DevGuard dashboard. */
export const DASHBOARD_CSS = `
  :root {
    color-scheme: light;
    --bg: #f7f8fa;
    --panel: #ffffff;
    --ink: #17202a;
    --muted: #637083;
    --line: #d9e0e8;
    --soft: #eef2f6;
    --accent: #0f766e;
    --accent-soft: #dff7f3;
    --danger: #b42318;
    --warning: #a15c00;
    --success: #1a7f37;
    --info: #1d4ed8;
  }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; background: var(--bg); color: var(--ink); }
  main { max-width: 1240px; margin: 0 auto; padding: 28px 20px 56px; }
  h1, h2, h3, p { margin-top: 0; }
  h1 { margin-bottom: 8px; font-size: clamp(2rem, 4vw, 3.25rem); line-height: 1.05; letter-spacing: 0; }
  h2 { margin-bottom: 0; font-size: 1rem; letter-spacing: 0; }
  h3 { margin: 18px 0 10px; font-size: 0.92rem; letter-spacing: 0; }
  code { font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 0.92em; }
  a { color: var(--accent); }
  .page-header, .detail-header { display: flex; align-items: flex-start; justify-content: space-between; gap: 24px; margin-bottom: 18px; }
  .detail-header { padding-bottom: 18px; border-bottom: 1px solid var(--line); }
  .eyebrow { margin-bottom: 8px; color: var(--muted); font-size: 0.78rem; font-weight: 700; letter-spacing: 0.08em; text-transform: uppercase; }
  .summary-line { max-width: 820px; margin-bottom: 0; color: var(--muted); font-size: 1rem; line-height: 1.5; }
  .muted { color: var(--muted); }
  .live-state { margin: 12px 0 18px; color: var(--muted); font-size: 0.9rem; }
  .back { display: inline-flex; margin-bottom: 16px; color: var(--accent); font-weight: 700; text-decoration: none; }
  .back:hover, .run-link:hover, .artifact-link:hover { text-decoration: underline; }
  .panel { display: block; margin-top: 16px; padding: 18px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; box-shadow: 0 1px 2px rgba(23, 32, 42, 0.04); }
  .section-heading { display: flex; align-items: flex-start; justify-content: space-between; gap: 16px; margin-bottom: 14px; }
  .section-heading p { margin: 6px 0 0; }
  .metric-strip { display: grid; grid-template-columns: repeat(4, minmax(120px, 1fr)); gap: 10px; min-width: min(100%, 520px); }
  .metric-strip.compact { grid-template-columns: repeat(4, minmax(96px, 1fr)); min-width: 0; margin-bottom: 14px; }
  .detail-metrics { grid-template-columns: repeat(4, minmax(160px, 1fr)); min-width: 0; }
  .metric { min-width: 0; padding: 12px; background: var(--panel); border: 1px solid var(--line); border-radius: 8px; }
  .metric span { display: block; margin-bottom: 6px; color: var(--muted); font-size: 0.75rem; font-weight: 700; text-transform: uppercase; }
  .metric strong { display: block; overflow: hidden; color: var(--ink); font-size: 1rem; text-overflow: ellipsis; white-space: nowrap; }
  .content-grid { display: grid; grid-template-columns: minmax(0, 1.5fr) minmax(280px, 0.8fr); gap: 16px; align-items: start; }
  .status-pill, .count-pill { display: inline-flex; align-items: center; justify-content: center; min-height: 28px; padding: 4px 10px; border-radius: 999px; font-size: 0.78rem; font-weight: 800; text-transform: uppercase; white-space: nowrap; }
  .status-completed { color: var(--success); background: #e9f8ee; border: 1px solid #bfe7cb; }
  .status-failed { color: var(--danger); background: #fff0ee; border: 1px solid #ffc9c2; }
  .status-queued, .status-collecting_git, .status-generating_tests, .status-running_tests, .status-linting_code, .status-scanning_code, .status-scanning_dependencies { color: var(--info); background: #edf4ff; border: 1px solid #c8dcff; }
  .count-pill { min-width: 34px; color: var(--accent); background: var(--accent-soft); border: 1px solid #b8e8df; }
  .table-wrap { width: 100%; overflow-x: auto; border: 1px solid var(--line); border-radius: 8px; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9rem; background: var(--panel); }
  th, td { border-bottom: 1px solid var(--line); padding: 10px 12px; text-align: left; vertical-align: top; }
  th { color: var(--muted); background: var(--soft); font-size: 0.75rem; font-weight: 800; text-transform: uppercase; white-space: nowrap; }
  tr:last-child td { border-bottom: 0; }
  .summary-cell { min-width: 260px; max-width: 520px; }
  .path-cell { color: var(--muted); font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; }
  .run-link { font-weight: 800; text-decoration: none; }
  .timeline { display: grid; gap: 14px; margin: 0; padding: 0; list-style: none; }
  .timeline li { display: grid; grid-template-columns: 18px minmax(0, 1fr); gap: 10px; }
  .timeline p { margin: 4px 0; color: var(--muted); line-height: 1.45; }
  .timeline time { color: var(--muted); font-size: 0.8rem; }
  .dot { width: 10px; height: 10px; margin-top: 5px; border-radius: 999px; background: var(--line); }
  .dot.active { background: var(--info); }
  .artifact-list { display: flex; flex-wrap: wrap; gap: 8px; }
  .artifact-link { display: inline-flex; min-height: 32px; align-items: center; padding: 6px 10px; border: 1px solid var(--line); border-radius: 8px; background: var(--soft); color: var(--ink); text-decoration: none; }
  .plain-list { margin: 0 0 12px; padding-left: 18px; }
  .output-block { margin-top: 10px; border: 1px solid var(--line); border-radius: 8px; background: #fbfcfe; }
  .output-block summary { cursor: pointer; padding: 10px 12px; color: var(--muted); font-weight: 700; }
  pre { margin: 0; padding: 12px; white-space: pre-wrap; word-break: break-word; overflow-wrap: anywhere; font-size: 0.85rem; }
  .empty-state { margin: 0; color: var(--muted); }
  .error { margin-top: 10px; color: var(--danger); }
  .hidden { display: none; }
  .dependency-table-wrap { max-height: 420px; overflow: auto; }
  .dependency-table td:first-child { min-width: 220px; }
  .dependency-details { margin-top: 14px; }
  .dependency-details summary { cursor: pointer; color: var(--muted); font-weight: 800; }
  @media (max-width: 820px) {
    main { padding: 20px 12px 40px; }
    .page-header, .detail-header { display: block; }
    .metric-strip, .detail-metrics, .metric-strip.compact { grid-template-columns: repeat(2, minmax(0, 1fr)); min-width: 0; }
    .content-grid { grid-template-columns: 1fr; }
  }
  @media (max-width: 520px) {
    .metric-strip, .detail-metrics, .metric-strip.compact { grid-template-columns: 1fr; }
    th, td { padding: 9px 10px; }
  }
`;

/** Renders the client-side polling script that refreshes run details. */
export function renderLiveRunScript(runId: number): string {
  return `<script>
    (() => {
      const runId = ${JSON.stringify(runId)};
      const liveState = document.querySelector("[data-live-state]");
      const statusEl = document.querySelector("[data-run-status]");
      const repoEl = document.querySelector("[data-run-repo]");
      const startedEl = document.querySelector("[data-run-started]");
      const completedEl = document.querySelector("[data-run-completed]");
      const artifactCountEl = document.querySelector("[data-run-artifact-count]");
      const summaryEl = document.querySelector("[data-run-summary]");
      const errorEl = document.querySelector("[data-run-error]");
      const progressEl = document.querySelector("[data-run-progress]");
      const testsEl = document.querySelector("[data-run-tests]");
      const lintCountEl = document.querySelector("[data-run-lint-count]");
      const lintEl = document.querySelector("[data-run-lint]");
      const dependencyCountEl = document.querySelector("[data-run-dependency-count]");
      const dependencyEl = document.querySelector("[data-run-dependencies]");
      const packageCountEl = document.querySelector("[data-run-package-count]");
      const directPackageCountEl = document.querySelector("[data-run-direct-package-count]");
      const transitivePackageCountEl = document.querySelector("[data-run-transitive-package-count]");
      const riskPackageCountEl = document.querySelector("[data-run-risk-package-count]");
      const packageListEl = document.querySelector("[data-run-package-list]");
      const artifactsEl = document.querySelector("[data-run-artifacts]");
      const terminalStates = new Set(["completed", "failed"]);

      const setText = (element, value) => {
        if (element) element.textContent = value;
      };

      const setPre = (element, value) => {
        if (!element) return;
        element.textContent = "";
        const pre = document.createElement("pre");
        pre.textContent = JSON.stringify(value, null, 2);
        element.appendChild(pre);
      };

      const statusClass = (status) => {
        const normalized = String(status || "").replace(/[^a-z0-9_-]/gi, "-").toLowerCase();
        return "status-pill status-" + normalized;
      };

      const setError = (message) => {
        if (!errorEl) return;
        errorEl.textContent = message || "";
        errorEl.classList.toggle("hidden", !message);
      };

      const renderProgress = (run) => {
        if (!progressEl) return;
        progressEl.textContent = "";
        const entries = run.progressLog || [];
        if (entries.length === 0) {
          const item = document.createElement("li");
          item.textContent = "No progress yet.";
          progressEl.appendChild(item);
          return;
        }
        for (const entry of entries) {
          const item = document.createElement("li");
          const dot = document.createElement("span");
          dot.className = entry.status === "active" ? "dot active" : "dot";
          const content = document.createElement("div");
          const step = document.createElement("strong");
          step.textContent = String(entry.step);
          const message = document.createElement("p");
          message.textContent = String(entry.message);
          const time = document.createElement("time");
          time.textContent = String(entry.ts);
          content.appendChild(step);
          content.appendChild(message);
          content.appendChild(time);
          item.appendChild(dot);
          item.appendChild(content);
          progressEl.appendChild(item);
        }
      };

      const renderArtifacts = (run) => {
        if (!artifactsEl) return;
        artifactsEl.textContent = "";
        const artifacts = run.generatedArtifacts || [];
        if (artifacts.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No artifacts.";
          artifactsEl.appendChild(empty);
          return;
        }
        const list = document.createElement("div");
        list.className = "artifact-list";
        for (const artifact of artifacts) {
          const link = document.createElement("a");
          link.className = "artifact-link";
          link.href = "/artifacts/" + encodeURIComponent(String(run.id)) + "/" + encodeURIComponent(artifact.filename);
          link.textContent = artifact.label;
          list.appendChild(link);
        }
        artifactsEl.appendChild(list);
      };

      const getDependencyPackages = (run) => {
        const packages = run.metadata && Array.isArray(run.metadata.dependencyPackages)
          ? run.metadata.dependencyPackages
          : [];
        return packages.slice(0, 250);
      };

      const packageRiskCount = (packages) => packages.reduce((total, item) => (
        total + (Array.isArray(item.riskFlags) ? item.riskFlags.length : 0)
      ), 0);

      const renderDependencyTable = (heading, packages) => {
        const fragment = document.createDocumentFragment();
        if (heading) {
          const title = document.createElement("h3");
          title.textContent = heading;
          fragment.appendChild(title);
        }
        if (packages.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "None.";
          fragment.appendChild(empty);
          return fragment;
        }
        const wrap = document.createElement("div");
        wrap.className = "table-wrap dependency-table-wrap";
        const table = document.createElement("table");
        table.className = "dependency-table";
        const header = document.createElement("thead");
        const headerRow = document.createElement("tr");
        for (const title of ["Package", "Version", "Scope", "Risk flags"]) {
          const cell = document.createElement("th");
          cell.textContent = title;
          headerRow.appendChild(cell);
        }
        header.appendChild(headerRow);
        table.appendChild(header);
        const body = document.createElement("tbody");
        for (const item of packages) {
          const row = document.createElement("tr");
          const flags = Array.isArray(item.riskFlags) && item.riskFlags.length > 0
            ? item.riskFlags.join(", ")
            : "none";
          for (const value of [
            String(item.packageName || ""),
            String(item.version || ""),
            item.devDependency ? "dev" : "prod",
            flags,
          ]) {
            const cell = document.createElement("td");
            cell.textContent = value;
            row.appendChild(cell);
          }
          body.appendChild(row);
        }
        table.appendChild(body);
        wrap.appendChild(table);
        fragment.appendChild(wrap);
        return fragment;
      };

      const renderDependencyPackages = (run) => {
        if (!packageListEl) return;
        const packages = getDependencyPackages(run);
        const direct = packages.filter((item) => item.direct);
        const transitive = packages.filter((item) => !item.direct);
        setText(packageCountEl, String(packages.length));
        setText(directPackageCountEl, String(direct.length));
        setText(transitivePackageCountEl, String(transitive.length));
        setText(riskPackageCountEl, String(packageRiskCount(packages)));
        packageListEl.textContent = "";
        if (packages.length === 0) {
          const empty = document.createElement("p");
          empty.className = "empty-state";
          empty.textContent = "No dependency inventory stored for this run.";
          packageListEl.appendChild(empty);
          return;
        }

        packageListEl.appendChild(renderDependencyTable("Declared Dependencies", direct));
        const details = document.createElement("details");
        details.className = "dependency-details";
        details.open = true;
        const summary = document.createElement("summary");
        summary.textContent = "Transitive Dependencies (" + transitive.length + ")";
        details.appendChild(summary);
        details.appendChild(renderDependencyTable("", transitive));
        packageListEl.appendChild(details);
      };

      const applyRun = (run) => {
        setText(statusEl, run.status);
        if (statusEl) statusEl.className = statusClass(run.status);
        setText(repoEl, run.repoPath);
        setText(startedEl, run.startedAt);
        setText(completedEl, run.completedAt || "-");
        setText(artifactCountEl, String((run.generatedArtifacts || []).length));
        setText(summaryEl, run.summary);
        setError(run.error || "");
        renderProgress(run);
        setPre(testsEl, run.testsResult);
        setText(lintCountEl, String((run.lintFindings || []).length));
        setPre(lintEl, (run.lintFindings || []).slice(0, 100));
        setText(dependencyCountEl, String((run.dependencyFindings || []).length));
        setPre(dependencyEl, (run.dependencyFindings || []).slice(0, 100));
        renderDependencyPackages(run);
        renderArtifacts(run);

        if (liveState) {
          liveState.textContent = terminalStates.has(run.status)
            ? "Live updates stopped. Run finished with status: " + run.status + "."
            : "Live updates every 2 seconds while the run is active.";
        }
      };

      const refresh = async () => {
        try {
          const response = await fetch("/api/runs/" + encodeURIComponent(String(runId)), {
            headers: { "Accept": "application/json" },
            cache: "no-store",
          });
          if (!response.ok) {
            throw new Error("HTTP " + response.status);
          }
          const run = await response.json();
          applyRun(run);
          if (terminalStates.has(run.status) && timer) {
            clearInterval(timer);
            timer = null;
          }
        } catch (error) {
          if (liveState) {
            liveState.textContent = "Live update failed. Retrying...";
          }
        }
      };

      let timer = window.setInterval(refresh, 2000);
    })();
  </script>`;
}
