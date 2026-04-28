import readline from "node:readline";
import { DevGuardService } from "./service";
import { RunInput } from "./types";
import { DevGuardError, toErrorMessage } from "./errors";

/** JSON-RPC id accepted by MCP requests and responses. */
type JsonRpcId = string | number | null;

/** Tool-call result format expected by MCP clients. */
type McpToolResult = {
  content: Array<{ type: "text"; text: string }>;
  structuredContent: unknown;
};

/** Tool definition advertised through tools/list. */
type McpToolDefinition = {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

/** Implements the stdio MCP server that exposes DevGuard tools to agent clients. */
export class McpServer {
  private initialized = false;

  /** Creates an MCP server around a DevGuard service and JSON-RPC output writer. */
  constructor(
    private service: DevGuardService,
    private output: (payload: unknown) => void = (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    },
  ) {}

  /** Starts reading newline-delimited JSON-RPC messages from stdin. */
  start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      let message: unknown;
      try {
        message = JSON.parse(trimmed);
      } catch (error) {
        this.output({
          jsonrpc: "2.0",
          id: null,
          error: {
            code: -32700,
            message: toErrorMessage(error),
          },
        });
        return;
      }

      try {
        if (Array.isArray(message)) {
          for (const item of message) {
            await this.handleMessage(item);
          }
          return;
        }
        await this.handleMessage(message);
      } catch (error) {
        this.output({
          jsonrpc: "2.0",
          id: this.getJsonRpcId(this.asRecord(message).id),
          error: {
            code: -32603,
            message: toErrorMessage(error),
          },
        });
      }
    });
  }

  /** Handles one parsed JSON-RPC request or notification. */
  async handleMessage(message: unknown): Promise<void> {
    const request = this.asRecord(message);
    const hasId = Object.prototype.hasOwnProperty.call(request, "id");
    const id = this.getJsonRpcId(request.id);
    const method = typeof request.method === "string" ? request.method : "";

    if (request.jsonrpc !== "2.0" || !method) {
      this.sendError(hasId ? id : null, -32600, "Invalid request");
      return;
    }

    if (method === "notifications/initialized") {
      return;
    }

    if (method === "initialize") {
      const params = this.asRecord(request.params);
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      this.initialized = true;
      this.output({
        jsonrpc: "2.0",
        id,
        result: {
          protocolVersion,
          capabilities: {
            tools: {},
          },
          serverInfo: {
            name: "devgaurd-mcp",
            version: "1.0.0",
          },
        },
      });
      return;
    }

    if (method === "ping") {
      this.output({
        jsonrpc: "2.0",
        id,
        result: {},
      });
      return;
    }

    if (method === "tools/list") {
      try {
        this.ensureInitialized(id);
      } catch (error) {
        this.sendError(id, -32002, toErrorMessage(error));
        return;
      }
      this.output({
        jsonrpc: "2.0",
        id,
        result: {
          tools: this.getTools(),
        },
      });
      return;
    }

    if (method === "tools/call") {
      try {
        this.ensureInitialized(id);
        const params = this.asRecord(request.params);
        const name = typeof params.name === "string" ? params.name : "";
        const args = this.asRecord(params.arguments);
        const result = await this.handleToolCall(name, args);
        this.output({
          jsonrpc: "2.0",
          id,
          result,
        });
      } catch (error) {
        this.output({
          jsonrpc: "2.0",
          id,
          result: {
            isError: true,
            content: [
              {
                type: "text",
                text: toErrorMessage(error),
              },
            ],
          },
        });
      }
      return;
    }

    if (hasId) {
      this.sendError(id, -32601, `Method not found: ${method}`);
    }
  }

  /** Dispatches an MCP tool call to the matching DevGuard service method. */
  private async handleToolCall(name: string, args: Record<string, unknown>): Promise<McpToolResult> {
    switch (name) {
      case "run_full_review":
        return this.ok(await this.service.startFullReview(this.normalizeInput(args)), "Full review queued");
      case "lint_code":
        return this.ok(await this.service.startLintCode(this.normalizeInput(args)), "Lint queued");
      case "scan_code":
        return this.ok(await this.service.startLintCode(this.normalizeInput(args)), "Lint queued");
      case "scan_dependencies":
        return this.ok(await this.service.startDependencyScan(this.normalizeInput(args)), "Dependency scan queued");
      case "test_changes":
        return this.ok(await this.service.startTestChanges(this.normalizeInput(args)), "Test run queued");
      case "get_run_status":
        return this.ok(this.service.getRunStatus(this.requireRunId(args)), "Run status");
      case "get_run_results":
        return this.ok(this.service.getRunResults(this.requireRunId(args)), "Run results");
      case "commit_generated_tests":
        return this.ok(await this.service.commitGeneratedTests(this.requireRunId(args)), "Generated tests committed");
      case "apply_generated_tests":
        return this.ok(await this.service.commitGeneratedTests(this.requireRunId(args)), "Generated tests committed");
      default:
        throw new DevGuardError(`Unknown tool: ${name}`, "unknown_tool");
    }
  }

  /** Normalizes MCP arguments into the internal run input shape. */
  private normalizeInput(args: Record<string, unknown>): RunInput {
    const gitTarget = args.git_target;
    if (gitTarget && !["latest-commit", "working-tree", "custom"].includes(String(gitTarget))) {
      throw new DevGuardError("git_target must be latest-commit, working-tree, or custom", "invalid_git_target");
    }
    if (String(gitTarget) === "custom" && typeof args.git_ref_or_range !== "string") {
      throw new DevGuardError("git_ref_or_range is required when git_target is custom", "missing_git_range");
    }
    const input: RunInput = {};
    if (typeof args.repo_path === "string") input.repo_path = args.repo_path;
    if (gitTarget) input.git_target = String(gitTarget) as NonNullable<RunInput["git_target"]>;
    if (typeof args.git_ref_or_range === "string") input.git_ref_or_range = args.git_ref_or_range;
    if (typeof args.prompt === "string") input.prompt = args.prompt;
    if (typeof args.model === "string") input.model = args.model;
    return input;
  }

  /** Reads and validates a positive run id from MCP arguments. */
  private requireRunId(args: Record<string, unknown>): number {
    const runId = Number(args.run_id);
    if (!Number.isFinite(runId) || runId <= 0) {
      throw new DevGuardError("run_id must be a positive number", "invalid_run_id");
    }
    return runId;
  }

  /** Wraps a service payload in the MCP tool-result content format. */
  private ok(payload: unknown, label: string): McpToolResult {
    return {
      content: [
        {
          type: "text",
          text: `${label}\n${JSON.stringify(payload, null, 2)}`,
        },
      ],
      structuredContent: payload,
    };
  }

  /** Returns the public DevGuard tool definitions advertised over MCP. */
  private getTools(): McpToolDefinition[] {
    const runInputSchema = {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Optional repo path; defaults to the current working directory." },
        git_target: {
          type: "string",
          enum: ["latest-commit", "working-tree", "custom"],
          description: "Git target to inspect. test_changes defaults to working-tree; other tools default to latest-commit when they need git context.",
        },
        git_ref_or_range: { type: "string", description: "Commit id or range when git_target is custom." },
        prompt: { type: "string", description: "Extra human guidance for the run." },
        model: { type: "string", description: "Optional model id for the generation provider." },
      },
      additionalProperties: false,
    };

    return [
      {
        name: "test_changes",
        description: "Generate tests for current git changes and execute them in an ephemeral workspace. Defaults to working-tree.",
        inputSchema: runInputSchema,
      },
      {
        name: "lint_code",
        description: "Run lint and static code checks for a Node/TypeScript repository.",
        inputSchema: runInputSchema,
      },
      {
        name: "scan_dependencies",
        description: "Inventory locked Node dependencies and produce a vulnerability/risk report.",
        inputSchema: runInputSchema,
      },
      {
        name: "get_run_status",
        description: "Fetch the current status, progress log, and any available result details for a run.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
      {
        name: "commit_generated_tests",
        description: "Write generated test files from a prior run into the repository. This is the only repo-mutating tool and does not create a git commit.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    ];
  }

  /** Sends a JSON-RPC error response for protocol-level failures. */
  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.output({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

  /** Ensures the client completed MCP initialization before tool access. */
  private ensureInitialized(id: JsonRpcId): void {
    if (this.initialized) {
      return;
    }

    throw new DevGuardError(
      id == null
        ? "MCP server has not been initialized"
        : "MCP server has not been initialized. Call initialize first.",
      "not_initialized",
    );
  }

  /** Narrows unknown JSON values to plain object records for argument parsing. */
  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {};
  }

  /** Normalizes unknown JSON-RPC id values to the allowed response id shape. */
  private getJsonRpcId(value: unknown): JsonRpcId {
    if (typeof value === "string" || typeof value === "number" || value === null) {
      return value;
    }

    return null;
  }
}
