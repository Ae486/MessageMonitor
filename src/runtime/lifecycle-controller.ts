/**
 * Bridge lifecycle per docs/architecture.md section 4: dormant -> connecting
 * -> verifying -> active, back to dormant on any close, reconnecting on a
 * fixed interval. self_id from the first inbound event decides verification;
 * a mismatched account never reaches the ingest path (AC-02). On every
 * non-first verified connect the offline interval becomes an account-level
 * Capture Gap (ADR-0005).
 */
import { readSelfId } from "../bridge/onebot-events.ts";
import {
  openBridgeConnection,
  type BridgeConnection,
  type WebSocketFactory,
} from "../bridge/onebot-connection.ts";
import type { Logger } from "../logging/logger.ts";
import type { Storage } from "../storage/index.ts";

export type LifecycleState = "dormant" | "connecting" | "verifying" | "active";

export interface LifecycleOptions {
  targetSelfUin: string;
  url: string;
  accessToken: string;
  connectTimeoutMs: number;
  reconnectIntervalMs: number;
  heartbeatTimeoutMs: number;
}

export interface LifecycleStatus {
  state: LifecycleState;
  connectedSelfUin?: string;
  accountMismatch: boolean;
  connectedAt?: number;
  lastEventAt?: number;
}

export interface LifecycleDeps {
  storage: Storage;
  log: Logger;
  onEvent(event: unknown, now: number): void;
  webSocketFactory?: WebSocketFactory;
  now?(): number;
}

export interface LifecycleController {
  start(): void;
  getStatus(): LifecycleStatus;
  close(): Promise<void>;
}

export function createLifecycleController(
  options: LifecycleOptions,
  deps: LifecycleDeps,
): LifecycleController {
  const log = deps.log.child({ component: "lifecycle" });
  const now = deps.now ?? Date.now;

  let state: LifecycleState = "dormant";
  let connection: BridgeConnection | undefined;
  let reconnectTimer: NodeJS.Timeout | undefined;
  let stopped = false;
  let accountMismatch = false;
  let connectedSelfUin: string | undefined;
  let connectedAt: number | undefined;
  let lastEventAt: number | undefined;

  const persistLastEventAt = (): void => {
    if (lastEventAt !== undefined) {
      deps.storage.runtimeState.set("lastEventAt", lastEventAt, now());
    }
  };

  const scheduleReconnect = (): void => {
    if (stopped) return;
    reconnectTimer = setTimeout(connect, options.reconnectIntervalMs);
  };

  const onVerified = (selfUin: string): void => {
    connectedSelfUin = selfUin;
    accountMismatch = false;
    connectedAt = now();
    const runtime = deps.storage.runtimeState;

    const baseline = runtime.get<number>("monitoringBaseline");
    if (baseline === undefined) {
      runtime.set("monitoringBaseline", connectedAt, connectedAt);
      log.info({ baseline: connectedAt }, "monitoring baseline established");
    } else {
      const storedLastEventAt = runtime.get<number>("lastEventAt");
      const lastDisconnectAt = runtime.get<number>("lastDisconnectAt");
      const candidates = [storedLastEventAt, lastDisconnectAt].filter(
        (value): value is number => value !== undefined,
      );
      // lastEventAt/lastDisconnectAt are only persisted on graceful close, so
      // after a crash they describe an OLDER cycle. Clamp with evidence of
      // later successful capture (per-ingest checkpoints, last verified
      // connect) so the gap never swallows a fully captured session.
      const lowerBounds = [
        deps.storage.messages.latestCheckpointAt(),
        runtime.get<number>("lastConnectedAt"),
      ].filter((value): value is number => value !== undefined);
      const rawStart = candidates.length > 0 ? Math.min(...candidates) : baseline;
      const gapStart = Math.max(rawStart, ...lowerBounds);
      if (gapStart < connectedAt) {
        deps.storage.captureGaps.createAccountGap(
          { startedAt: gapStart, endedAt: connectedAt, reasonCode: "offline" },
          connectedAt,
        );
        log.info({ from: gapStart, to: connectedAt }, "recorded offline capture gap");
      }
    }
    runtime.set("lastConnectedAt", connectedAt, connectedAt);
    state = "active";
    log.info({ selfUin }, "capture active");
  };

  const handleEvent = (event: unknown): void => {
    const eventNow = now();
    if (state === "verifying") {
      const selfUin = readSelfId(event);
      if (selfUin === undefined) return;
      if (selfUin !== options.targetSelfUin) {
        accountMismatch = true;
        connectedSelfUin = selfUin;
        log.warn(
          { connectedSelfUin: selfUin, targetSelfUin: options.targetSelfUin },
          "connected account does not match the target; capture disabled",
        );
        connection?.close();
        return;
      }
      onVerified(selfUin);
    }
    if (state !== "active") return;
    lastEventAt = eventNow;
    deps.onEvent(event, eventNow);
  };

  const handleClose = (reason: string): void => {
    const wasActive = state === "active";
    connection = undefined;
    if (wasActive) {
      persistLastEventAt();
      deps.storage.runtimeState.set("lastDisconnectAt", now(), now());
    }
    if (stopped) return;
    state = "dormant";
    connectedSelfUin = undefined;
    connectedAt = undefined;
    log.info({ reason, wasActive }, "bridge connection closed");
    scheduleReconnect();
  };

  function connect(): void {
    if (stopped || connection !== undefined) return;
    state = "connecting";
    const callbacks = {
      onOpen: () => {
        if (state === "connecting") state = "verifying";
      },
      onEvent: handleEvent,
      onClose: handleClose,
    };
    connection =
      deps.webSocketFactory !== undefined
        ? openBridgeConnection(connectionOptions(), callbacks, deps.webSocketFactory)
        : openBridgeConnection(connectionOptions(), callbacks);
  }

  function connectionOptions() {
    return {
      url: options.url,
      accessToken: options.accessToken,
      connectTimeoutMs: options.connectTimeoutMs,
      heartbeatTimeoutMs: options.heartbeatTimeoutMs,
    };
  }

  return {
    start() {
      connect();
    },
    getStatus() {
      return {
        state,
        ...(connectedSelfUin !== undefined ? { connectedSelfUin } : {}),
        accountMismatch,
        ...(connectedAt !== undefined ? { connectedAt } : {}),
        ...(lastEventAt !== undefined ? { lastEventAt } : {}),
      };
    },
    close() {
      stopped = true;
      if (reconnectTimer !== undefined) clearTimeout(reconnectTimer);
      persistLastEventAt();
      connection?.close();
      connection = undefined;
      state = "dormant";
      return Promise.resolve();
    },
  };
}
