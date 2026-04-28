import fs from "node:fs";
import path from "node:path";
import { NpmParser, ParsedDependency } from "../parsers/npm-parser";
import { runCommandAsync } from "../utils/process";
import { buildDependencyReport } from "./dependency-report";
import { DevGuardStore } from "./storage";
import {
  DependencyFinding,
  DependencyPackageSignal,
  DependencyScanResult,
  DependencySignatureAudit,
} from "./types";

/** Raw response shape returned by OSV's querybatch endpoint. */
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

/** One vulnerability entry returned in an OSV batch result. */
type OsvVulnerability = NonNullable<NonNullable<OsvBatchResponse["results"]>[number]["vulns"]>[number];
/** Cached OSV result for a single package version. */
type OsvResult = { vulns?: OsvVulnerability[] };
/** OSV query for one npm package version. */
type OsvQuery = { package: { name: string; ecosystem: string }; version: string };

const NPM_REGISTRY_BASE_URL = "https://registry.npmjs.org";
const OSV_QUERY_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const INSTALL_SCRIPT_NAMES = new Set(["preinstall", "install", "postinstall", "prepare"]);

/** Scans locked npm dependencies with OSV, npm registry metadata, and signature audit checks. */
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

  const uniqueDependencies = dedupeDependencies(parsed.dependencies);
  const queries = uniqueDependencies.map((dependency) => ({
    package: { name: dependency.name, ecosystem: "npm" },
    version: dependency.version,
  }));

  const batchResults = await queryOsvBatch(queries, store);
  const [signatureAudit, packageSignals] = await Promise.all([
    runNpmSignatureAudit(projectPath, uniqueDependencies.length),
    collectNpmPackageSignals(uniqueDependencies),
  ]);
  const findings = collectDependencyFindings(uniqueDependencies, batchResults);
  const report = buildDependencyReport({
    dependencyCount: uniqueDependencies.length,
    vulnerabilityCount: findings.length,
    signatureAudit,
    packageSignals,
  });

  return {
    dependencyCount: uniqueDependencies.length,
    vulnerabilityCount: findings.length,
    findings,
    report,
  };
}

/** Removes duplicate dependency records while preserving prod/dev identity. */
function dedupeDependencies(dependencies: ParsedDependency[]): ParsedDependency[] {
  return Array.from(
    new Map(
      dependencies.map((dependency) => [
        `${dependency.name}@${dependency.version}:${dependency.isDevDependency ? "dev" : "prod"}`,
        dependency,
      ]),
    ).values(),
  );
}

/** Converts OSV batch responses into DevGuard dependency findings. */
function collectDependencyFindings(
  dependencies: ParsedDependency[],
  batchResults: OsvResult[],
): DependencyFinding[] {
  const findings: DependencyFinding[] = [];

  batchResults.forEach((result, index) => {
    const dependency = dependencies[index];
    if (!dependency) {
      return;
    }

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

  return findings;
}

/** Queries OSV in batches and caches per-package advisory results locally. */
async function queryOsvBatch(queries: OsvQuery[], store: DevGuardStore): Promise<OsvResult[]> {
  const results: OsvResult[] = [];
  const missingQueries: OsvQuery[] = [];
  const missingIndices: number[] = [];

  queries.forEach((query, index) => {
    const cacheKey = buildAdvisoryCacheKey(query);
    const cached = store.getCachedAdvisory(cacheKey) as OsvResult | null;
    if (cached) {
      results[index] = cached;
      return;
    }
    missingQueries.push(query);
    missingIndices.push(index);
  });

  if (missingQueries.length > 0) {
    const response = await fetchWithRetry(OSV_QUERY_BATCH_URL, {
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
      if (!query || resultIndex === undefined) {
        return;
      }

      const normalized = { vulns: item.vulns || [] };
      results[resultIndex] = normalized;
      store.putCachedAdvisory(buildAdvisoryCacheKey(query), normalized);
    });
  }

  return queries.map((_query, index) => results[index] || { vulns: [] });
}

/** Collects npm registry risk signals with bounded concurrency. */
async function collectNpmPackageSignals(dependencies: ParsedDependency[]): Promise<DependencyPackageSignal[]> {
  const signals: DependencyPackageSignal[] = [];
  const concurrency = 8;
  let nextIndex = 0;

  const workers = Array.from({ length: Math.min(concurrency, dependencies.length) }, async () => {
    while (nextIndex < dependencies.length) {
      const index = nextIndex;
      nextIndex += 1;
      const dependency = dependencies[index];
      if (dependency) {
        signals[index] = await checkNpmPackageVersion(dependency);
      }
    }
  });

  await Promise.all(workers);
  return signals.filter((signal): signal is DependencyPackageSignal => Boolean(signal));
}

/** Checks one npm package version for registry metadata risk signals. */
async function checkNpmPackageVersion(dependency: ParsedDependency): Promise<DependencyPackageSignal> {
  const riskFlags: string[] = [];
  const baseSignal: DependencyPackageSignal = {
    packageName: dependency.name,
    version: dependency.version,
    direct: dependency.isDirect,
    devDependency: dependency.isDevDependency,
    registry: {
      checked: true,
      found: false,
      deprecated: false,
      hasInstallScript: false,
      hasRegistrySignature: false,
      integrity: null,
      tarball: null,
      error: null,
    },
    riskFlags,
  };

  try {
    const response = await fetchWithRetry(buildNpmVersionUrl(dependency), {
      method: "GET",
      headers: { "Accept": "application/json" },
    });

    if (response.status === 404) {
      riskFlags.push("registry-version-not-found");
      return baseSignal;
    }

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      baseSignal.registry.error = `npm registry query failed (${response.status}): ${body || "Unknown error"}`;
      riskFlags.push("registry-query-failed");
      return baseSignal;
    }

    applyRegistryMetadata(baseSignal, await response.json());
    return baseSignal;
  } catch (error) {
    baseSignal.registry.error = error instanceof Error ? error.message : String(error);
    riskFlags.push("registry-query-failed");
    return baseSignal;
  }
}

/** Runs npm's registry signature and provenance verification for the lockfile. */
async function runNpmSignatureAudit(projectPath: string, dependencyCount: number): Promise<DependencySignatureAudit> {
  const command = "npm audit signatures";
  if (dependencyCount === 0) {
    return {
      status: "skipped",
      command,
      exitCode: null,
      stdout: "",
      stderr: "",
      message: "No dependencies were found to audit.",
    };
  }

  const result = await runCommandAsync("npm", ["audit", "signatures"], {
    cwd: projectPath,
    timeoutMs: 60000,
  });
  const stdout = truncateOutput(result.stdout);
  const stderr = truncateOutput(result.stderr);

  if (result.error?.code === "ENOENT") {
    return {
      status: "unavailable",
      command,
      exitCode: null,
      stdout,
      stderr,
      message: "npm was not found on PATH.",
    };
  }

  if (result.error?.code === "ETIMEDOUT") {
    return {
      status: "unavailable",
      command,
      exitCode: result.status,
      stdout,
      stderr,
      message: "npm audit signatures timed out.",
    };
  }

  if (result.status === 0) {
    return {
      status: "passed",
      command,
      exitCode: result.status,
      stdout,
      stderr,
      message: "Registry signatures and provenance checks passed.",
    };
  }

  return {
    status: "failed",
    command,
    exitCode: result.status,
    stdout,
    stderr,
    message: "npm reported a registry signature or provenance problem.",
  };
}

/** Applies npm registry metadata to a package signal and records risk flags. */
function applyRegistryMetadata(signal: DependencyPackageSignal, payload: unknown): void {
  const metadata = asRecord(payload);
  const dist = asRecord(metadata.dist);
  const scripts = asRecord(metadata.scripts);
  const signatures = Array.isArray(dist.signatures) ? dist.signatures : [];
  const hasInstallScript = Object.entries(scripts).some(([name, value]) => (
    INSTALL_SCRIPT_NAMES.has(name) && typeof value === "string" && value.trim() !== ""
  ));
  const deprecated = typeof metadata.deprecated === "string" && metadata.deprecated.trim() !== "";
  const integrity = typeof dist.integrity === "string"
    ? dist.integrity
    : (typeof dist.shasum === "string" ? dist.shasum : null);

  signal.registry.found = true;
  signal.registry.deprecated = deprecated;
  signal.registry.hasInstallScript = hasInstallScript;
  signal.registry.hasRegistrySignature = signatures.length > 0;
  signal.registry.integrity = integrity;
  signal.registry.tarball = typeof dist.tarball === "string" ? dist.tarball : null;

  if (deprecated) {
    signal.riskFlags.push("deprecated");
  }
  if (hasInstallScript) {
    signal.riskFlags.push("install-script");
  }
  if (!integrity) {
    signal.riskFlags.push("missing-integrity");
  }
}

/** Fetches a URL with a short timeout and retry for transient network failures. */
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

/** Builds the stable cache key for an OSV package-version query. */
function buildAdvisoryCacheKey(query: OsvQuery): string {
  return `${query.package.ecosystem}:${query.package.name}:${query.version}`;
}

/** Builds the npm registry URL for one exact package version. */
function buildNpmVersionUrl(dependency: ParsedDependency): string {
  return `${NPM_REGISTRY_BASE_URL}/${encodeURIComponent(dependency.name)}/${encodeURIComponent(dependency.version)}`;
}

/** Narrows unknown JSON payloads to plain object records. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

/** Truncates long command output before storing it in dependency reports. */
function truncateOutput(value: string, maxLength = 12000): string {
  if (value.length <= maxLength) {
    return value;
  }

  return `${value.slice(0, maxLength)}\n[truncated]`;
}

/** Normalizes OSV severity metadata into a compact severity string. */
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
