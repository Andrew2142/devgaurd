const test = require("node:test");
const assert = require("node:assert/strict");

const { McpServer } = require("../../dist/devguard/mcp.js");

function createServiceStub() {
  return {
    startFullReview: async (input) => ({ run_id: 1, status: "queued", dashboard_url: "http://local/runs/1", started_at: "now", summary: JSON.stringify(input) }),
    startCodeScan: async (input) => ({ run_id: 2, status: "queued", dashboard_url: "http://local/runs/2", started_at: "now", summary: JSON.stringify(input) }),
    startLintCode: async (input) => ({ run_id: 2, status: "queued", dashboard_url: "http://local/runs/2", started_at: "now", summary: JSON.stringify(input) }),
    startDependencyScan: async (input) => ({ run_id: 3, status: "queued", dashboard_url: "http://local/runs/3", started_at: "now", summary: JSON.stringify(input) }),
    startTestChanges: async (input) => ({ run_id: 4, status: "queued", dashboard_url: "http://local/runs/4", started_at: "now", summary: JSON.stringify(input) }),
    getRunStatus: (runId) => ({ id: runId, status: "queued" }),
    getRunResults: (runId) => ({ id: runId, status: "completed" }),
    applyGeneratedTests: async (runId) => ({ run_id: runId, applied_files: ["src/example.test.ts"] }),
    commitGeneratedTests: async (runId) => ({ run_id: runId, committed_files: ["src/example.test.ts"] }),
  };
}

test("MCP server responds to initialize and tools/list", async () => {
  const sent = [];
  const server = new McpServer(createServiceStub(), (payload) => sent.push(payload));

  await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "node-test", version: "1.0.0" },
    },
  });
  await server.handleMessage({
    jsonrpc: "2.0",
    id: 2,
    method: "tools/list",
    params: {},
  });

  assert.equal(sent[0].result.protocolVersion, "2025-03-26");
  assert.ok(Array.isArray(sent[1].result.tools));
  assert.deepEqual(sent[1].result.tools.map((tool) => tool.name), [
    "test_changes",
    "lint_code",
    "scan_dependencies",
    "get_run_status",
    "commit_generated_tests",
  ]);
});

test("MCP server validates custom git ranges for tool calls", async () => {
  const sent = [];
  const server = new McpServer(createServiceStub(), (payload) => sent.push(payload));

  await server.handleMessage({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: {
      protocolVersion: "2025-03-26",
      capabilities: {},
      clientInfo: { name: "node-test", version: "1.0.0" },
    },
  });

  await server.handleMessage({
    jsonrpc: "2.0",
    id: 3,
    method: "tools/call",
    params: {
      name: "test_changes",
      arguments: {
        git_target: "custom",
      },
    },
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[1].result.isError, true);
  assert.match(sent[1].result.content[0].text, /git_ref_or_range is required/);
});

test("MCP server returns protocol errors for invalid or uninitialized requests", async () => {
  const sent = [];
  const server = new McpServer(createServiceStub(), (payload) => sent.push(payload));

  await server.handleMessage(null);
  await server.handleMessage({
    jsonrpc: "2.0",
    method: "notifications/initialized",
    params: {},
  });
  await server.handleMessage({
    jsonrpc: "2.0",
    id: 10,
    method: "tools/list",
    params: {},
  });

  assert.equal(sent.length, 2);
  assert.equal(sent[0].error.code, -32600);
  assert.equal(sent[1].id, 10);
  assert.equal(sent[1].error.code, -32002);
  assert.match(sent[1].error.message, /not been initialized/);
});
