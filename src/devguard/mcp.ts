import readline from "readline";
import { DevGuardService } from "./service";
import { RunInput } from "./types";
import { DevGuardError, toErrorMessage } from "./errors";

type JsonRpcId = string | number | null;

type JsonRpcRequest = {
  jsonrpc: "2.0";
  id?: JsonRpcId;
  method: string;
  params?: unknown;
};

const SUPPORTED_PROTOCOL_VERSIONS = ["2025-03-26", "2024-11-05"];

export class McpServer {
  private initialized = false;

  constructor(
    private service: DevGuardService,
    private output: (payload: unknown) => void = (payload) => {
      process.stdout.write(`${JSON.stringify(payload)}\n`);
    },
  ) {}

  start(): void {
    const rl = readline.createInterface({
      input: process.stdin,
      crlfDelay: Infinity,
    });

    rl.on("line", async (line) => {
      const trimmed = line.trim();
      if (!trimmed) return;

      try {
        const message = JSON.parse(trimmed);
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
          id: null,
          error: {
            code: -32700,
            message: toErrorMessage(error),
          },
        });
      }
    });
  }

  async handleMessage(message: JsonRpcRequest): Promise<void> {
    if (message.jsonrpc !== "2.0" || typeof message.method !== "string") {
      if (message.id !== undefined) {
        this.sendError(message.id, -32600, "Invalid request");
      }
      return;
    }

    if (message.method === "notifications/initialized") {
      this.initialized = true;
      return;
    }

    if (message.method === "initialize") {
      const params = this.asRecord(message.params);
      const requested = typeof params.protocolVersion === "string" ? params.protocolVersion : undefined;
      const protocolVersion = requested && SUPPORTED_PROTOCOL_VERSIONS.includes(requested)
        ? requested
        : SUPPORTED_PROTOCOL_VERSIONS[0];
      this.initialized = true;
      this.output({
        jsonrpc: "2.0",
        id: message.id ?? null,
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

    if (message.method === "ping") {
      this.output({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {},
      });
      return;
    }

    if (message.method === "tools/list") {
      this.ensureInitialized(message.id ?? null);
      this.output({
        jsonrpc: "2.0",
        id: message.id ?? null,
        result: {
          tools: this.getTools(),
        },
      });
      return;
    }

    if (message.method === "tools/call") {
      try {
        this.ensureInitialized(message.id ?? null);
        const params = this.asRecord(message.params);
        const name = typeof params.name === "string" ? params.name : "";
        const args = this.asRecord(params.arguments);
        const result = await this.handleToolCall(name, args);
        this.output({
          jsonrpc: "2.0",
          id: message.id ?? null,
          result,
        });
      } catch (error) {
        this.output({
          jsonrpc: "2.0",
          id: message.id ?? null,
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

    if (message.id !== undefined) {
      this.sendError(message.id ?? null, -32601, `Method not found: ${message.method}`);
    }
  }

  private async handleToolCall(name: string, args: Record<string, unknown>) {
    switch (name) {
      case "run_full_review":
        return this.ok(await this.service.startFullReview(this.normalizeInput(args)), "Full review queued");
      case "scan_code":
        return this.ok(await this.service.startCodeScan(this.normalizeInput(args)), "Code scan queued");
      case "scan_dependencies":
        return this.ok(await this.service.startDependencyScan(this.normalizeInput(args)), "Dependency scan queued");
      case "test_changes":
        return this.ok(await this.service.startTestChanges(this.normalizeInput(args)), "Test run queued");
      case "get_run_status":
        return this.ok(this.service.getRunStatus(this.requireRunId(args)), "Run status");
      case "get_run_results":
        return this.ok(this.service.getRunResults(this.requireRunId(args)), "Run results");
      case "apply_generated_tests":
        return this.ok(await this.service.applyGeneratedTests(this.requireRunId(args)), "Generated tests applied");
      default:
        throw new DevGuardError(`Unknown tool: ${name}`, "unknown_tool");
    }
  }

  private normalizeInput(args: Record<string, unknown>): RunInput {
    const gitTarget = args.git_target;
    if (gitTarget && !["latest-commit", "working-tree", "custom"].includes(String(gitTarget))) {
      throw new DevGuardError("git_target must be latest-commit, working-tree, or custom", "invalid_git_target");
    }
    if (String(gitTarget) === "custom" && typeof args.git_ref_or_range !== "string") {
      throw new DevGuardError("git_ref_or_range is required when git_target is custom", "missing_git_range");
    }
    return {
      repo_path: typeof args.repo_path === "string" ? args.repo_path : undefined,
      git_target: gitTarget ? String(gitTarget) as RunInput["git_target"] : undefined,
      git_ref_or_range: typeof args.git_ref_or_range === "string" ? args.git_ref_or_range : undefined,
      prompt: typeof args.prompt === "string" ? args.prompt : undefined,
      model: typeof args.model === "string" ? args.model : undefined,
    };
  }

  private requireRunId(args: Record<string, unknown>): number {
    const runId = Number(args.run_id);
    if (!Number.isFinite(runId) || runId <= 0) {
      throw new DevGuardError("run_id must be a positive number", "invalid_run_id");
    }
    return runId;
  }

  private ok(payload: unknown, label: string) {
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

  private getTools() {
    const runInputSchema = {
      type: "object",
      properties: {
        repo_path: { type: "string", description: "Optional repo path; defaults to the current working directory." },
        git_target: {
          type: "string",
          enum: ["latest-commit", "working-tree", "custom"],
          description: "Git target to inspect. Defaults to latest-commit.",
        },
        git_ref_or_range: { type: "string", description: "Commit id or range when git_target is custom." },
        prompt: { type: "string", description: "Extra human guidance for the run." },
        model: { type: "string", description: "Optional model id for the generation provider." },
      },
      additionalProperties: false,
    };

    return [
      {
        name: "run_full_review",
        description: "Inspect git changes, generate tests in an ephemeral workspace, run tests, scan code, scan dependencies, and return a dashboard URL.",
        inputSchema: runInputSchema,
      },
      {
        name: "scan_code",
        description: "Run deterministic code analysis for a Node/TypeScript repository.",
        inputSchema: runInputSchema,
      },
      {
        name: "scan_dependencies",
        description: "Inventory Node dependencies and query OSV for vulnerability findings.",
        inputSchema: runInputSchema,
      },
      {
        name: "test_changes",
        description: "Generate tests for git changes and execute them in an ephemeral workspace.",
        inputSchema: runInputSchema,
      },
      {
        name: "get_run_status",
        description: "Fetch the current status and progress log for a run.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
      {
        name: "get_run_results",
        description: "Fetch the final persisted results for a run.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
      {
        name: "apply_generated_tests",
        description: "Write generated test files from a prior run back into the repository. This is the only repo-mutating tool.",
        inputSchema: {
          type: "object",
          properties: { run_id: { type: "number" } },
          required: ["run_id"],
          additionalProperties: false,
        },
      },
    ];
  }

  private sendError(id: JsonRpcId, code: number, message: string): void {
    this.output({
      jsonrpc: "2.0",
      id,
      error: { code, message },
    });
  }

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

  private asRecord(value: unknown): Record<string, unknown> {
    if (value && typeof value === "object" && !Array.isArray(value)) {
      return value as Record<string, unknown>;
    }

    return {};
  }
}
