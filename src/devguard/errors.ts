/** Error type for expected DevGuard failures that should surface cleanly to MCP clients. */
export class DevGuardError extends Error {
  /** Creates an error with a stable machine-readable code. */
  constructor(
    message: string,
    public readonly code: string,
  ) {
    super(message);
    this.name = "DevGuardError";
  }
}

/** Converts unknown thrown values into a user-facing error message. */
export function toErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    return error.message;
  }

  if (typeof error === "string") {
    return error;
  }

  return "Unknown error";
}
