# devgaurd

`devgaurd` is a local-first MCP server for Codex and Claude Code.

It can:

- inspect git changes
- generate tests in an ephemeral workspace
- run tests safely without mutating the repo by default
- scan changed code for lint, consistency, and security issues
- scan Node dependencies and query OSV for vulnerability findings
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

- `Use devgaurd to review the latest commit`
- `Use devgaurd to scan dependencies`
- `Use devgaurd to test changes`

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

Use the sample in [examples/claude-code.mcp.json](/home/andy/Dev/CRM/devgaurd/examples/claude-code.mcp.json).

## Commands

- `npm run build`
- `npm start`
- `npm run doctor`
- `npm test`

## Local Data

By default devgaurd stores data in:

- `~/.devgaurd/devgaurd.db`
- `~/.devgaurd/artifacts/<run_id>/`

If the environment cannot write there, it falls back to a local `.devgaurd/` directory.

## Notes

- Node/TypeScript repositories are the supported v1 target.
- Dependency scanning currently expects `package-lock.json`.
- Test generation uses the local Codex CLI provider.

## Publish This Repo

This standalone repo already exists locally at [devgaurd](/home/andy/Dev/CRM/devgaurd) and is archived at [devgaurd.tar.gz](/home/andy/Dev/CRM/devgaurd.tar.gz).

GitHub publishing was not completed here because the GitHub CLI is not installed in this environment. The repo is ready for you to push from your machine:

```bash
cd /home/andy/Dev/CRM/devgaurd
git remote add origin <your-github-url>
git push -u origin main
```
