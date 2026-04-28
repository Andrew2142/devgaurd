const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { CodexRunnerService } = require("../../dist/services/codex-runner-service.js");

test("resolveCodexExecutable prefers a non-snap binary when available", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-codex-resolution-"));
  const originalHome = process.env.HOME;
  const originalPath = process.env.PATH;

  const snapBinDir = path.join(fixtureRoot, "snap", "bin");
  const homeDir = path.join(fixtureRoot, "home");
  const extensionBinDir = path.join(
    homeDir,
    ".vscode",
    "extensions",
    "openai.chatgpt-test",
    "bin",
    "linux-x86_64",
  );

  fs.mkdirSync(snapBinDir, { recursive: true });
  fs.mkdirSync(extensionBinDir, { recursive: true });
  fs.writeFileSync(path.join(snapBinDir, "codex"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.writeFileSync(path.join(extensionBinDir, "codex"), "#!/usr/bin/env bash\nexit 0\n", "utf8");
  fs.chmodSync(path.join(snapBinDir, "codex"), 0o755);
  fs.chmodSync(path.join(extensionBinDir, "codex"), 0o755);

  process.env.HOME = homeDir;
  process.env.PATH = snapBinDir;

  try {
    const runner = new CodexRunnerService();
    const resolved = runner.resolveCodexExecutable();

    assert.equal(resolved, path.join(extensionBinDir, "codex"));
  } finally {
    if (originalHome === undefined) {
      delete process.env.HOME;
    } else {
      process.env.HOME = originalHome;
    }

    if (originalPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = originalPath;
    }
  }
});
