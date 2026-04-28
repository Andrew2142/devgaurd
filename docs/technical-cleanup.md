# Technical Cleanup Notes

This pass keeps devgaurd focused on local agent review work while tightening the TypeScript and Node.js implementation.

## TypeScript

- `tsconfig.json` now keeps `strict` enabled and adds `exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noImplicitReturns`, `noUnusedLocals`, and `noUnusedParameters`.
- External JSON parsing now starts from `unknown`/`Record<string, unknown>` and narrows before use.
- Internal lint results are named `lintFindings`; the SQLite column remains `code_findings` for local data compatibility.
- Public classes, functions, methods, and key internal helpers use TSDoc-style `/** */` comments so editor hover text explains intent without repeating type annotations.

References:

- TypeScript `strict`: https://www.typescriptlang.org/tsconfig/strict.html
- TypeScript `exactOptionalPropertyTypes`: https://www.typescriptlang.org/tsconfig/exactOptionalPropertyTypes.html
- TypeScript `noUncheckedIndexedAccess`: https://www.typescriptlang.org/tsconfig/noUncheckedIndexedAccess.html
- TypeScript narrowing: https://www.typescriptlang.org/docs/handbook/2/narrowing.html
- TypeScript JSDoc reference: https://www.typescriptlang.org/docs/handbook/jsdoc-supported-types.html
- TSDoc overview: https://tsdoc.org/

## Process Execution

- Subprocess handling is centralized in `src/utils/process.ts`.
- Direct executable calls use `spawn`/`spawnSync` with argument arrays.
- Shell execution remains explicit for repository test commands because package scripts are command strings.

References:

- Node.js child process docs: https://nodejs.org/api/child_process.html

## Module Shape

- Lint scanning lives in `src/devguard/lint-scanner.ts`.
- Dependency scanning lives in `src/devguard/dependency-scanner.ts`.
- Dependency report rendering lives in `src/devguard/dependency-report.ts`.
- Git context collection lives in `src/services/git-context-service.ts`.
- Project profile detection lives in `src/services/project-profile-service.ts`.

## Dependency Reporting

- `scan_dependencies` uses OSV for known vulnerabilities, npm registry metadata for package-version signals, and `npm audit signatures` for registry signature/provenance checks.

References:

- OSV API: https://google.github.io/osv.dev/api/
- npm registry signatures: https://docs.npmjs.com/verifying-registry-signatures
- npm package provenance: https://docs.npmjs.com/viewing-package-provenance
