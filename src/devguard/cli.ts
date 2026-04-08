#!/usr/bin/env node

import { getDevGuardConfig } from "./config";
import { DashboardServer } from "./dashboard";
import { runDoctor } from "./doctor";
import { McpServer } from "./mcp";
import { DevGuardService } from "./service";
import { DevGuardStore } from "./storage";
import { toErrorMessage } from "./errors";

async function main(): Promise<void> {
  const config = getDevGuardConfig();
  const store = new DevGuardStore(config);
  const dashboard = new DashboardServer(config, store);
  const service = new DevGuardService(config, store, dashboard);

  const command = process.argv[2];
  if (command === "doctor") {
    const result = await runDoctor(config);
    for (const check of result.checks) {
      const prefix = check.ok ? "PASS" : "FAIL";
      console.log(`[${prefix}] ${check.name}: ${check.message}`);
    }
    process.exit(result.ok ? 0 : 1);
    return;
  }

  const server = new McpServer(service);
  const shutdown = async () => {
    try {
      await dashboard.close();
    } catch {
      // Best effort shutdown for local resources.
    }
    process.exit(0);
  };

  process.on("SIGINT", () => {
    void shutdown();
  });
  process.on("SIGTERM", () => {
    void shutdown();
  });

  server.start();
}

main().catch((error) => {
  console.error(toErrorMessage(error));
  process.exit(1);
});
