# devgaurd

`devgaurd` is a local-first MCP server for Codex and Claude Code.

It can:

- inspect git changes
- generate tests in an ephemeral workspace
- run tests safely without mutating the repo by default
- lint code for static feedback
- scan Node dependencies and produce a vulnerability/risk report
- persist local run history and expose a minimal local dashboard

## Quick Start

```bash
npm install
npm run build
npm run doctor
```

Start the MCP server:

```bash
npm start
```

## Connect To Codex

```bash
codex mcp add devgaurd -- node /absolute/path/to/devgaurd/dist/devguard/cli.js
```

Then restart Codex and ask:

- `Use devgaurd to test changes`
- `Use devgaurd to lint code`
- `Use devgaurd to scan dependencies`

Codex CLI syntax was verified locally with:

```bash
codex mcp add --help
codex mcp list
```

## Connect To Claude Code

Anthropic’s Claude Code docs support local stdio MCP servers via `claude mcp add` and project-level `.mcp.json` config files.

Local user setup:

```bash
claude mcp add devgaurd -- node /absolute/path/to/devgaurd/dist/devguard/cli.js
```

Project-shared config:

Use the sample in [examples/claude-code.mcp.json](examples/claude-code.mcp.json).

## Commands

- `npm run build`
- `npm start`
- `npm run doctor`
- `npm test`

## MCP Tools

- `test_changes`: generate tests for current git changes, run them in a throwaway workspace, and persist the result. Defaults to the working tree.
- `lint_code`: run lint/static checks and store findings.
- `scan_dependencies`: check locked npm dependencies against OSV, npm registry metadata, and `npm audit signatures`; writes `dependency-report.json` and `dependency-report.md`.
- `get_run_status`: fetch progress plus any available result data for a queued or completed run.
- `commit_generated_tests`: write generated test files from a prior `test_changes` run into the real repository. This does not create a git commit.

## Local Data

By default devgaurd stores data in:

- `~/.devgaurd/devgaurd.db`
- `~/.devgaurd/artifacts/<run_id>/`
- `~/.devgaurd/codex-home/`

If the environment cannot write there, it falls back to a local `.devgaurd/` directory.

Devguard copies Codex auth into its managed `codex-home`, but intentionally does not copy `config.toml`; this keeps nested Codex runs from inheriting MCP servers, plugins, or personal model defaults. Override the generated-test model with `DEVGUARD_DEFAULT_MODEL` when needed.

## Notes

- Node/TypeScript repositories are the supported v1 target.
- Dependency scanning currently expects `package-lock.json`.
- Test generation uses the local Codex CLI provider.
- Technical cleanup notes and source references live in [docs/technical-cleanup.md](docs/technical-cleanup.md).

## Publish This Repo

This standalone repo already exists locally and can be published to a remote GitHub repository.

GitHub publishing was not completed here because the GitHub CLI is not installed in this environment. The repo is ready for you to push from your machine:

```bash
cd /home/andy/Dev/devgaurd
git remote add origin <your-github-url>
git push -u origin main
```
