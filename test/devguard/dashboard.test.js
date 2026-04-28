const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { DashboardServer } = require("../../dist/devguard/dashboard.js");
const { DevGuardStore } = require("../../dist/devguard/storage.js");
const { createConfig } = require("./helpers.js");

test("dashboard exposes a JSON run endpoint", async () => {
  const config = createConfig("devguard-dashboard-test-");
  const store = new DevGuardStore(config);
  const dashboard = new DashboardServer(config, store);

  const run = store.createRun({
    kind: "lint_code",
    status: "queued",
    repoPath: "/tmp/example",
    gitTarget: "working-tree",
    gitRefOrRange: null,
    model: "gpt-5.2-codex",
    dashboardUrl: dashboard.getRunUrl(1),
    summary: "queued",
    metadata: {},
  });
  store.appendProgress(run.id, "queued", "Run created", "active");

  let statusCode = 200;
  let payload = null;
  const req = { params: { id: String(run.id) } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    json(value) {
      payload = value;
      return this;
    },
  };

  dashboard.sendRun(req, res);

  assert.equal(statusCode, 200);
  assert.equal(payload.id, run.id);
  assert.equal(payload.status, "queued");
  assert.equal(Array.isArray(payload.progressLog), true);
  assert.equal(payload.progressLog.length, 1);
});

test("dashboard run page includes live polling hooks", async () => {
  const config = createConfig("devguard-dashboard-live-page-test-");
  const store = new DevGuardStore(config);
  const dashboard = new DashboardServer(config, store);

  const run = store.createRun({
    kind: "run_full_review",
    status: "generating_tests",
    repoPath: "/tmp/example",
    gitTarget: "working-tree",
    gitRefOrRange: null,
    model: "gpt-5.2-codex",
    dashboardUrl: dashboard.getRunUrl(1),
    summary: "Running",
    metadata: {},
  });

  let statusCode = 200;
  let html = "";
  const req = { params: { id: String(run.id) } };
  const res = {
    status(code) {
      statusCode = code;
      return this;
    },
    type() {
      return this;
    },
    send(value) {
      html = value;
      return this;
    },
  };

  dashboard.renderRun(req, res);

  assert.equal(statusCode, 200);
  assert.match(html, /\/api\/runs\//);
  assert.match(html, /setInterval\(refresh, 2000\)/);
  assert.match(html, /data-run-progress/);
});

test("dashboard shows dependency inventory from metadata and artifact fallback", async () => {
  const config = createConfig("devguard-dashboard-dependency-list-test-");
  const store = new DevGuardStore(config);
  const dashboard = new DashboardServer(config, store);

  const metadataRun = store.createRun({
    kind: "scan_dependencies",
    status: "completed",
    repoPath: "/tmp/example",
    gitTarget: "latest-commit",
    gitRefOrRange: null,
    model: "gpt-5.2",
    dashboardUrl: dashboard.getRunUrl(1),
    summary: "Dependency scan completed",
    metadata: {
      dependencyPackages: [
        {
          packageName: "express",
          version: "5.1.0",
          direct: true,
          devDependency: false,
          registry: {},
          riskFlags: [],
        },
      ],
    },
  });

  let html = "";
  dashboard.renderRun(
    { params: { id: String(metadataRun.id) } },
    {
      status() {
        return this;
      },
      type() {
        return this;
      },
      send(value) {
        html = value;
        return this;
      },
    },
  );

  assert.match(html, /Dependencies Checked/);
  assert.match(html, /express/);
  assert.match(html, /5\.1\.0/);

  const artifactRun = store.createRun({
    kind: "scan_dependencies",
    status: "completed",
    repoPath: "/tmp/example",
    gitTarget: "latest-commit",
    gitRefOrRange: null,
    model: "gpt-5.2",
    dashboardUrl: dashboard.getRunUrl(2),
    summary: "Dependency scan completed",
    metadata: {},
  });
  const artifactDir = path.join(config.artifactsDir, String(artifactRun.id));
  fs.mkdirSync(artifactDir, { recursive: true });
  fs.writeFileSync(path.join(artifactDir, "dependency-report.json"), JSON.stringify({
    dependencyCount: 1,
    vulnerabilityCount: 0,
    findings: [],
    report: {
      packageSignals: [
        {
          packageName: "typescript",
          version: "5.9.2",
          direct: true,
          devDependency: true,
          registry: {},
          riskFlags: ["install-script"],
        },
      ],
    },
  }), "utf8");

  let payload = null;
  dashboard.sendRun(
    { params: { id: String(artifactRun.id) } },
    {
      status() {
        return this;
      },
      json(value) {
        payload = value;
        return this;
      },
    },
  );

  assert.equal(payload.metadata.dependencyPackages[0].packageName, "typescript");
});
