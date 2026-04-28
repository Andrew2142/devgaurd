const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");

const { ensureDevGuardDirs } = require("../../dist/devguard/config.js");

test("ensureDevGuardDirs seeds a managed codex home from a readable source", () => {
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-config-test-"));
  const sourceHome = path.join(fixtureRoot, "source-codex");
  const targetHome = path.join(fixtureRoot, "codex-home");
  const originalSource = process.env.DEVGUARD_CODEX_SOURCE_HOME;

  fs.mkdirSync(sourceHome, { recursive: true });
  fs.mkdirSync(targetHome, { recursive: true });
  fs.writeFileSync(path.join(sourceHome, "auth.json"), "{\"auth_mode\":\"chatgpt\"}\n", "utf8");
  fs.writeFileSync(path.join(sourceHome, "config.toml"), "[mcp_servers.devgaurd]\ncommand = \"node\"\n", "utf8");
  fs.writeFileSync(path.join(targetHome, "config.toml"), "model = \"stale\"\n", "utf8");

  process.env.DEVGUARD_CODEX_SOURCE_HOME = sourceHome;

  try {
    ensureDevGuardDirs({
      baseDir: fixtureRoot,
      artifactsDir: path.join(fixtureRoot, "artifacts"),
      dbPath: path.join(fixtureRoot, "devgaurd.db"),
      codexHome: targetHome,
      dashboardHost: "127.0.0.1",
      dashboardPort: 4680,
      serverName: "devgaurd-mcp",
      serverVersion: "1.0.0",
      defaultModel: "gpt-5.2",
    });

    assert.equal(fs.readFileSync(path.join(targetHome, "auth.json"), "utf8"), "{\"auth_mode\":\"chatgpt\"}\n");
    assert.equal(fs.existsSync(path.join(targetHome, "config.toml")), false);
  } finally {
    if (originalSource === undefined) {
      delete process.env.DEVGUARD_CODEX_SOURCE_HOME;
    } else {
      process.env.DEVGUARD_CODEX_SOURCE_HOME = originalSource;
    }
  }
});
