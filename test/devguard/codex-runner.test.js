const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CodexRunnerService } = require("../../dist/services/codex-runner-service.js");

test("checkCodexLoginAsync uses the configured CODEX_HOME", async () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-codex-runner-test-"));
  const codexHome = path.join(fixtureRoot, "codex-home");
  const fakeCodex = path.join(fixtureRoot, "fake-codex.sh");

  fs.mkdirSync(codexHome, { recursive: true });
  fs.writeFileSync(
    fakeCodex,
    [
      "#!/usr/bin/env bash",
      "if [ \"$1\" = \"login\" ] && [ \"$2\" = \"status\" ]; then",
      "  printf 'Logged in using ChatGPT (%s)\\n' \"$CODEX_HOME\"",
      "  exit 0",
      "fi",
      "printf 'unexpected args: %s\\n' \"$*\" >&2",
      "exit 1",
    ].join("\n"),
    "utf8",
  );
  fs.chmodSync(fakeCodex, 0o755);

  const runner = new CodexRunnerService({ codexHome });
  const result = await runner.checkCodexLoginAsync(fakeCodex);

  assert.equal(result.ok, true);
  assert.match(result.output, new RegExp(codexHome.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("createEphemeralWorkspace links installed node dependencies without copying build output", () => {
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-workspace-source-"));
  fs.mkdirSync(path.join(projectRoot, "node_modules", ".bin"), { recursive: true });
  fs.mkdirSync(path.join(projectRoot, "dist"), { recursive: true });
  fs.writeFileSync(path.join(projectRoot, "package.json"), "{\"name\":\"fixture\"}\n", "utf8");
  fs.writeFileSync(path.join(projectRoot, "node_modules", ".bin", "tool"), "", "utf8");
  fs.writeFileSync(path.join(projectRoot, "dist", "index.js"), "", "utf8");

  const runner = new CodexRunnerService();
  const workspacePath = runner.createEphemeralWorkspace(projectRoot);

  try {
    const linkedNodeModules = fs.lstatSync(path.join(workspacePath, "node_modules"));
    assert.equal(linkedNodeModules.isSymbolicLink(), true);
    assert.equal(fs.existsSync(path.join(workspacePath, "node_modules", ".bin", "tool")), true);
    assert.equal(fs.existsSync(path.join(workspacePath, "dist", "index.js")), false);
  } finally {
    runner.cleanupWorkspace(workspacePath);
  }
});
