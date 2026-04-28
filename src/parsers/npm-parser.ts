import fs from "node:fs";
import path from "node:path";

/** One npm dependency discovered from package.json or package-lock.json. */
export interface ParsedDependency {
  name: string;
  version: string;
  isDirect: boolean;
  isDevDependency: boolean;
  ecosystem: "npm";
}

/** Result returned by the npm dependency parser. */
export interface NpmParseResult {
  dependencies: ParsedDependency[];
  totalCount: number;
  directCount: number;
  devCount: number;
  error?: string;
}

/** Parses npm manifests into normalized direct and transitive dependency records. */
export class NpmParser {
  /**
   * Parses package.json and package-lock.json to extract dependency records.
   */
  async parse(projectPath: string): Promise<NpmParseResult> {
    try {
      const packageJsonPath = path.join(projectPath, "package.json");

      if (!fs.existsSync(packageJsonPath)) {
        return {
          dependencies: [],
          totalCount: 0,
          directCount: 0,
          devCount: 0,
          error: "package.json not found",
        };
      }

      const packageJson = readJsonObject(packageJsonPath);
      const packageLockPath = path.join(projectPath, "package-lock.json");
      const packageLock = fs.existsSync(packageLockPath) ? readJsonObject(packageLockPath) : null;
      const lockedVersions = packageLock ? collectLockedVersions(packageLock) : new Map<string, string>();
      const dependencies: ParsedDependency[] = [];

      dependencies.push(
        ...this.parseDirectDependencies(packageJson.dependencies, false, lockedVersions),
        ...this.parseDirectDependencies(packageJson.devDependencies, true, lockedVersions),
      );

      if (packageLock) {
        const transitiveDeps = this.parsePackageLock(packageLock, dependencies);
        dependencies.push(...transitiveDeps);
      }

      const directCount = dependencies.filter((dependency) => dependency.isDirect).length;
      const devCount = dependencies.filter((dependency) => dependency.isDevDependency).length;

      return {
        dependencies,
        totalCount: dependencies.length,
        directCount,
        devCount,
      };
    } catch (error) {
      return {
        dependencies: [],
        totalCount: 0,
        directCount: 0,
        devCount: 0,
        error: error instanceof Error ? error.message : "Parse error",
      };
    }
  }

  /** Converts direct dependency maps from package.json into normalized records. */
  private parseDirectDependencies(
    value: unknown,
    isDevDependency: boolean,
    lockedVersions: Map<string, string>,
  ): ParsedDependency[] {
    return Object.entries(asRecord(value))
      .filter((entry): entry is [string, string] => typeof entry[1] === "string")
      .map(([name, version]) => ({
        name,
        version: this.cleanVersion(lockedVersions.get(name) || version),
        isDirect: true,
        isDevDependency,
        ecosystem: "npm",
      }));
  }

  /** Extracts transitive dependencies from modern and legacy npm lockfile shapes. */
  private parsePackageLock(packageLock: Record<string, unknown>, directDeps: ParsedDependency[]): ParsedDependency[] {
    const transitiveDeps: ParsedDependency[] = [];
    const directDepNames = new Set(directDeps.map((dependency) => dependency.name));

    try {
      const packages = asRecord(packageLock.packages);
      if (Object.keys(packages).length > 0) {
        for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
          if (!pkgPath) continue;

          const name = packageNameFromLockPath(pkgPath);

          if (directDepNames.has(name)) continue;

          const packageInfo = asRecord(pkgInfo);
          const version = packageInfo.version;
          if (name && typeof version === "string") {
            transitiveDeps.push({
              name,
              version: this.cleanVersion(version),
              isDirect: false,
              isDevDependency: packageInfo.dev === true,
              ecosystem: "npm",
            });
          }
        }
      } else if (packageLock.dependencies) {
        this.extractV1Dependencies(packageLock.dependencies, directDepNames, transitiveDeps);
      }
    } catch {
      return transitiveDeps;
    }

    return transitiveDeps;
  }

  /** Recursively extracts dependencies from npm v1 lockfile data. */
  private extractV1Dependencies(
    deps: unknown,
    directDepNames: Set<string>,
    result: ParsedDependency[],
  ): void {
    for (const [name, value] of Object.entries(asRecord(deps))) {
      if (directDepNames.has(name)) continue;

      const info = asRecord(value);
      const version = info.version;
      if (typeof version === "string") {
        result.push({
          name,
          version: this.cleanVersion(version),
          isDirect: false,
          isDevDependency: info.dev === true,
          ecosystem: "npm",
        });
      }

      if (info.dependencies) {
        this.extractV1Dependencies(info.dependencies, directDepNames, result);
      }
    }
  }

  /** Removes common package range prefixes so OSV receives a concrete version. */
  private cleanVersion(version: string): string {
    return version.replace(/^[\^~>=<]+/, "").trim();
  }

  /** Detects whether the path looks like an npm project root. */
  static isNpmProject(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, "package.json"));
  }
}

/** Reads JSON from disk and returns an object shape or an empty object. */
function readJsonObject(filePath: string): Record<string, unknown> {
  return asRecord(JSON.parse(fs.readFileSync(filePath, "utf8")));
}

/** Narrows unknown JSON values to plain object records. */
function asRecord(value: unknown): Record<string, unknown> {
  if (value && typeof value === "object" && !Array.isArray(value)) {
    return value as Record<string, unknown>;
  }

  return {};
}

/** Collects resolved versions from npm lockfile package entries and legacy dependency entries. */
function collectLockedVersions(packageLock: Record<string, unknown>): Map<string, string> {
  const versions = new Map<string, string>();
  const packages = asRecord(packageLock.packages);

  if (Object.keys(packages).length > 0) {
    for (const [pkgPath, pkgInfo] of Object.entries(packages)) {
      if (!pkgPath) continue;

      const packageInfo = asRecord(pkgInfo);
      const version = packageInfo.version;
      if (typeof version === "string") {
        versions.set(packageNameFromLockPath(pkgPath), version);
      }
    }
    return versions;
  }

  collectLegacyLockedVersions(packageLock.dependencies, versions);
  return versions;
}

/** Recursively collects resolved versions from npm v1 lockfile dependencies. */
function collectLegacyLockedVersions(deps: unknown, versions: Map<string, string>): void {
  for (const [name, value] of Object.entries(asRecord(deps))) {
    const info = asRecord(value);
    const version = info.version;
    if (typeof version === "string" && !versions.has(name)) {
      versions.set(name, version);
    }

    if (info.dependencies) {
      collectLegacyLockedVersions(info.dependencies, versions);
    }
  }
}

/** Extracts a package name from an npm lockfile path. */
function packageNameFromLockPath(lockPath: string): string {
  const normalized = lockPath.replace(/^node_modules\//, "");
  const segments = normalized.split("/node_modules/");
  return segments[segments.length - 1] || "";
}
