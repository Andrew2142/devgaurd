import fs from "fs";
import os from "os";
import path from "path";

export type DevGuardConfig = {
  baseDir: string;
  artifactsDir: string;
  dbPath: string;
  dashboardHost: string;
  dashboardPort: number;
  serverName: string;
  serverVersion: string;
  defaultModel: string;
};

export function getDevGuardConfig(): DevGuardConfig {
  const baseDir = resolveBaseDir();

  return {
    baseDir,
    artifactsDir: path.join(baseDir, "artifacts"),
    dbPath: path.join(baseDir, "devgaurd.db"),
    dashboardHost: process.env.DEVGUARD_DASHBOARD_HOST || "127.0.0.1",
    dashboardPort: parseInt(process.env.DEVGUARD_DASHBOARD_PORT || "4680", 10),
    serverName: "devgaurd-mcp",
    serverVersion: "1.0.0",
    defaultModel: process.env.DEVGUARD_DEFAULT_MODEL || "gpt-5.2-codex",
  };
}

export function ensureDevGuardDirs(config: DevGuardConfig): void {
  fs.mkdirSync(config.baseDir, { recursive: true });
  fs.mkdirSync(config.artifactsDir, { recursive: true });
}

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

function canCreateDir(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    return true;
  } catch {
    return false;
  }
}
