import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Runtime configuration for the local DevGuard MCP server and dashboard. */
export type DevGuardConfig = {
  baseDir: string;
  artifactsDir: string;
  dbPath: string;
  codexHome: string;
  dashboardHost: string;
  dashboardPort: number;
  serverName: string;
  serverVersion: string;
  defaultModel: string;
};

/** Builds DevGuard configuration from environment variables and local defaults. */
export function getDevGuardConfig(): DevGuardConfig {
  const baseDir = resolveBaseDir();

  return {
    baseDir,
    artifactsDir: path.join(baseDir, "artifacts"),
    dbPath: path.join(baseDir, "devgaurd.db"),
    codexHome: resolveCodexHome(baseDir),
    dashboardHost: process.env.DEVGUARD_DASHBOARD_HOST || "127.0.0.1",
    dashboardPort: parseInt(process.env.DEVGUARD_DASHBOARD_PORT || "4680", 10),
    serverName: "devgaurd-mcp",
    serverVersion: "1.0.0",
    defaultModel: process.env.DEVGUARD_DEFAULT_MODEL || "gpt-5.2",
  };
}

/** Creates required local directories and mirrors Codex auth into the managed home. */
export function ensureDevGuardDirs(config: DevGuardConfig): void {
  fs.mkdirSync(config.baseDir, { recursive: true });
  fs.mkdirSync(config.artifactsDir, { recursive: true });
  fs.mkdirSync(config.codexHome, { recursive: true });
  syncCodexHome(config);
}

/** Chooses a writable base directory for DevGuard state. */
function resolveBaseDir(): string {
  const explicit = process.env.DEVGUARD_HOME;
  if (explicit) {
    return path.resolve(explicit);
  }

  const preferred = path.join(os.homedir(), ".devgaurd");
  if (canCreateDir(preferred)) {
    return preferred;
  }

  return path.join(process.cwd(), ".devgaurd");
}

/** Checks whether DevGuard can create and write to a directory. */
function canCreateDir(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = path.join(dirPath, `.write-test-${process.pid}-${Date.now()}`);
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Resolves the CODEX_HOME directory used by DevGuard-managed Codex runs. */
function resolveCodexHome(baseDir: string): string {
  const explicit = process.env.DEVGUARD_CODEX_HOME || process.env.CODEX_HOME;
  if (explicit) {
    return path.resolve(explicit);
  }

  return path.join(baseDir, "codex-home");
}

/** Resolves the source Codex home used when copying auth into the managed home. */
function resolveCodexSourceHome(): string {
  const explicit = process.env.DEVGUARD_CODEX_SOURCE_HOME || process.env.CODEX_HOME;
  if (explicit) {
    return path.resolve(explicit);
  }

  return path.join(os.homedir(), ".codex");
}

/** Copies reusable Codex auth into the configured Codex home on a best-effort basis. */
function syncCodexHome(config: DevGuardConfig): void {
  const targetDir = config.codexHome;
  const sourceDir = resolveCodexSourceHome();
  const sourceAuthPath = path.join(sourceDir, "auth.json");
  const targetAuthPath = path.join(targetDir, "auth.json");

  try {
    if (path.resolve(sourceAuthPath) !== path.resolve(targetAuthPath) && fs.existsSync(sourceAuthPath)) {
      fs.copyFileSync(sourceAuthPath, targetAuthPath);
      fs.chmodSync(targetAuthPath, 0o600);
    }
  } catch {
    // Best effort: if source auth is unreadable, Codex can still use any
    // credentials already present in the managed CODEX_HOME.
  }

  if (isManagedCodexHome(config)) {
    removeInheritedCodexConfig(targetDir);
  }
}

/** Returns whether DevGuard owns the Codex home and may clean inherited config from it. */
function isManagedCodexHome(config: DevGuardConfig): boolean {
  return path.resolve(config.codexHome) === path.resolve(path.join(config.baseDir, "codex-home"));
}

/** Removes copied Codex config that could start nested MCP servers inside test generation. */
function removeInheritedCodexConfig(targetDir: string): void {
  try {
    fs.rmSync(path.join(targetDir, "config.toml"), { force: true });
  } catch {
    // Best effort: stale config should not block server startup.
  }
}
