import * as fs from 'fs';
import * as path from 'path';
import { CodeIssueResult } from './eslint-analyzer';

interface SecurityRule {
  rule: string;
  severity: 'error' | 'warning' | 'info';
  message: string;
  pattern: RegExp;
  fileExtensions: string[];
}

export class SecurityAnalyzer {

  private rules: SecurityRule[] = [
    // Secrets / credentials
    {
      rule: 'hardcoded-secret',
      severity: 'error',
      message: 'Possible hardcoded secret or API key detected',
      pattern: /(?:api[_-]?key|secret|password|passwd|token|auth[_-]?token|access[_-]?key|private[_-]?key)\s*[:=]\s*['\"`][^'\"`]{8,}['\"`]/i,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php', '.py', '.env', '.json'],
    },
    {
      rule: 'aws-key',
      severity: 'error',
      message: 'Possible AWS access key detected',
      pattern: /AKIA[0-9A-Z]{16}/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php', '.py', '.env', '.json', '.yaml', '.yml'],
    },

    // Dangerous functions
    {
      rule: 'eval-usage',
      severity: 'error',
      message: '`eval()` usage detected — high risk for code injection',
      pattern: /\beval\s*\(/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php'],
    },
    {
      rule: 'exec-usage',
      severity: 'error',
      message: 'Shell command execution detected — risk of command injection',
      pattern: /(?:child_process|exec|execSync|spawn|spawnSync)\s*\(/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
    {
      rule: 'php-exec',
      severity: 'error',
      message: 'PHP shell execution function detected — risk of command injection',
      pattern: /\b(?:exec|shell_exec|system|passthru|popen|proc_open)\s*\(/,
      fileExtensions: ['.php'],
    },

    // XSS patterns
    {
      rule: 'innerhtml-usage',
      severity: 'warning',
      message: '`innerHTML` assignment detected — risk of XSS if user input is not sanitized',
      pattern: /\.innerHTML\s*=/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },
    {
      rule: 'dangerously-set-html',
      severity: 'warning',
      message: '`dangerouslySetInnerHTML` used — ensure content is properly sanitized',
      pattern: /dangerouslySetInnerHTML/,
      fileExtensions: ['.tsx', '.jsx'],
    },

    // SQL injection
    {
      rule: 'sql-concat',
      severity: 'error',
      message: 'String concatenation in SQL query — risk of SQL injection. Use parameterized queries.',
      pattern: /(?:query|execute|raw)\s*\(\s*(?:['\"`](?:SELECT|INSERT|UPDATE|DELETE|DROP|ALTER|CREATE)\b[^'\"`]*['\"`]\s*\+|`[^`]*\$\{)/i,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php'],
    },

    // Insecure randomness
    {
      rule: 'insecure-random',
      severity: 'warning',
      message: '`Math.random()` is not cryptographically secure — use `crypto.randomBytes()` for security-sensitive operations',
      pattern: /Math\.random\s*\(\)/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx'],
    },

    // Insecure HTTP
    {
      rule: 'insecure-http',
      severity: 'warning',
      message: 'Insecure HTTP URL found — use HTTPS instead',
      pattern: /['\"`]http:\/\/(?!localhost|127\.0\.0\.1|0\.0\.0\.0)[^'\"`]+['\"`]/,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php', '.py'],
    },

    // Disabled security
    {
      rule: 'disabled-ssl-verify',
      severity: 'error',
      message: 'SSL verification disabled — this allows man-in-the-middle attacks',
      pattern: /rejectUnauthorized\s*:\s*false|NODE_TLS_REJECT_UNAUTHORIZED\s*=\s*['\"`]0['\"`]|verify_ssl\s*=\s*False/i,
      fileExtensions: ['.ts', '.js', '.tsx', '.jsx', '.php', '.py'],
    },
  ];

  /**
   * Scan project for security anti-patterns
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

        for (let i = 0; i < lines.length; i++) {
          const line = lines[i];
          const lineNumber = i + 1;

          // Skip commented lines to reduce false positives
          const trimmed = line.trim();
          if (trimmed.startsWith('//') || trimmed.startsWith('#') || trimmed.startsWith('*')) continue;

          // Test the line against each security rule, filtered by file extension
          for (const rule of this.rules) {
            if (!rule.fileExtensions.includes(ext)) continue;
            if (rule.pattern.test(line)) {
              issues.push({
                tier: 3,
                category: 'security',
                rule: rule.rule,
                severity: rule.severity,
                message: rule.message,
                filePath: relativePath,
                line: lineNumber,
                column: null,
                source: 'sast',
                snippet: this.getSnippet(lines, lineNumber),
              });
            }
          }
        }
      }
    } catch (error) {
      console.error('Security analyzer error:', error);
      issues.push({
        tier: 3,
        category: 'security',
        rule: 'analyzer-error',
        severity: 'warning',
        message: `Security analysis failed: ${error instanceof Error ? error.message : 'Unknown error'}`,
        filePath: '',
        line: null,
        column: null,
        source: 'sast',
        snippet: null,
      });
    }

    return issues;
  }

  /**
   * Recursively collect source files
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
          // Include config/env files in addition to source files — secrets can appear anywhere
          const ext = path.extname(entry.name);
          if (['.ts', '.js', '.tsx', '.jsx', '.php', '.py', '.env', '.json', '.yaml', '.yml'].includes(ext)) {
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
