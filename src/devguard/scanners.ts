import fs from "fs";
import path from "path";
import { CodeIssueResult, EslintAnalyzer } from "../analyzers/eslint-analyzer";
import { ConsistencyAnalyzer } from "../analyzers/consistency-analyzer";
import { SecurityAnalyzer } from "../analyzers/security-analyzer";
import { NpmParser } from "../parsers/npm-parser";
import { DevGuardStore } from "./storage";
import { CodeFinding, DependencyFinding, DependencyScanResult } from "./types";

type OsvBatchResponse = {
  results?: Array<{
    vulns?: Array<{
      id?: string;
      summary?: string;
      details?: string;
      aliases?: string[];
      severity?: Array<{ type?: string; score?: string }>;
      database_specific?: { severity?: string };
      references?: Array<{ url?: string }>;
    }>;
  }>;
};

type OsvVulnerability = NonNullable<NonNullable<OsvBatchResponse["results"]>[number]["vulns"]>[number];
type OsvResult = { vulns?: OsvVulnerability[] };

export async function runCodeScan(projectPath: string, changedFiles?: string[]): Promise<CodeFinding[]> {
  const analyzers = [
    new EslintAnalyzer().analyze(projectPath),
    new ConsistencyAnalyzer().analyze(projectPath),
    new SecurityAnalyzer().analyze(projectPath),
  ];

  const allResults = (await Promise.all(analyzers)).flat();
  const normalizedChangedFiles = new Set((changedFiles || []).map((item) => item.replace(/\\/g, "/")));

  return allResults
    .filter((item) => {
      if (normalizedChangedFiles.size === 0) {
        return true;
      }
      return normalizedChangedFiles.has(item.filePath);
    })
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

export async function runDependencyScan(projectPath: string, store: DevGuardStore): Promise<DependencyScanResult> {
  const packageJsonPath = path.join(projectPath, "package.json");
  const packageLockPath = path.join(projectPath, "package-lock.json");

  if (!fs.existsSync(packageJsonPath)) {
    throw new Error("Dependency scanning currently supports Node projects with package.json only");
  }

  if (!fs.existsSync(packageLockPath)) {
    throw new Error("Dependency scan requires package-lock.json in v1");
  }

  const parser = new NpmParser();
  const parsed = await parser.parse(projectPath);
  if (parsed.error) {
    throw new Error(parsed.error);
  }

  const uniqueDependencies = Array.from(
    new Map(
      parsed.dependencies.map((dependency) => [
        `${dependency.name}@${dependency.version}:${dependency.isDevDependency ? "dev" : "prod"}`,
        dependency,
      ]),
    ).values(),
  );

  const queries = uniqueDependencies.map((dependency) => ({
    package: { name: dependency.name, ecosystem: "npm" },
    version: dependency.version,
  }));

  const batchResults = await queryOsvBatch(queries, store);
  const findings: DependencyFinding[] = [];

  batchResults.forEach((result, index) => {
    const dependency = uniqueDependencies[index];
    for (const vuln of result.vulns || []) {
      findings.push({
        packageName: dependency.name,
        version: dependency.version,
        direct: dependency.isDirect,
        devDependency: dependency.isDevDependency,
        advisoryId: vuln.id || "unknown",
        summary: vuln.summary || vuln.details || "No summary provided",
        severity: normalizeSeverity(vuln),
        aliases: Array.isArray(vuln.aliases) ? vuln.aliases.filter(Boolean) : [],
        references: Array.isArray(vuln.references)
          ? vuln.references.map((reference: { url?: string }) => reference.url || "").filter(Boolean)
          : [],
      });
    }
  });

  return {
    dependencyCount: uniqueDependencies.length,
    vulnerabilityCount: findings.length,
    findings,
  };
}

async function queryOsvBatch(
  queries: Array<{ package: { name: string; ecosystem: string }; version: string }>,
  store: DevGuardStore,
): Promise<OsvResult[]> {
  const results: OsvResult[] = [];
  const missingQueries: typeof queries = [];
  const missingIndices: number[] = [];

  queries.forEach((query, index) => {
    const cacheKey = `${query.package.ecosystem}:${query.package.name}:${query.version}`;
    const cached = store.getCachedAdvisory(cacheKey) as OsvResult | null;
    if (cached) {
      results[index] = cached;
      return;
    }
    missingQueries.push(query);
    missingIndices.push(index);
  });

  if (missingQueries.length > 0) {
    const response = await fetchWithRetry("https://api.osv.dev/v1/querybatch", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ queries: missingQueries }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`OSV query failed (${response.status}): ${body || "Unknown error"}`);
    }

    const json = (await response.json()) as OsvBatchResponse;
    const responseResults = json.results || [];
    responseResults.forEach((item, batchIndex) => {
      const query = missingQueries[batchIndex];
      const resultIndex = missingIndices[batchIndex];
      const normalized = { vulns: item.vulns || [] };
      results[resultIndex] = normalized;
      store.putCachedAdvisory(`${query.package.ecosystem}:${query.package.name}:${query.version}`, normalized);
    });
  }

  return results.map((result) => result || { vulns: [] });
}

async function fetchWithRetry(input: string, init: RequestInit, attempts = 2): Promise<Response> {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 10_000);
    try {
      return await fetch(input, {
        ...init,
        signal: controller.signal,
      });
    } catch (error) {
      lastError = error;
      if (attempt < attempts) {
        await new Promise((resolve) => setTimeout(resolve, 300 * attempt));
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  throw lastError instanceof Error ? lastError : new Error("Request failed");
}

function normalizeSeverity(vuln: {
  severity?: Array<{ score?: string }>;
  database_specific?: { severity?: string };
}): string {
  if (vuln.database_specific?.severity) {
    return vuln.database_specific.severity;
  }

  const score = vuln.severity?.[0]?.score;
  if (!score) {
    return "unknown";
  }

  const numeric = parseFloat(score);
  if (Number.isNaN(numeric)) {
    return score;
  }

  if (numeric >= 9) return "critical";
  if (numeric >= 7) return "high";
  if (numeric >= 4) return "medium";
  return "low";
}
