import path from "node:path";
import type { GeneratedFilePayload } from "./codex-runner-service";

/** Validates the JSON payload returned by the Codex planning pass. */
export function validatePlanPayload(payload: unknown): string[] {
  const errors: string[] = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return ["Plan payload must be a JSON object"];
  }
  const plan = payload as Record<string, unknown>;

  if (typeof plan.summary !== "string" || plan.summary.trim() === "") {
    errors.push("summary must be a non-empty string");
  }

  if (!Array.isArray(plan.proposed_test_files) || plan.proposed_test_files.some((item: unknown) => typeof item !== "string")) {
    errors.push("proposed_test_files must be an array of strings");
  }

  if (typeof plan.recommended_command !== "string" || plan.recommended_command.trim() === "") {
    errors.push("recommended_command must be a non-empty string");
  }

  if (!Array.isArray(plan.risks) || plan.risks.some((item: unknown) => typeof item !== "string")) {
    errors.push("risks must be an array of strings");
  }

  if (typeof plan.plan_text !== "string" || plan.plan_text.trim() === "") {
    errors.push("plan_text must be a non-empty string");
  }

  if (plan.framework_guess != null && typeof plan.framework_guess !== "string") {
    errors.push("framework_guess must be a string when provided");
  }

  return errors;
}

/** Validates and normalizes the JSON payload returned by the test generation pass. */
export function validateGeneratedFilesPayload(payload: unknown): { errors: string[]; files: GeneratedFilePayload[] } {
  const errors: string[] = [];

  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    return { errors: ["Generated files payload must be a JSON object"], files: [] };
  }
  const record = payload as Record<string, unknown>;

  if (!Array.isArray(record.files) || record.files.length === 0) {
    return { errors: ["files must be a non-empty array"], files: [] };
  }

  const normalizedFiles: GeneratedFilePayload[] = [];

  for (const file of record.files) {
    if (!file || typeof file !== "object" || Array.isArray(file)) {
      errors.push("Each file entry must be an object");
      continue;
    }
    const generatedFile = file as Record<string, unknown>;

    if (typeof generatedFile.path !== "string" || generatedFile.path.trim() === "") {
      errors.push("Each file path must be a non-empty string");
      continue;
    }

    if (typeof generatedFile.content !== "string" || generatedFile.content.trim() === "") {
      errors.push(`Generated file ${generatedFile.path} has empty content`);
      continue;
    }

    normalizedFiles.push({
      path: generatedFile.path.trim().replace(/\\/g, "/"),
      content: generatedFile.content,
    });
  }

  return { errors, files: normalizedFiles };
}

/** Filters generated files to recognized test-only paths inside the project root. */
export function validateGeneratedFileTargets(projectRoot: string, ecosystem: string, files: GeneratedFilePayload[]) {
  const allowedPatterns = getAllowedPatterns(ecosystem);
  const accepted: Array<{ path: string; absolutePath: string; content: string }> = [];
  const rejected: Array<{ path: string; reason: string }> = [];
  const resolvedProjectRoot = path.resolve(projectRoot);

  for (const file of files) {
    const relativePath = file.path.replace(/^\.?\//, "");
    const resolved = path.resolve(resolvedProjectRoot, relativePath);
    const isInsideRoot = resolved === resolvedProjectRoot || resolved.startsWith(`${resolvedProjectRoot}${path.sep}`);
    const matchesAllowedPattern = allowedPatterns.some((pattern) => pattern.test(relativePath));

    if (path.isAbsolute(file.path) || !isInsideRoot || relativePath === "") {
      rejected.push({ path: file.path, reason: "Path escapes the repository root or is absolute" });
      continue;
    }

    if (!matchesAllowedPattern) {
      rejected.push({ path: file.path, reason: "Path is not a recognized test-only location" });
      continue;
    }

    accepted.push({
      path: relativePath,
      absolutePath: resolved,
      content: file.content,
    });
  }

  return { accepted, rejected };
}

/** Returns test-file path patterns for each supported project ecosystem. */
function getAllowedPatterns(ecosystem: string): RegExp[] {
  switch (ecosystem) {
    case "node":
      return [/(\btests?\b|__tests__)\/.+/i, /.+\.(test|spec)\.[^.]+$/i];
    case "php":
      return [/(^|\/)tests\/.+/i, /.+Test\.php$/i];
    case "python":
      return [/(^|\/)tests\/.+\.py$/i, /(^|\/)test_[^/]+\.py$/i, /.+_test\.py$/i];
    case "java":
      return [/^src\/test\/.+/i];
    case "go":
      return [/.+_test\.go$/i];
    case "rust":
      return [/^tests\/.+/i];
    default:
      return [
        /(\btests?\b|__tests__)\/.+/i,
        /.+\.(test|spec)\.[^.]+$/i,
        /.+Test\.php$/i,
        /.+_test\.go$/i,
        /^src\/test\/.+/i,
      ];
  }
}
