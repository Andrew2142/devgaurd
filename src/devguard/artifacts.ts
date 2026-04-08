import fs from "fs";
import path from "path";
import { DevGuardConfig } from "./config";
import { GeneratedArtifact } from "./types";

export class ArtifactManager {
  constructor(private config: DevGuardConfig) {}

  ensureRunDir(runId: number): string {
    const dir = path.join(this.config.artifactsDir, String(runId));
    fs.mkdirSync(dir, { recursive: true });
    return dir;
  }

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

  getFilePath(runId: number, filename: string): string {
    return path.join(this.config.artifactsDir, String(runId), filename);
  }
}
