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

## Commands

- `npm run build`
- `npm start`
- `npm run doctor`
- `npm test`

## Local Data

By default devgaurd stores data in:

- `~/.devguard/devguard.db`
- `~/.devguard/artifacts/<run_id>/`

If the environment cannot write there, it falls back to a local `.devguard/` directory.

## Notes

- Node/TypeScript repositories are the supported v1 target.
- Dependency scanning currently expects `package-lock.json`.
- Test generation uses the local Codex CLI provider.
