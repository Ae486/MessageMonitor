/**
 * One forward-WebSocket connection to the bridge. Auth goes in the
 * Authorization: Bearer header (LLOneBot's primary form). Any inbound frame
 * counts as heartbeat activity; a silent connection past the deadline is
 * treated as half-open and terminated (docs/architecture.md 4.3).
 */
import WebSocket from "ws";

export interface BridgeConnectionOptions {
  url: string;
  accessToken: string;
  connectTimeoutMs: number;
  heartbeatTimeoutMs: number;
}

export interface BridgeConnectionCallbacks {
  onOpen(): void;
  onEvent(event: unknown): void;
  /** Fired exactly once, for every termination path. */
  onClose(reason: string): void;
}

export interface BridgeConnection {
  close(): void;
}

export type WebSocketFactory = (url: string, headers: Record<string, string>) => WebSocket;

const defaultFactory: WebSocketFactory = (url, headers) => new WebSocket(url, { headers });

export function openBridgeConnection(
  options: BridgeConnectionOptions,
  callbacks: BridgeConnectionCallbacks,
  factory: WebSocketFactory = defaultFactory,
): BridgeConnection {
  const socket = factory(options.url, {
    Authorization: `Bearer ${options.accessToken}`,
  });

  let closed = false;
  let heartbeatTimer: NodeJS.Timeout | undefined;

  const finish = (reason: string): void => {
    if (closed) return;
    closed = true;
    clearTimeout(connectTimer);
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    socket.terminate();
    callbacks.onClose(reason);
  };

  const connectTimer = setTimeout(() => {
    finish("connect timeout");
  }, options.connectTimeoutMs);

  const resetHeartbeat = (): void => {
    if (heartbeatTimer !== undefined) clearTimeout(heartbeatTimer);
    heartbeatTimer = setTimeout(() => {
      finish("heartbeat timeout");
    }, options.heartbeatTimeoutMs);
  };

  socket.on("open", () => {
    if (closed) return;
    clearTimeout(connectTimer);
    resetHeartbeat();
    callbacks.onOpen();
  });

  socket.on("message", (data) => {
    if (closed) return;
    resetHeartbeat();
    let event: unknown;
    try {
      event = JSON.parse(String(data));
    } catch {
      return;
    }
    callbacks.onEvent(event);
  });

  socket.on("close", () => {
    finish("socket closed");
  });
  socket.on("error", (error) => {
    finish(`socket error: ${error.message}`);
  });

  return {
    close() {
      finish("closed locally");
    },
  };
}
