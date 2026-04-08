const fs = require("fs");
const os = require("os");
const path = require("path");

function createConfig(prefix = "devguard-test-") {
  const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  return {
    baseDir,
    artifactsDir: path.join(baseDir, "artifacts"),
    dbPath: path.join(baseDir, "devguard.db"),
    dashboardHost: "127.0.0.1",
    dashboardPort: 4680,
    serverName: "devguard-mcp",
    serverVersion: "1.0.0",
    defaultModel: "gpt-5.2-codex",
  };
}

function createNodeRepo(files = {}) {
  const repoDir = fs.mkdtempSync(path.join(os.tmpdir(), "devguard-repo-"));
  fs.mkdirSync(path.join(repoDir, "src"), { recursive: true });
  fs.writeFileSync(
    path.join(repoDir, "package.json"),
    JSON.stringify({
      name: "fixture-app",
      version: "1.0.0",
      scripts: { test: "node --test" },
    }, null, 2),
    "utf8",
  );
  fs.writeFileSync(path.join(repoDir, "package-lock.json"), JSON.stringify({
    name: "fixture-app",
    lockfileVersion: 3,
    packages: {
      "": {
        name: "fixture-app",
        version: "1.0.0",
      },
    },
  }, null, 2), "utf8");
  for (const [relativePath, content] of Object.entries(files)) {
    const fullPath = path.join(repoDir, relativePath);
    fs.mkdirSync(path.dirname(fullPath), { recursive: true });
    fs.writeFileSync(fullPath, content, "utf8");
  }
  return repoDir;
}

module.exports = {
  createConfig,
  createNodeRepo,
};
