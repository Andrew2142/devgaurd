const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

test("codex runner schema paths are anchored to the module location", () => {
  const source = fs.readFileSync(
    path.join(__dirname, "../../src/services/codex-runner-service.ts"),
    "utf8",
  );

  assert.match(source, /const REPO_ROOT = path\.resolve\(__dirname, "\.\.", "\.\."\);/);
  assert.doesNotMatch(source, /const PLAN_SCHEMA_PATH = path\.join\(process\.cwd\(\),/);
  assert.doesNotMatch(source, /const FILES_SCHEMA_PATH = path\.join\(process\.cwd\(\),/);
});
