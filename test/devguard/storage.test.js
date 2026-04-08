const test = require("node:test");
const assert = require("node:assert/strict");

const { DevGuardStore } = require("../../dist/devguard/storage.js");
const { createConfig } = require("./helpers.js");

test("DevGuardStore creates and updates runs", () => {
  const store = new DevGuardStore(createConfig());
  const run = store.createRun({
    kind: "scan_code",
    status: "queued",
    repoPath: "/tmp/project",
    gitTarget: "latest-commit",
    gitRefOrRange: null,
    model: "gpt-5.2-codex",
    dashboardUrl: "http://127.0.0.1:4680/runs/1",
    summary: "Queued scan",
  });

  store.appendProgress(run.id, "queued", "Queued", "active");
  const updated = store.updateRun(run.id, {
    status: "completed",
    summary: "Done",
    completedAt: new Date().toISOString(),
  });

  assert.equal(updated.status, "completed");
  assert.equal(updated.summary, "Done");
  assert.equal(updated.progressLog.length, 1);
});
