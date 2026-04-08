import fs from "fs";
import net from "net";
import { DevGuardConfig, ensureDevGuardDirs } from "./config";
import { DoctorCheck } from "./types";
import { CodexRunnerService } from "../services/codex-runner-service";

export async function runDoctor(config: DevGuardConfig): Promise<{ ok: boolean; checks: DoctorCheck[] }> {
  ensureDevGuardDirs(config);
  const runner = new CodexRunnerService();
  const checks: DoctorCheck[] = [];

  checks.push({
    name: "node",
    ok: process.versions.node.split(".").map(Number)[0] >= 24,
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
  checks.push({
    name: "dashboard_port",
    ok: await isPortAvailable(config.dashboardHost, config.dashboardPort),
    message: `${config.dashboardHost}:${config.dashboardPort}`,
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

async function runCommandCheck(command: string, args: string[], label: string): Promise<DoctorCheck> {
  try {
    const result = await new Promise<{ ok: boolean; output: string }>((resolve) => {
      const child = require("child_process").spawn(command, args, { stdio: "pipe" });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (chunk: Buffer) => {
        stdout += chunk.toString();
      });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.on("close", (code: number) => {
        resolve({
          ok: code === 0,
          output: (stdout || stderr).trim(),
        });
      });
      child.on("error", (error: Error) => {
        resolve({ ok: false, output: error.message });
      });
    });

    return {
      name: label,
      ok: result.ok,
      message: result.output,
    };
  } catch (error) {
    return {
      name: label,
      ok: false,
      message: error instanceof Error ? error.message : "Unknown error",
    };
  }
}

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
