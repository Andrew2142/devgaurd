import { EslintAnalyzer } from "../analyzers/eslint-analyzer";
import { ConsistencyAnalyzer } from "../analyzers/consistency-analyzer";
import { SecurityAnalyzer } from "../analyzers/security-analyzer";
import { LintFinding } from "./types";

/** Runs all static analyzers and returns normalized lint findings. */
export async function runLintScan(projectPath: string, changedFiles?: string[]): Promise<LintFinding[]> {
  const analyzerRuns = [
    new EslintAnalyzer().analyze(projectPath),
    new ConsistencyAnalyzer().analyze(projectPath),
    new SecurityAnalyzer().analyze(projectPath),
  ];

  const allResults = (await Promise.all(analyzerRuns)).flat();
  const normalizedChangedFiles = new Set((changedFiles || []).map((item) => item.replace(/\\/g, "/")));

  return allResults
    .filter((item) => normalizedChangedFiles.size === 0 || normalizedChangedFiles.has(item.filePath))
    .map((item) => ({
      tier: item.tier,
      category: item.category,
      rule: item.rule,
      severity: item.severity,
      message: item.message,
      filePath: item.filePath,
      line: item.line,
      column: item.column,
      source: item.source,
      snippet: item.snippet,
    }));
}

/** Backward-compatible alias for older clients that still call scan_code. */
export const runCodeScan = runLintScan;
