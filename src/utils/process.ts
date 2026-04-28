import { spawn, spawnSync, SpawnOptions, SpawnSyncOptionsWithStringEncoding } from "node:child_process";

/** Normalized result shape for synchronous and asynchronous child processes. */
export type CommandResult = {
  status: number | null;
  signal: NodeJS.Signals | null;
  stdout: string;
  stderr: string;
  error: NodeJS.ErrnoException | null;
};

/** Shared options for DevGuard child-process execution helpers. */
export type CommandOptions = {
  cwd?: string | undefined;
  input?: string | undefined;
  timeoutMs?: number | undefined;
  env?: NodeJS.ProcessEnv | undefined;
  shell?: boolean | string | undefined;
  maxBufferBytes?: number | undefined;
};

const DEFAULT_MAX_BUFFER_BYTES = 16 * 1024 * 1024;

/** Runs a command synchronously and returns stdout, stderr, status, signal, and error details. */
export function runCommandSync(
  command: string,
  args: string[],
  options: CommandOptions = {},
): CommandResult {
  const spawnOptions: SpawnSyncOptionsWithStringEncoding = {
    encoding: "utf8",
    env: options.env ?? process.env,
    maxBuffer: options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES,
  };

  if (options.cwd) spawnOptions.cwd = options.cwd;
  if (typeof options.input === "string") spawnOptions.input = options.input;
  if (typeof options.timeoutMs === "number") spawnOptions.timeout = options.timeoutMs;
  if (options.shell !== undefined) spawnOptions.shell = options.shell;

  const result = spawnSync(command, args, spawnOptions);

  return {
    status: result.status,
    signal: result.signal,
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    error: (result.error as NodeJS.ErrnoException | undefined) || null,
  };
}

/** Runs a command asynchronously and returns stdout, stderr, status, signal, and error details. */
export function runCommandAsync(
  command: string,
  args: string[],
  options: CommandOptions = {},
): Promise<CommandResult> {
  return new Promise((resolve) => {
    let stdout = "";
    let stderr = "";
    let settled = false;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let hardKillHandle: NodeJS.Timeout | null = null;
    let timeoutError: NodeJS.ErrnoException | null = null;
    let outputError: NodeJS.ErrnoException | null = null;
    let outputBytes = 0;
    const maxBufferBytes = options.maxBufferBytes ?? DEFAULT_MAX_BUFFER_BYTES;

    /** Resolves the command once and clears any active timeout. */
    const finish = (result: CommandResult): void => {
      if (settled) return;
      settled = true;
      if (timeoutHandle) {
        clearTimeout(timeoutHandle);
      }
      if (hardKillHandle) {
        clearTimeout(hardKillHandle);
      }
      resolve(result);
    };

    try {
      const spawnOptions: SpawnOptions = {
        env: options.env ?? process.env,
        stdio: "pipe",
      };

      if (options.cwd) spawnOptions.cwd = options.cwd;
      if (options.shell !== undefined) spawnOptions.shell = options.shell;

      const child = spawn(command, args, spawnOptions);

      /** Appends process output until the configured combined buffer limit is reached. */
      const appendOutput = (current: string, chunk: Buffer): string => {
        if (outputError) {
          return current;
        }

        const text = chunk.toString();
        outputBytes += Buffer.byteLength(text);
        if (outputBytes > maxBufferBytes) {
          const error = new Error(`Command output exceeded ${maxBufferBytes} bytes`) as NodeJS.ErrnoException;
          error.code = "ENOBUFS";
          outputError = error;
          child.kill("SIGTERM");
          hardKillHandle = setTimeout(() => child.kill("SIGKILL"), 2000);
          return current;
        }

        return current + text;
      };

      child.stdout?.on("data", (chunk) => {
        stdout = appendOutput(stdout, chunk);
      });

      child.stderr?.on("data", (chunk) => {
        stderr = appendOutput(stderr, chunk);
      });

      child.on("error", (error) => {
        finish({
          status: null,
          signal: null,
          stdout,
          stderr,
          error: error as NodeJS.ErrnoException,
        });
      });

      child.on("close", (status, signal) => {
        finish({
          status,
          signal,
          stdout,
          stderr,
          error: timeoutError || outputError,
        });
      });

      if (typeof options.input === "string" && options.input.length > 0) {
        child.stdin?.write(options.input);
      }
      child.stdin?.end();

      if (typeof options.timeoutMs === "number" && options.timeoutMs > 0) {
        timeoutHandle = setTimeout(() => {
          const error = new Error(`Command timed out after ${options.timeoutMs}ms`) as NodeJS.ErrnoException;
          error.code = "ETIMEDOUT";
          timeoutError = error;
          child.kill("SIGTERM");
          hardKillHandle = setTimeout(() => child.kill("SIGKILL"), 2000);
        }, options.timeoutMs);
      }
    } catch (error) {
      finish({
        status: null,
        signal: null,
        stdout,
        stderr,
        error: error as NodeJS.ErrnoException,
      });
    }
  });
}

/** Merges optional environment overrides with the current process environment. */
export function withEnv(overrides?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return overrides ? { ...process.env, ...overrides } : process.env;
}
