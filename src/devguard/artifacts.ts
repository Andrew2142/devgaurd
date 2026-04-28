import fs from "node:fs";
import path from "node:path";
import { DevGuardConfig } from "./config";
import { GeneratedArtifact } from "./types";

/** Persists run artifacts under DevGuard's local artifact directory. */
export class ArtifactManager {
  /** Creates an artifact manager scoped to the configured artifact root. */
  constructor(private config: DevGuardConfig) {}

  /** Ensures the artifact directory for a run exists and returns its path. */
  ensureRunDir(runId: number): string {
    const dir = path.join(this.config.artifactsDir, String(runId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

  /** Saves a JSON artifact and returns the metadata stored with the run. */
  saveJson(runId: number, filename: string, value: unknown): GeneratedArtifact {
    const dir = this.ensureRunDir(runId);
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
    return {
      type: "json",
      label: filename,
      filename,
    };
  }

  /** Saves a text artifact and returns the metadata stored with the run. */
  saveText(runId: number, filename: string, value: string): GeneratedArtifact {
    const dir = this.ensureRunDir(runId);
    const filePath = path.join(dir, filename);
    fs.writeFileSync(filePath, value, "utf8");
    return {
      type: "text",
      label: filename,
      filename,
    };
  }

  /** Resolves the absolute path for an artifact file. */
  getFilePath(runId: number, filename: string): string {
    return path.join(this.config.artifactsDir, String(runId), filename);
  }
}
