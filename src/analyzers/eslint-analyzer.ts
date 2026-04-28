import { ESLint } from 'eslint';
import * as path from 'node:path';
import * as fs from 'node:fs';

/** Normalized static-analysis finding shared by all built-in analyzers. */
export interface CodeIssueResult {
  tier: number;
  category: string;
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  filePath: string;
  line: number | null;
  column: number | null;
  source: string;
  snippet: string | null;
}

/** Runs ESLint with a conservative default rule set for Node and TypeScript projects. */
export class EslintAnalyzer {

  /**
   * Runs ESLint against the source tree and converts messages into DevGuard findings.
   */
  async analyze(projectPath: string): Promise<CodeIssueResult[]> {
    const issues: CodeIssueResult[] = [];

    try {
      // Determine source directories to lint
      const srcDir = path.join(projectPath, 'src');
      const targetPath = fs.existsSync(srcDir) ? srcDir : projectPath;

      // Create ESLint instance with override config
      const eslint = new ESLint({
        cwd: projectPath,
        overrideConfigFile: true,
        overrideConfig: {
          rules: {
            'no-unused-vars': 'warn',
            'no-undef': 'error',
            'no-console': 'warn',
            'no-debugger': 'error',
            'no-empty': 'warn',
            'no-extra-semi': 'warn',
            'no-unreachable': 'error',
            'no-constant-condition': 'warn',
            'no-dupe-keys': 'error',
            'no-duplicate-case': 'error',
            'no-sparse-arrays': 'warn',
            'eqeqeq': 'warn',
            'no-eval': 'error',
            'no-implied-eval': 'error',
            'no-var': 'warn',
            'prefer-const': 'warn',
          }
        },
        errorOnUnmatchedPattern: false,
      });

      // Lint the target directory
      const results = await eslint.lintFiles([
        path.join(targetPath, '**/*.{js,ts,jsx,tsx}'),
      ]);

      for (const result of results) {
        // Get relative path from project root
        const relativePath = path.relative(projectPath, result.filePath).replace(/\\/g, '/');

        // Skip node_modules, dist, build, .next, etc.
        if (relativePath.startsWith('node_modules/') ||
            relativePath.startsWith('dist/') ||
            relativePath.startsWith('build/') ||
            relativePath.startsWith('.next/')) {
          continue;
        }

        for (const msg of result.messages) {
          issues.push({
            tier: 1,
            category: 'lint',
            rule: msg.ruleId || 'parse-error',
            severity: msg.severity === 2 ? 'error' : 'warning',
            message: msg.message,
            filePath: relativePath,
            line: msg.line || null,
            column: msg.column || null,
            source: 'eslint',
            snippet: result.source
              ? this.extractSnippet(result.source, msg.line)
              : null,
          });
        }
      }
    } catch (error) {
      issues.push({
        tier: 1,
        category: 'lint',
        rule: 'analyzer-error',
        severity: 'warning',
        message: `ESLint analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        filePath: '',
        line: null,
        column: null,
        source: 'eslint',
        snippet: null,
      });
    }

    return issues;
  }

  /**
   * Extracts a three-line snippet around the reported issue line.
   */
  private extractSnippet(source: string, line: number | undefined): string | null {
    if (!line || !source) return null;
    const lines = source.split('\n');
    const start = Math.max(0, line - 2);
    const end = Math.min(lines.length, line + 1);
    return lines.slice(start, end).join('\n');
  }
}
