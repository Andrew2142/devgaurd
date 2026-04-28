const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { DevGuardStore } = require("../../dist/devguard/storage.js");
const { DevGuardService } = require("../../dist/devguard/service.js");
const { createConfig, createNodeRepo } = require("./helpers.js");

function createDashboardStub({ available = true, error = null } = {}) {
  return {
    ensureStarted: async () => {},
    isAvailable: () => available,
    getStartupError: () => error,
    getRunUrl: (runId) => available ? `http://127.0.0.1:4680/runs/${runId}` : `dashboard-unavailable://local-ui/runs/${runId}`,
  };
}

test("startLintCode completes in the background and persists findings", async () => {
  const config = createConfig("devguard-service-test-");
  const store = new DevGuardStore(config);
  const service = new DevGuardService(config, store, createDashboardStub());
  const repoDir = createNodeRepo({
    "src/index.ts": "const value: any = 1;\n",
  });

  const summary = await service.startLintCode({ repo_path: repoDir });
  const completed = await service.waitForRun(summary.run_id);

  assert.equal(completed.status, "completed");
  assert.equal(completed.kind, "lint_code");
  assert.ok(completed.lintFindings.length >= 1);
  assert.equal(completed.error, null);
});

test("dashboard startup failure degrades gracefully", async () => {
  const config = createConfig("devguard-dashboard-fallback-test-");
  const store = new DevGuardStore(config);
  const service = new DevGuardService(
    config,
    store,
    createDashboardStub({ available: false, error: "port busy" }),
  );
  const repoDir = createNodeRepo({
    "src/index.ts": "const value: any = 1;\n",
  });

  const summary = await service.startLintCode({ repo_path: repoDir });
  const run = store.getRun(summary.run_id);

  assert.ok(run);
  assert.match(run.dashboardUrl, /^dashboard-unavailable:/);
  assert.equal(run.metadata.dashboardAvailable, false);
  assert.equal(run.metadata.dashboardError, "port busy");
});

test("commitGeneratedTests only writes accepted test files", async () => {
  const config = createConfig("devguard-apply-test-");
  const store = new DevGuardStore(config);
  const service = new DevGuardService(config, store, createDashboardStub());
  const repoDir = createNodeRepo();

  const safeRun = store.createRun({
    kind: "test_changes",
    status: "completed",
    repoPath: repoDir,
    gitTarget: "latest-commit",
    gitRefOrRange: null,
    model: "gpt-5.2-codex",
    dashboardUrl: "http://127.0.0.1:4680/runs/1",
    summary: "done",
  });

  store.updateRun(safeRun.id, {
    testsResult: {
      status: "passed",
      testCommand: "node --test",
      generatedFiles: [
        { path: "src/index.test.ts", content: "import test from 'node:test';\n" },
      ],
    },
  });

  const result = await service.commitGeneratedTests(safeRun.id);
  assert.equal(result.committed_files.length, 1);
  assert.equal(fs.existsSync(path.join(repoDir, "src/index.test.ts")), true);

  const unsafeRun = store.createRun({
    kind: "test_changes",
    status: "completed",
    repoPath: repoDir,
    gitTarget: "latest-commit",
    gitRefOrRange: null,
    model: "gpt-5.2-codex",
    dashboardUrl: "http://127.0.0.1:4680/runs/2",
    summary: "done",
  });

  store.updateRun(unsafeRun.id, {
    testsResult: {
      status: "passed",
      testCommand: "node --test",
      generatedFiles: [
        { path: "src/index.ts", content: "console.log('unsafe');\n" },
      ],
    },
  });

  await assert.rejects(() => service.commitGeneratedTests(unsafeRun.id), /Refusing to apply rejected file targets/);
});
