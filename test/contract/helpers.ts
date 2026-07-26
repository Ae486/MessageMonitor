/**
 * MCP contract-test rig: a real McpServer + Client pair over
 * InMemoryTransport against a real temp SQLite database.
 */
import { Writable } from "node:stream";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AppConfig } from "../../src/config/schema.ts";
import { createFeedService } from "../../src/feed/feed-service.ts";
import { createIngestCoordinator } from "../../src/ingest/ingest-coordinator.ts";
import { createLogger } from "../../src/logging/logger.ts";
import { registerTools } from "../../src/mcp/register-tools.ts";
import { createMcpServer } from "../../src/mcp/server.ts";
import { createStatusService, type ServiceHealth } from "../../src/mcp/status-service.ts";
import { createConversationReader } from "../../src/query/conversation-reader.ts";
import type { LifecycleController } from "../../src/runtime/lifecycle-controller.ts";
import { createSummaryQueue, type SummaryQueue } from "../../src/summary/summary-queue.ts";
import { openTestDb, type TestDb } from "../unit/storage/helpers.ts";
import { fakeProducer, type FakeProducer } from "../unit/summary/helpers.ts";

const silentLog = createLogger("error", new Writable({ write: (_c, _e, cb) => cb() }));

export function contractConfig(): AppConfig {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: {
      provider: "llonebot",
      protocol: "onebot11",
      mode: "forward-websocket",
      url: "ws://127.0.0.1:3001",
      accessTokenEnv: "T",
      connectTimeoutMs: 5000,
      reconnectIntervalMs: 5000,
      heartbeatTimeoutMs: 130000,
      requireSelfMessageReporting: true,
    },
    capture: {
      groups: { whitelist: ["123456789"] },
      friends: { mode: "all", whitelist: [] },
    },
    messages: { retainRecalledContent: true, exposeRecalledContentToAgent: false },
    storage: {
      databasePath: ":memory:",
      messageRetentionDays: 30,
      summaryRetentionDays: 180,
      cleanupIntervalHours: 24,
    },
    summary: {
      enabled: true,
      groupWhitelist: ["123456789"],
      threshold: 3,
      maxConcurrentTasks: 1,
      maxInputTokensPerCall: 12000,
      maxRetries: 1,
      retryBaseDelayMs: 1000,
      requestTimeoutMs: 5000,
      additionalPrompt: "",
      producer: { type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" },
      dimensions: {
        keyPoints: { description: "关键事实" },
        conflicts: { description: "分歧" },
      },
    },
    agent: { consumerId: "taki-main" },
    logging: { level: "error", includeMessageContent: false },
  };
}

export interface ContractRig {
  t: TestDb;
  client: Client;
  producer: FakeProducer;
  queue: SummaryQueue;
  ingest: ReturnType<typeof createIngestCoordinator>;
  health: ServiceHealth;
  lifecycleState: { state: "dormant" | "connecting" | "verifying" | "active"; mismatch: boolean };
  callTool(name: string, args?: Record<string, unknown>): Promise<Record<string, unknown>>;
  dispose(): Promise<void>;
}

export async function startContractRig(config: AppConfig = contractConfig()): Promise<ContractRig> {
  const t = openTestDb();
  const producer = fakeProducer();
  const queue = createSummaryQueue(config.summary, {
    units: t.storage.summaryUnits,
    producer,
    log: silentLog,
    retryDelayMs: () => 5,
  });
  const ingest = createIngestCoordinator(config, t.storage, silentLog, {
    onSummaryCandidate: (conversationId) => {
      queue.poke(conversationId);
    },
  });

  const lifecycleState = {
    state: "active" as "dormant" | "connecting" | "verifying" | "active",
    mismatch: false,
  };
  const lifecycle: LifecycleController = {
    start() {},
    getStatus() {
      return {
        state: lifecycleState.state,
        accountMismatch: lifecycleState.mismatch,
        ...(lifecycleState.state === "active" ? { connectedSelfUin: "10001", connectedAt: 1000 } : {}),
        ...(lifecycleState.mismatch ? { connectedSelfUin: "99999" } : {}),
      };
    },
    close: () => Promise.resolve(),
  };

  const health: ServiceHealth = { storageDegraded: false, maintenanceFailed: false };
  const server = createMcpServer("0.1.0-test");
  registerTools(server, {
    status: createStatusService({ db: t.db, storage: t.storage, config, lifecycle, summaryQueue: queue, health }),
    feed: createFeedService(t.db, t.storage, config.agent.consumerId, config.account.targetSelfUin),
    reader: createConversationReader(t.db, t.storage, config),
    config,
  });

  const client = new Client({ name: "contract-test", version: "1.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);

  return {
    t,
    client,
    producer,
    queue,
    ingest,
    health,
    lifecycleState,
    async callTool(name, args = {}) {
      const result = await client.callTool({ name, arguments: args });
      const text = (result.content as { type: string; text: string }[])[0]?.text ?? "{}";
      const payload = JSON.parse(text) as Record<string, unknown>;
      if (result.isError === true) {
        return payload;
      }
      return payload;
    },
    async dispose() {
      await client.close();
      await queue.close();
      t.dispose();
    },
  };
}
