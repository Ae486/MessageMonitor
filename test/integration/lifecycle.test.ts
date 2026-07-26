import { Writable } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.ts";
import {
  createLifecycleController,
  type LifecycleController,
} from "../../src/runtime/lifecycle-controller.ts";
import { groupMessage, heartbeat, lifecycleConnect } from "../fixtures/onebot-events.ts";
import { countRows, openTestDb, type TestDb } from "../unit/storage/helpers.ts";
import { createIngestCoordinator } from "../../src/ingest/ingest-coordinator.ts";
import type { AppConfig } from "../../src/config/schema.ts";

const silentLog = createLogger("error", new Writable({ write: (_c, _e, cb) => cb() }));

interface TestServer {
  port: number;
  sockets: WebSocket[];
  authHeaders: (string | undefined)[];
  close(): Promise<void>;
}

function startServer(token: string): Promise<TestServer> {
  return startServerOnPort(token, 0);
}

function startServerOnPort(token: string, listenPort: number): Promise<TestServer> {
  return new Promise((resolve) => {
    const sockets: WebSocket[] = [];
    const authHeaders: (string | undefined)[] = [];
    const wss = new WebSocketServer({ port: listenPort }, () => {
      const address = wss.address();
      const port = typeof address === "object" && address !== null ? address.port : 0;
      resolve({
        port,
        sockets,
        authHeaders,
        close: () =>
          new Promise((done) => {
            for (const socket of sockets) socket.terminate();
            wss.close(() => {
              done();
            });
          }),
      });
    });
    wss.on("connection", (socket, request) => {
      authHeaders.push(request.headers.authorization);
      if (request.headers.authorization !== `Bearer ${token}`) {
        socket.close(1008, "token verification failed");
        return;
      }
      sockets.push(socket);
    });
  });
}

function captureConfig(): AppConfig {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: {
      provider: "llonebot",
      protocol: "onebot11",
      mode: "forward-websocket",
      url: "ws://127.0.0.1:0",
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
      enabled: false,
      groupWhitelist: [],
      threshold: 30,
      maxConcurrentTasks: 1,
      maxInputTokensPerCall: 12000,
      maxRetries: 3,
      retryBaseDelayMs: 5000,
      requestTimeoutMs: 60000,
      additionalPrompt: "",
      dimensions: {},
    },
    agent: { consumerId: "taki-main" },
    logging: { level: "error", includeMessageContent: false },
  };
}

function makeController(
  t: TestDb,
  port: number,
  token: string,
  overrides: {
    heartbeatTimeoutMs?: number;
    reconnectIntervalMs?: number;
    now?: () => number;
  } = {},
): LifecycleController {
  const ingest = createIngestCoordinator(captureConfig(), t.storage, silentLog);
  return createLifecycleController(
    {
      targetSelfUin: "10001",
      url: `ws://127.0.0.1:${String(port)}`,
      accessToken: token,
      connectTimeoutMs: 2000,
      reconnectIntervalMs: overrides.reconnectIntervalMs ?? 100,
      heartbeatTimeoutMs: overrides.heartbeatTimeoutMs ?? 5000,
    },
    {
      storage: t.storage,
      log: silentLog,
      onEvent: (event, now) => {
        ingest.handleEvent(event, now);
      },
      ...(overrides.now !== undefined ? { now: overrides.now } : {}),
    },
  );
}

const cleanups: (() => Promise<void> | void)[] = [];

afterEach(async () => {
  for (const cleanup of cleanups.splice(0)) {
    await cleanup();
  }
});

function track(t: TestDb, server: TestServer, controller: LifecycleController): void {
  cleanups.push(async () => {
    await controller.close();
    await server.close();
    t.dispose();
  });
}

describe("lifecycle controller", () => {
  it("authenticates, verifies self_id, establishes the baseline, and captures messages", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    const controller = makeController(t, server.port, "tok");
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    expect(server.authHeaders[0]).toBe("Bearer tok");
    expect(t.storage.runtimeState.get<number>("monitoringBaseline")).toBeGreaterThan(0);

    server.sockets[0]?.send(JSON.stringify(groupMessage()));
    await vi.waitFor(() => {
      expect(countRows(t.db, "messages")).toBe(1);
    });
    expect(controller.getStatus().connectedSelfUin).toBe("10001");
  });

  it("refuses a mismatched account and never captures (AC-02)", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    const controller = makeController(t, server.port, "tok", { reconnectIntervalMs: 60000 });
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect(77777)));
    server.sockets[0]?.send(JSON.stringify(groupMessage({ self_id: 77777 })));

    await vi.waitFor(() => {
      expect(controller.getStatus().accountMismatch).toBe(true);
    });
    expect(controller.getStatus().state).not.toBe("active");
    expect(countRows(t.db, "messages")).toBe(0);
    expect(t.storage.runtimeState.get("monitoringBaseline")).toBeUndefined();
  });

  it("reconnects after a drop and records the offline interval with exact boundaries", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    let clock = 1000;
    const controller = makeController(t, server.port, "tok", { now: () => clock });
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    clock = 5000;
    server.sockets[0]?.terminate();
    await vi.waitFor(
      () => {
        expect(server.sockets).toHaveLength(2);
      },
      { timeout: 5000 },
    );
    clock = 9000;
    server.sockets[1]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    expect(t.storage.captureGaps.unresolvedCount()).toBe(1);
    const gaps = t.storage.captureGaps.listOverlapping(0, Number.MAX_SAFE_INTEGER);
    // Start = last event before the drop (verification event at t=1000);
    // end = the reconnect verification time (docs/architecture.md section 6).
    expect(gaps[0]).toMatchObject({
      reason_code: "offline",
      started_at: 1000,
      ended_at: 9000,
    });
  });

  it("clamps the crash-restart gap to the last ingest checkpoint, not stale close markers", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    // Simulated pre-crash state: an older graceful cycle left stale markers,
    // then a later session connected at 6000 and captured a message at 7000
    // before the process died without any close path running.
    t.storage.runtimeState.set("monitoringBaseline", 500, 500);
    t.storage.runtimeState.set("lastEventAt", 2000, 2000);
    t.storage.runtimeState.set("lastDisconnectAt", 3000, 3000);
    t.storage.runtimeState.set("lastConnectedAt", 6000, 6000);
    const ingest = createIngestCoordinator(captureConfig(), t.storage, silentLog);
    ingest.handleEvent(groupMessage(), 7000);

    let clock = 20000;
    const controller = makeController(t, server.port, "tok", { now: () => clock });
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    const gaps = t.storage.captureGaps.listOverlapping(0, Number.MAX_SAFE_INTEGER);
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ started_at: 7000, ended_at: 20000 });
  });

  it("terminates a silent connection after the heartbeat timeout and reconnects", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    const controller = makeController(t, server.port, "tok", { heartbeatTimeoutMs: 1000 });
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    // Server goes silent; the client must give up on the half-open socket.
    await vi.waitFor(
      () => {
        expect(server.sockets).toHaveLength(2);
      },
      { timeout: 8000 },
    );
  });

  it("keeps a connection alive while inbound frames arrive within the heartbeat timeout", async () => {
    const t = openTestDb();
    const server = await startServer("tok");
    const controller = makeController(t, server.port, "tok", { heartbeatTimeoutMs: 700 });
    track(t, server, controller);

    controller.start();
    await vi.waitFor(() => {
      expect(server.sockets).toHaveLength(1);
    });
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });

    // Frames every 300ms across 4x the 700ms deadline: activity must defer it.
    const feeder = setInterval(() => {
      server.sockets[0]?.send(JSON.stringify(heartbeat()));
    }, 300);
    cleanups.push(() => {
      clearInterval(feeder);
    });
    await new Promise((resolve) => setTimeout(resolve, 2800));
    clearInterval(feeder);

    expect(server.sockets).toHaveLength(1);
    expect(controller.getStatus().state).toBe("active");
  });

  it("keeps retrying while the server is down and connects once it appears", async () => {
    const t = openTestDb();
    // Reserve a port, then free it so the controller's first attempts fail.
    const placeholder = await startServer("tok");
    const port = placeholder.port;
    await placeholder.close();

    const controller = makeController(t, port, "tok");
    cleanups.push(async () => {
      await controller.close();
      t.dispose();
    });

    controller.start();
    await new Promise((resolve) => setTimeout(resolve, 400));
    expect(controller.getStatus().state).not.toBe("active");

    const server = await startServerOnPort("tok", port);
    cleanups.push(() => server.close());
    await vi.waitFor(
      () => {
        expect(server.sockets).toHaveLength(1);
      },
      { timeout: 5000 },
    );
    server.sockets[0]?.send(JSON.stringify(lifecycleConnect()));
    await vi.waitFor(() => {
      expect(controller.getStatus().state).toBe("active");
    });
  });
});
