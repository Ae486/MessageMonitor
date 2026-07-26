/**
 * Entry point: strict config load, stderr logging, SQLite open + forward
 * migration, retention cleanup scheduling, empty stdio MCP server, graceful
 * shutdown on signals, stdin EOF, and transport close.
 */
import process from "node:process";
import { ConfigError, loadConfig } from "./config/load-config.ts";
import { createIngestCoordinator } from "./ingest/ingest-coordinator.ts";
import { createLogger, type Logger } from "./logging/logger.ts";
import { connectStdio, createMcpServer } from "./mcp/server.ts";
import { createLifecycleController } from "./runtime/lifecycle-controller.ts";
import { createShutdown, installShutdownTriggers } from "./runtime/shutdown.ts";
import { openDatabase, type Database } from "./storage/database.ts";
import { createStorage } from "./storage/index.ts";
import { runCleanup } from "./storage/maintenance/cleanup.ts";
import { createOpenAiCompatibleProducer } from "./summary/summary-producer.ts";
import { createSummaryQueue } from "./summary/summary-queue.ts";
import type { AppConfig } from "./config/schema.ts";

const VERSION = "0.1.0";

function runScheduledCleanup(db: Database, config: AppConfig, log: Logger): void {
  try {
    const result = runCleanup(db, {
      messageRetentionDays: config.storage.messageRetentionDays,
      summaryRetentionDays: config.storage.summaryRetentionDays,
      now: Date.now(),
    });
    createStorage(db).runtimeState.set("lastCleanupAt", Date.now(), Date.now());
    log.info({ ...result }, "retention cleanup finished");
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.warn({ err: reason }, "retention cleanup failed; capture is unaffected");
  }
}

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

  let db: Database;
  try {
    db = openDatabase(config.storage.databasePath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    log.error({ err: reason }, "cannot open or migrate the database; refusing to start");
    process.exitCode = 1;
    return;
  }

  runScheduledCleanup(db, config, log);
  const cleanupTimer = setInterval(
    () => {
      runScheduledCleanup(db, config, log);
    },
    config.storage.cleanupIntervalHours * 60 * 60 * 1000,
  );

  const storage = createStorage(db);
  const accessToken = process.env[config.bridge.accessTokenEnv] ?? "";

  const producerConfig = config.summary.producer;
  const summaryQueue = createSummaryQueue(config.summary, {
    units: storage.summaryUnits,
    producer:
      config.summary.enabled && producerConfig !== undefined
        ? createOpenAiCompatibleProducer({
            baseUrl: producerConfig.baseUrl,
            model: producerConfig.model,
            ...(producerConfig.apiKeyEnv !== undefined
              ? { apiKey: process.env[producerConfig.apiKeyEnv] }
              : {}),
            requestTimeoutMs: config.summary.requestTimeoutMs,
          })
        : { produce: () => Promise.reject(new Error("summary disabled")) },
    log,
  });

  const ingest = createIngestCoordinator(config, storage, log, {
    onSummaryCandidate: (conversationId) => {
      summaryQueue.poke(conversationId);
    },
  });
  const lifecycle = createLifecycleController(
    {
      targetSelfUin: config.account.targetSelfUin,
      url: config.bridge.url,
      accessToken,
      connectTimeoutMs: config.bridge.connectTimeoutMs,
      reconnectIntervalMs: config.bridge.reconnectIntervalMs,
      heartbeatTimeoutMs: config.bridge.heartbeatTimeoutMs,
    },
    {
      storage,
      log,
      onEvent: (event, now) => {
        ingest.handleEvent(event, now);
      },
    },
  );

  const server = createMcpServer(VERSION);
  const shutdown = createShutdown(
    {
      close: async () => {
        clearInterval(cleanupTimer);
        await lifecycle.close();
        await summaryQueue.close();
        await server.close();
        db.close();
      },
    },
    log,
  );

  server.server.onclose = () => {
    shutdown("transport closed");
  };
  installShutdownTriggers(shutdown);

  await connectStdio(server);
  storage.conversations.syncSummaryFlags(
    config.account.targetSelfUin,
    config.summary.enabled ? config.summary.groupWhitelist : [],
    Date.now(),
  );
  summaryQueue.recover();
  lifecycle.start();
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
