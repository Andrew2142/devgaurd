import fs from "node:fs";
import path from "node:path";
import type { ProjectProfile } from "./codex-runner-service";

/** Detects a repository's ecosystem, package manager, and likely test command from manifest files. */
export function detectProjectProfile(projectPath: string): ProjectProfile {
  const packageJsonPath = path.join(projectPath, "package.json");
  const composerJsonPath = path.join(projectPath, "composer.json");
  const pyprojectPath = path.join(projectPath, "pyproject.toml");
  const goModPath = path.join(projectPath, "go.mod");
  const cargoTomlPath = path.join(projectPath, "Cargo.toml");
  const pomXmlPath = path.join(projectPath, "pom.xml");

  if (fs.existsSync(packageJsonPath)) {
    const pkg = JSON.parse(fs.readFileSync(packageJsonPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const packageManager = fs.existsSync(path.join(projectPath, "pnpm-lock.yaml"))
      ? "pnpm"
      : fs.existsSync(path.join(projectPath, "yarn.lock"))
        ? "yarn"
        : "npm";
    const scriptCommand = pkg.scripts && typeof pkg.scripts.test === "string"
      ? `${packageManager} test`
      : null;
    const inferredCommand = scriptCommand
      || (pkg.devDependencies?.vitest ? `${packageManager} exec vitest run` : null)
      || (pkg.devDependencies?.jest ? `${packageManager} exec jest --runInBand` : null)
      || null;

    return {
      ecosystem: "node",
      language: "javascript/typescript",
      packageManager,
      command: inferredCommand,
      packageSummary: {
        name: pkg.name || path.basename(projectPath),
        scripts: pkg.scripts || {},
      },
    };
  }

  if (fs.existsSync(composerJsonPath)) {
    const composer = JSON.parse(fs.readFileSync(composerJsonPath, "utf8")) as {
      name?: string;
      scripts?: Record<string, unknown>;
    };
    const inferredCommand = composer.scripts?.test
      ? "composer test"
      : fs.existsSync(path.join(projectPath, "vendor", "bin", "pest"))
        ? "vendor/bin/pest"
        : fs.existsSync(path.join(projectPath, "vendor", "bin", "phpunit"))
          ? "vendor/bin/phpunit"
          : null;

    return {
      ecosystem: "php",
      language: "php",
      packageManager: "composer",
      command: inferredCommand,
      packageSummary: {
        name: composer.name || path.basename(projectPath),
      },
    };
  }

  if (fs.existsSync(pyprojectPath) || fs.existsSync(path.join(projectPath, "requirements.txt"))) {
    return {
      ecosystem: "python",
      language: "python",
      packageManager: "pip",
      command: fs.existsSync(path.join(projectPath, "pytest.ini")) || fs.existsSync(path.join(projectPath, "tests"))
        ? "pytest"
        : "python -m unittest",
      packageSummary: {
        name: path.basename(projectPath),
      },
    };
  }

  if (fs.existsSync(pomXmlPath)) {
    return {
      ecosystem: "java",
      language: "java",
      packageManager: "maven",
      command: "mvn test",
      packageSummary: { name: path.basename(projectPath) },
    };
  }

  if (fs.existsSync(goModPath)) {
    return {
      ecosystem: "go",
      language: "go",
      packageManager: "go",
      command: "go test ./...",
      packageSummary: { name: path.basename(projectPath) },
    };
  }

  if (fs.existsSync(cargoTomlPath)) {
    return {
      ecosystem: "rust",
      language: "rust",
      packageManager: "cargo",
      command: "cargo test",
      packageSummary: { name: path.basename(projectPath) },
    };
  }

  return {
    ecosystem: "unknown",
    language: "unknown",
    packageManager: "unknown",
    command: null,
    packageSummary: {
      name: path.basename(projectPath),
    },
  };
}
