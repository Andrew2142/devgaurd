const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { DevGuardStore } = require("../../dist/devguard/storage.js");
const { runDependencyScan, runLintScan } = require("../../dist/devguard/scanners.js");
const { createConfig, createNodeRepo } = require("./helpers.js");

test("runLintScan can focus findings on changed files", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-scan-test-"));
  const srcDir = path.join(repoDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "eslint.config.js"), "export default [];\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "changed.ts"), "const value: any = 1;\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "unchanged.ts"), "const value: any = 1;\n", "utf8");

  const findings = await runLintScan(repoDir, ["src/changed.ts"]);

  assert.ok(findings.length >= 1);
  assert.ok(findings.every((finding) => finding.filePath === "src/changed.ts"));
});

test("runDependencyScan includes a dependency report", async () => {
  const store = new DevGuardStore(createConfig("devguard-dependency-report-test-"));
  const repoDir = createNodeRepo();

  const result = await runDependencyScan(repoDir, store);

  assert.equal(result.dependencyCount, 0);
  assert.equal(result.vulnerabilityCount, 0);
  assert.ok(result.report);
  assert.equal(result.report.signatureAudit.status, "skipped");
  assert.match(result.report.summary, /No known vulnerabilities/);
});
