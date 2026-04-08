const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { runCodeScan } = require("../../dist/devguard/scanners.js");

test("runCodeScan can focus findings on changed files", async () => {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-scan-test-"));
  const srcDir = path.join(repoDir, "src");
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(repoDir, "eslint.config.js"), "export default [];\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "changed.ts"), "console.log('debug')\n", "utf8");
  fs.writeFileSync(path.join(srcDir, "unchanged.ts"), "console.log('debug')\n", "utf8");

  const findings = await runCodeScan(repoDir, ["src/changed.ts"]);

  assert.ok(findings.length >= 1);
  assert.ok(findings.every((finding) => finding.filePath === "src/changed.ts"));
});
