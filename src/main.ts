/**
 * Entry point: strict config load, stderr logging, empty stdio MCP server,
 * graceful shutdown on signals, stdin EOF, and transport close.
 */
import process from "node:process";
import { ConfigError, loadConfig } from "./config/load-config.ts";
import { createLogger } from "./logging/logger.ts";
import { connectStdio, createMcpServer } from "./mcp/server.ts";
import { createShutdown, installShutdownTriggers } from "./runtime/shutdown.ts";

const VERSION = "0.1.0";

async function main(): Promise<void> {
  const bootLog = createLogger("info");

  let config;
  try {
    config = loadConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      bootLog.error({ issues: error.issues }, "configuration is invalid; refusing to start");
      process.exitCode = 1;
      return;
    }
    throw error;
  }

  const log = createLogger(config.logging.level);
  const server = createMcpServer(VERSION);
  const shutdown = createShutdown(server, log);

  server.server.onclose = () => {
    shutdown("transport closed");
  };
  installShutdownTriggers(shutdown);

  await connectStdio(server);
  log.info(
    {
      version: VERSION,
      bridgeProvider: config.bridge.provider,
      summaryEnabled: config.summary.enabled,
      logLevel: config.logging.level,
    },
    "qq-message-monitor started",
  );
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? (error.stack ?? error.message) : String(error);
  process.stderr.write(`${JSON.stringify({ ts: Date.now(), level: "error", msg: "fatal", err: message })}\n`);
  process.exit(1);
});
