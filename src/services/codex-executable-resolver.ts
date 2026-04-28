import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCommandSync } from "../utils/process";

/** Resolves the best local Codex CLI binary for test generation workflows. */
export class CodexExecutableResolver {
  /** Finds a Codex executable and prefers bundled editor binaries over snap shims. */
  resolveCodexExecutable(bin = "codex"): string | null {
    if (bin && path.isAbsolute(bin) && fs.existsSync(bin)) {
      return bin;
    }

    const candidates = [
      this.findExecutable(bin),
      ...this.collectCodexCandidates(bin),
    ].filter((candidate): candidate is string => Boolean(candidate));

    let fallback: string | null = null;

    for (const candidate of candidates) {
      if (!fs.existsSync(candidate)) {
        continue;
      }

      if (!fallback) {
        fallback = candidate;
      }

      if (!this.isSnapShim(candidate)) {
        return candidate;
      }
    }

    return fallback;
  }

  /** Builds the ordered list of likely Codex binary locations for the current machine. */
  private collectCodexCandidates(bin: string): string[] {
    const candidates: string[] = [];

    if (bin && bin !== "codex") {
      candidates.push(this.expandHome(bin));
    }

    if (process.env.CODEX_BIN) {
      candidates.push(this.expandHome(process.env.CODEX_BIN));
    }

    const pathEntries = (process.env.PATH || "")
      .split(path.delimiter)
      .map((entry) => entry.trim())
      .filter(Boolean);

    for (const entry of pathEntries) {
      candidates.push(path.join(entry, "codex"));
    }

    const home = os.homedir();
    const commonRoots = [
      path.join(home, ".vscode", "extensions"),
      path.join(home, ".vscode-insiders", "extensions"),
      path.join(home, ".cursor", "extensions"),
    ];

    for (const root of commonRoots) {
      if (!fs.existsSync(root)) continue;

      let extensionDirs: string[] = [];
      try {
        extensionDirs = fs.readdirSync(root);
      } catch {
        continue;
      }

      for (const dir of extensionDirs) {
        if (!/openai\.chatgpt/i.test(dir)) continue;
        candidates.push(path.join(root, dir, "bin", "linux-x86_64", "codex"));
        candidates.push(path.join(root, dir, "bin", "darwin-aarch64", "codex"));
        candidates.push(path.join(root, dir, "bin", "darwin-x86_64", "codex"));
        candidates.push(path.join(root, dir, "bin", "win32-x86_64", "codex.exe"));
      }
    }

    return Array.from(new Set(candidates.map((candidate) => this.expandHome(candidate)).filter(Boolean)));
  }

  /** Expands a leading tilde so manually supplied paths resolve consistently. */
  private expandHome(filePath: string): string {
    if (filePath === "~") return os.homedir();
    if (filePath.startsWith("~/")) {
      return path.join(os.homedir(), filePath.slice(2));
    }
    return filePath;
  }

  /** Detects snap wrapper paths that can fail in nested agent environments. */
  private isSnapShim(filePath: string): boolean {
    const normalized = path.resolve(filePath);
    return normalized.startsWith("/snap/bin/") || normalized.includes(`${path.sep}snap${path.sep}bin${path.sep}`);
  }

  /** Uses the host PATH to resolve a binary name when possible. */
  private findExecutable(bin: string): string | null {
    const result = runCommandSync("which", [bin], { timeoutMs: 10000 });
    if (result.status !== 0) {
      return null;
    }
    return result.stdout.trim() || null;
  }
}
