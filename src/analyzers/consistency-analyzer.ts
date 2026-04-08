import * as fs from 'fs';
import * as path from 'path';
import { CodeIssueResult } from './eslint-analyzer';

interface ConsistencyRule {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  pattern: RegExp;
  fileExtensions: string[];
}

export class ConsistencyAnalyzer {

  private rules: ConsistencyRule[] = [
    {
      rule: 'console-log',
      severity: 'warning',
      message: 'console.log statement found — remove before production',
      pattern: /console\.log\s*\(/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
    {
      rule: 'console-debug',
      severity: 'info',
      message: 'console.debug statement found',
      pattern: /console\.debug\s*\(/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
    {
      rule: 'todo-comment',
      severity: 'info',
      message: 'TODO comment found — track or resolve',
      pattern: /\/\/\s*(TODO|FIXME|HACK|XXX|BUG)\b/i,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php', '.py'],
    },
    {
      rule: 'empty-catch',
      severity: 'warning',
      message: 'Empty catch block — errors should be handled or logged',
      pattern: /catch\s*\([^)]*\)\s*\{\s*\}/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
    {
      rule: 'hardcoded-url',
      severity: 'warning',
      message: 'Hardcoded URL found — consider using environment variables',
      pattern: /['\"`](https?:\/\/(?!localhost)[^\s'\"`]+)['\"`]/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php'],
    },
    {
      rule: 'hardcoded-ip',
      severity: 'warning',
      message: 'Hardcoded IP address found — use config or environment variables',
      pattern: /['\"`]\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}['\"`]/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php'],
    },
    {
      rule: 'any-type',
      severity: 'warning',
      message: 'Explicit `any` type — consider using a specific type',
      pattern: /:\s*any\b/,
      fileExtensions: ['.ts', '.tsx'],
    },
    {
      rule: 'magic-number',
      severity: 'info',
      message: 'Magic number in logic — consider extracting to a named constant',
      pattern: /(?:===?|!==?|>=?|<=?|>|<)\s*(?!0\b|1\b|2\b|-1\b|100\b|200\b|404\b|500\b)\d{2,}/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
  ];

  /**
   * Scan project source files for consistency issues
   */
  async analyze(projectPath: string): Promise<CodeIssueResult[]> {
    const issues: CodeIssueResult[] = [];

    try {
      // Collect all eligible source files under the project path
      const sourceFiles = this.collectSourceFiles(projectPath);

      for (const filePath of sourceFiles) {
        // Use a relative path in issue reports so they are portable
        const relativePath = path.relative(projectPath, filePath).replace(/\\/g, '/');
        const ext = path.extname(filePath);

        let content: string;
        try {
          content = fs.readFileSync(filePath, 'utf-8');
        } catch {
          // Skip files that can't be read (permissions, binary, etc.)
          continue;
        }

        const lines = content.split('\n');

        // Check file-level issue: excessive line count
        if (lines.length > 500) {
          issues.push({
            tier: 2,
            category: 'consistency',
            rule: 'file-too-long',
            severity: 'info',
            message: `File has ${lines.length} lines — consider splitting into smaller modules`,
            filePath: relativePath,
            line: null,
            column: null,
            source: 'custom',
            snippet: null,
          });
        }

        // Test every line against each rule, skipping rules not matching the file extension
        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineNumber = i + 1;

          for (const rule of this.rules) {
            if (!rule.fileExtensions.includes(ext)) continue;
            if (rule.pattern.test(line)) {
              issues.push({
                tier: 2,
                category: 'consistency',
                rule: rule.rule,
                severity: rule.severity,
                message: rule.message,
                filePath: relativePath,
                line: lineNumber,
                column: null,
                source: 'custom',
                snippet: this.getSnippet(lines, lineNumber),
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Consistency analyzer error:', error);
      issues.push({
        tier: 2,
        category: 'consistency',
        rule: 'analyzer-error',
        severity: 'warning',
        message: `Consistency analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        filePath: '',
        line: null,
        column: null,
        source: 'custom',
        snippet: null,
      });
    }

    return issues;
  }

  /**
   * Recursively collect source files, skipping ignored directories
   */
  private collectSourceFiles(dirPath: string): string[] {
    const files: string[] = [];
    const ignored = new Set(['node_modules', 'dist', 'build', '.next', '.git', 'vendor', 'coverage', '.angular']);

    const walk = (dir: string) => {
      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true });
      } catch {
        // Skip directories that can't be read (permissions, etc.)
        return;
      }

      for (const entry of entries) {
        // Skip build artifacts, dependencies, and version control directories
        if (ignored.has(entry.name)) continue;
        const fullPath = path.join(dir, entry.name);

        if (entry.isDirectory()) {
          walk(fullPath);
        } else if (entry.isFile()) {
          // Only include files with recognised source extensions
          const ext = path.extname(entry.name);
          if (['.ts', '.js', '.tsx', '.jsx', '.php', '.py'].includes(ext)) {
            files.push(fullPath);
          }
        }
      }
    };

    walk(dirPath);
    return files;
  }

  private getSnippet(lines: string[], lineNumber: number): string | null {
    const start = Math.max(0, lineNumber - 2);
    const end = Math.min(lines.length, lineNumber + 1);
    return lines.slice(start, end).join('\n');
  }
}
