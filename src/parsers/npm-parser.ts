import * as fs from 'fs';
import * as path from 'path';

/**
 * npm Parser
 * Parses package.json and package-lock.json to extract dependencies
 */

export interface ParsedDependency {
  name: string;
  version: string;
  isDirect: boolean;
  isDevDependency: boolean;
  ecosystem: 'npm';
}

export interface NpmParseResult {
  dependencies: ParsedDependency[];
  totalCount: number;
  directCount: number;
  devCount: number;
  error?: string;
}

export class NpmParser {
  /**
   * Parse npm project to extract all dependencies
   */
  async parse(projectPath: string): Promise<NpmParseResult> {
    try {
      const packageJsonPath = path.join(projectPath, 'package.json');

      // Check if package.json exists
      if (!fs.existsSync(packageJsonPath)) {
        return {
          dependencies: [],
          totalCount: 0,
          directCount: 0,
          devCount: 0,
          error: 'package.json not found'
        };
      }

      // Read and parse package.json
      const packageJsonContent = fs.readFileSync(packageJsonPath, 'utf-8');
      const packageJson = JSON.parse(packageJsonContent);

      const dependencies: ParsedDependency[] = [];

      // Parse production dependencies
      if (packageJson.dependencies) {
        for (const [name, version] of Object.entries(packageJson.dependencies)) {
          dependencies.push({
            name,
            version: this.cleanVersion(version as string),
            isDirect: true,
            isDevDependency: false,
            ecosystem: 'npm'
          });
        }
      }

      // Parse dev dependencies
      if (packageJson.devDependencies) {
        for (const [name, version] of Object.entries(packageJson.devDependencies)) {
          dependencies.push({
            name,
            version: this.cleanVersion(version as string),
            isDirect: true,
            isDevDependency: true,
            ecosystem: 'npm'
          });
        }
      }

      // Try to parse package-lock.json for transitive dependencies
      const packageLockPath = path.join(projectPath, 'package-lock.json');
      if (fs.existsSync(packageLockPath)) {
        const lockContent = fs.readFileSync(packageLockPath, 'utf-8');
        const packageLock = JSON.parse(lockContent);

        // Add transitive dependencies from lockfile
        const transitiveDeps = this.parsePackageLock(packageLock, dependencies);
        dependencies.push(...transitiveDeps);
      }

      // Calculate counts
      const directCount = dependencies.filter(d => d.isDirect).length;
      const devCount = dependencies.filter(d => d.isDevDependency).length;

      return {
        dependencies,
        totalCount: dependencies.length,
        directCount,
        devCount
      };

    } catch (error) {
      console.error('npm parser error:', error);
      return {
        dependencies: [],
        totalCount: 0,
        directCount: 0,
        devCount: 0,
        error: error instanceof Error ? error.message : 'Parse error'
      };
    }
  }

  /**
   * Parse package-lock.json to extract transitive dependencies
   */
  private parsePackageLock(packageLock: any, directDeps: ParsedDependency[]): ParsedDependency[] {
    const transitiveDeps: ParsedDependency[] = [];
    const directDepNames = new Set(directDeps.map(d => d.name));

    try {
      // package-lock.json v2/v3 format
      if (packageLock.packages) {
        for (const [pkgPath, pkgInfo] of Object.entries(packageLock.packages)) {
          if (!pkgPath || pkgPath === '') continue; // Skip root

          const name = pkgPath.replace(/^node_modules\//, '').split('/node_modules/').pop() || '';

          // Skip if already in direct dependencies
          if (directDepNames.has(name)) continue;

          const version = (pkgInfo as any).version;
          if (name && version) {
            transitiveDeps.push({
              name,
              version: this.cleanVersion(version),
              isDirect: false,
              isDevDependency: (pkgInfo as any).dev === true,
              ecosystem: 'npm'
            });
          }
        }
      }
      // package-lock.json v1 format
      else if (packageLock.dependencies) {
        this.extractV1Dependencies(packageLock.dependencies, directDepNames, transitiveDeps);
      }
    } catch (error) {
      console.error('Error parsing package-lock.json:', error);
    }

    return transitiveDeps;
  }

  /**
   * Extract dependencies from package-lock.json v1 format (recursive)
   */
  private extractV1Dependencies(
    deps: any,
    directDepNames: Set<string>,
    result: ParsedDependency[]
  ): void {
    for (const [name, info] of Object.entries(deps)) {
      if (directDepNames.has(name)) continue;

      const version = (info as any).version;
      if (version) {
        result.push({
          name,
          version: this.cleanVersion(version),
          isDirect: false,
          isDevDependency: (info as any).dev === true,
          ecosystem: 'npm'
        });
      }

      // Recursively process nested dependencies
      if ((info as any).dependencies) {
        this.extractV1Dependencies((info as any).dependencies, directDepNames, result);
      }
    }
  }

  /**
   * Clean version string (remove ^, ~, >=, etc.)
   */
  private cleanVersion(version: string): string {
    // Remove version range symbols
    return version.replace(/^[\^~>=<]+/, '').trim();
  }

  /**
   * Check if a directory contains an npm project
   */
  static isNpmProject(projectPath: string): boolean {
    return fs.existsSync(path.join(projectPath, 'package.json'));
  }
}
