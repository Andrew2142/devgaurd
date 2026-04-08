#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

echo "Building devgaurd..."
(cd "$ROOT_DIR" && npm run build)

echo "Registering devgaurd with Codex MCP..."
codex mcp add devgaurd -- node "$ROOT_DIR/dist/devguard/cli.js"

echo "Done. Restart Codex and ask it to use devgaurd."
