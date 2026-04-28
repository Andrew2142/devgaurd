import type { GitContext, ProjectProfile } from "./codex-runner-service";

const MAX_GENERATION_DIFF_CHARS = 8000;
const MAX_GENERATION_CHANGED_FILES = 40;
const MAX_GENERATED_TEST_FILES = 3;

/** Builds the prompt used for the read-only Codex planning pass. */
export function buildPlanPrompt(context: {
  projectName: string;
  projectProfile: ProjectProfile;
  git: GitContext;
  brief: string;
  notes: string;
  testCommand: string | null;
}): string {
  const brief = context.brief || "(none)";
  const notes = context.notes || "(none)";
  const testCommand = context.testCommand || "(not detected)";

  return `You are helping with a backend spike for a local Codex-driven code tester.

Analyze the git change set and propose test coverage only. Do not modify files. Do not include markdown fences.
The final plan_text should focus on what behaviours, edge cases, regressions, and risks need coverage.
Do not make the plan_text read like implementation instructions, file-edit steps, or framework mechanics.
Prefer the smallest useful test surface; propose at most ${MAX_GENERATED_TEST_FILES} test files.

Project:
- Name: ${context.projectName}
- Ecosystem: ${context.projectProfile.ecosystem}
- Language: ${context.projectProfile.language}
- Package manager: ${context.projectProfile.packageManager}
- Detected test command: ${testCommand}

Git target:
- Mode: ${context.git.mode}
- Resolved range: ${context.git.resolvedRange}
- Changed files count: ${context.git.changedFiles.length}
- Changed test files count: ${context.git.changedTestFiles.length}

Saved testing brief:
${brief}

Specific testing focus from the user:
${notes}

Git summary:
${context.git.summary}

Changed files:
${context.git.changedFiles.join("\n")}

Diff excerpt:
${context.git.diff}

Return JSON only with:
- summary: string
- proposed_test_files: string[]
- recommended_command: string
- risks: string[]
- plan_text: string
- framework_guess: string
`;
}

/** Builds the prompt used for the Codex pass that emits test-file JSON. */
export function buildGenerationPrompt(context: {
  projectName: string;
  projectProfile: ProjectProfile;
  git: GitContext;
  testCommand: string | null;
  plan: {
    summary: string;
    plan_text: string;
    proposed_test_files: string[];
  };
}): string {
  const changedFiles = context.git.changedFiles.slice(0, MAX_GENERATION_CHANGED_FILES);
  const diffExcerpt = trimGenerationDiff(context.git.diff);

  return `You are generating tests for a local Codex spike.

Hard rules:
- Return JSON only. No markdown fences.
- Do not run shell commands, list files, or inspect the repository.
- Do not modify or propose production source files.
- Only generate new or updated test files.
- Keep file paths relative to the repository root.
- Prefer the established test style and naming conventions already present in the repo.
- Generate at most ${MAX_GENERATED_TEST_FILES} focused test files.
- Use only the confirmed plan, changed-file list, and diff excerpt in this prompt.

Project:
- Name: ${context.projectName}
- Ecosystem: ${context.projectProfile.ecosystem}
- Language: ${context.projectProfile.language}
- Package manager: ${context.projectProfile.packageManager}
- Test command: ${context.testCommand || "(not detected)"}

Confirmed plan:
${context.plan.plan_text}

Plan summary:
${context.plan.summary}

Suggested files:
${context.plan.proposed_test_files.join("\n")}

Changed files excerpt:
${changedFiles.join("\n")}

Diff excerpt:
${diffExcerpt}

Return JSON only with:
- files: array of { path: string, content: string }
`;
}

/** Trims the generation-pass diff so Codex focuses on emitting tests instead of re-planning. */
function trimGenerationDiff(diff: string): string {
  if (diff.length <= MAX_GENERATION_DIFF_CHARS) {
    return diff;
  }

  return `${diff.slice(0, MAX_GENERATION_DIFF_CHARS)}\n[diff excerpt trimmed for focused test generation]`;
}
