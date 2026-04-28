import {
  DependencyFinding,
  DependencyPackageSignal,
  DependencyReport,
  DependencyScanResult,
  DependencySignatureAudit,
} from "./types";

/** Builds the structured dependency report attached to dependency scan results. */
export function buildDependencyReport(input: {
  dependencyCount: number;
  vulnerabilityCount: number;
  signatureAudit: DependencySignatureAudit;
  packageSignals: DependencyPackageSignal[];
}): DependencyReport {
  const packageRiskCount = input.packageSignals.reduce((total, signal) => total + signal.riskFlags.length, 0);
  const signatureRiskCount = input.signatureAudit.status === "failed" ? 1 : 0;
  const riskCount = packageRiskCount + signatureRiskCount;

  return {
    checkedAt: new Date().toISOString(),
    summary: buildDependencySummary(input.dependencyCount, input.vulnerabilityCount, riskCount),
    sources: [
      "OSV API vulnerability matching: https://api.osv.dev/v1/querybatch",
      "npm registry version metadata: https://registry.npmjs.org",
      "npm registry signatures/provenance: npm audit signatures",
    ],
    signatureAudit: input.signatureAudit,
    packageSignals: input.packageSignals,
    riskCount,
  };
}

/** Renders a human-readable markdown dependency report for artifact output. */
export function renderDependencyReportMarkdown(result: DependencyScanResult): string {
  const report = result.report;
  const lines: string[] = [
    "# Dependency Report",
    "",
    report?.summary || `Checked ${result.dependencyCount} dependencies.`,
    "",
    `- Dependencies checked: ${result.dependencyCount}`,
    `- Known vulnerability findings: ${result.vulnerabilityCount}`,
    `- Package risk signals: ${report?.riskCount ?? 0}`,
  ];

  if (report) {
    lines.push(`- Checked at: ${report.checkedAt}`);
    lines.push(`- Signature audit: ${report.signatureAudit.status} - ${report.signatureAudit.message}`);
    lines.push("");
    lines.push("## Sources");
    for (const source of report.sources) {
      lines.push(`- ${source}`);
    }
  }

  lines.push("");
  lines.push("## Known Vulnerabilities");
  appendFindings(lines, result.findings);

  lines.push("");
  lines.push("## Package Risk Signals");
  appendRiskSignals(lines, report?.packageSignals || []);

  lines.push("");
  lines.push("## Signature Audit");
  appendSignatureAudit(lines, report?.signatureAudit);

  return `${lines.join("\n")}\n`;
}

/** Summarizes dependency vulnerability and package-risk counts in one sentence. */
function buildDependencySummary(dependencyCount: number, vulnerabilityCount: number, riskCount: number): string {
  if (vulnerabilityCount > 0) {
    return `Found ${vulnerabilityCount} known vulnerability findings and ${riskCount} package risk signals across ${dependencyCount} dependencies.`;
  }

  if (riskCount > 0) {
    return `No known vulnerabilities found; ${riskCount} package risk signals need review across ${dependencyCount} dependencies.`;
  }

  return `No known vulnerabilities or package risk signals found across ${dependencyCount} dependencies.`;
}

/** Appends OSV vulnerability findings to the markdown report. */
function appendFindings(lines: string[], findings: DependencyFinding[]): void {
  if (findings.length === 0) {
    lines.push("No known vulnerabilities were reported by OSV for the locked dependency versions.");
    return;
  }

  for (const finding of findings) {
    lines.push(`- ${finding.packageName}@${finding.version} [${finding.severity}] ${finding.advisoryId}: ${finding.summary}`);
  }
}

/** Appends npm registry package risk signals to the markdown report. */
function appendRiskSignals(lines: string[], packageSignals: DependencyPackageSignal[]): void {
  const riskyPackages = packageSignals.filter((signal) => signal.riskFlags.length > 0);
  if (riskyPackages.length === 0) {
    lines.push("No npm registry metadata risk signals were found.");
    return;
  }

  for (const signal of riskyPackages) {
    lines.push(`- ${signal.packageName}@${signal.version}: ${signal.riskFlags.join(", ")}`);
  }
}

/** Appends npm signature/provenance audit output to the markdown report. */
function appendSignatureAudit(lines: string[], signatureAudit?: DependencySignatureAudit): void {
  if (!signatureAudit) {
    lines.push("Signature audit was not run.");
    return;
  }

  lines.push(`Status: ${signatureAudit.status}`);
  if (signatureAudit.stdout.trim()) {
    lines.push("");
    lines.push("```text");
    lines.push(signatureAudit.stdout.trim());
    lines.push("```");
  }
  if (signatureAudit.stderr.trim()) {
    lines.push("");
    lines.push("```text");
    lines.push(signatureAudit.stderr.trim());
    lines.push("```");
  }
}
