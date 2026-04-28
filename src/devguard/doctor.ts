import fs from "node:fs";
import net from "node:net";
import { DevGuardConfig, ensureDevGuardDirs } from "./config";
import { DoctorCheck } from "./types";
import { CodexRunnerService } from "../services/codex-runner-service";
import { runCommandAsync } from "../utils/process";

const MIN_NODE_MAJOR = 24;
const DASHBOARD_PORT_ATTEMPTS = 20;

/** Runs local environment checks required for DevGuard MCP workflows. */
export async function runDoctor(config: DevGuardConfig): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  ensureDevGuardDirs(config);
  const runner = new CodexRunnerService({ codexHome: config.codexHome });
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: getNodeMajorVersion() >= MIN_NODE_MAJOR,
    message: `Node ${process.versions.node}`,
  });

  checks.push(await runCommandCheck("git", ["--version"], "git"));
  checks.push({
    name: "sqlite_path",
    ok: fs.existsSync(config.baseDir),
    message: config.dbPath,
  });
  checks.push({
    name: "artifacts_dir",
    ok: canWrite(config.artifactsDir),
    message: config.artifactsDir,
  });
  const dashboardPort = await findAvailableDashboardPort(config.dashboardHost, config.dashboardPort);
  checks.push({
    name: "dashboard_port",
    ok: dashboardPort !== null,
    message: formatDashboardPortMessage(config.dashboardHost, config.dashboardPort, dashboardPort),
  });

  const codexBin = runner.resolveCodexExecutable();
  checks.push({
    name: "codex_binary",
    ok: Boolean(codexBin),
    message: codexBin || "Codex CLI not found",
  });

  if (codexBin) {
    const login = await runner.checkCodexLoginAsync(codexBin);
    checks.push({
      name: "codex_login",
      ok: login.ok,
      message: login.output || "No login output",
    });
  } else {
    checks.push({
      name: "codex_login",
      ok: false,
      message: "Skipped because Codex CLI was not found",
    });
  }

  return {
    ok: checks.every((check) => check.ok),
    checks,
  };
}

/** Runs a command-line availability check and normalizes the result for doctor output. */
async function runCommandCheck(command: string, args: string[], label: string): Promise<DoctorCheck> {
  try {
    const result = await runCommandAsync(command, args, { timeoutMs: 30000 });
    return {
      name: label,
      ok: result.status === 0,
      message: (result.stdout || result.stderr || result.error?.message || "").trim(),
    };
  } catch (error) {
    return {
      name: label,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

/** Returns the major Node.js runtime version. */
function getNodeMajorVersion(): number {
  const major = Number(process.versions.node.split(".")[0]);
  return Number.isFinite(major) ? major : 0;
}

/** Checks whether a directory is writable by creating and deleting a probe file. */
function canWrite(dirPath: string): boolean {
  try {
    fs.mkdirSync(dirPath, { recursive: true });
    const probe = `${dirPath}/.write-test`;
    fs.writeFileSync(probe, "ok", "utf8");
    fs.unlinkSync(probe);
    return true;
  } catch {
    return false;
  }
}

/** Finds a dashboard port using the same fallback range as the dashboard server. */
async function findAvailableDashboardPort(host: string, startPort: number): Promise<number | null> {
  for (let port = startPort; port < startPort + DASHBOARD_PORT_ATTEMPTS; port += 1) {
    if (await isPortAvailable(host, port)) {
      return port;
    }
  }

  return null;
}

/** Formats the dashboard port check message for exact and fallback port matches. */
function formatDashboardPortMessage(host: string, preferredPort: number, availablePort: number | null): string {
  if (availablePort === null) {
    return `No dashboard port available from ${host}:${preferredPort} to ${host}:${preferredPort + DASHBOARD_PORT_ATTEMPTS - 1}`;
  }

  if (availablePort === preferredPort) {
    return `${host}:${preferredPort}`;
  }

  return `${host}:${preferredPort} busy; fallback ${host}:${availablePort} available`;
}

/** Checks whether one dashboard host and port can accept a new listener. */
async function isPortAvailable(host: string, port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.once("listening", () => {
      server.close(() => resolve(true));
    });
    server.listen(port, host);
  });
}
