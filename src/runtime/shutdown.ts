/**
 * Graceful-shutdown wiring, extracted for direct unit testing because Windows
 * cannot deliver real SIGTERM to a child process. stdin EOF is the primary
 * host-driven termination path on Windows: the SDK's StdioServerTransport does
 * not listen for it, so we must.
 */
import process from "node:process";
import type { Logger } from "../logging/logger.ts";

export interface Closable {
  close(): Promise<void>;
}

interface ListenerSource {
  on(event: string, listener: () => void): unknown;
  off(event: string, listener: () => void): unknown;
}

export function createShutdown(
  target: Closable,
  log: Logger,
  exit: (code: number) => void = (code) => process.exit(code),
): (reason: string) => void {
  let started = false;
  return (reason) => {
    if (started) return;
    started = true;
    log.info({ reason }, "shutting down");
    void target
      .close()
      .catch((error: unknown) => {
        log.warn({ err: error instanceof Error ? error.message : String(error) }, "close failed");
      })
      .finally(() => {
        exit(0);
      });
  };
}

export interface ShutdownTriggerOptions {
  proc?: ListenerSource;
  stdin?: ListenerSource;
}

export function installShutdownTriggers(
  shutdown: (reason: string) => void,
  options: ShutdownTriggerOptions = {},
): () => void {
  const proc = options.proc ?? process;
  const stdin = options.stdin ?? process.stdin;

  const onSigint = (): void => shutdown("SIGINT");
  const onSigterm = (): void => shutdown("SIGTERM");
  const onSigbreak = (): void => shutdown("SIGBREAK");
  const onStdinEnd = (): void => shutdown("stdin closed");

  proc.on("SIGINT", onSigint);
  proc.on("SIGTERM", onSigterm);
  proc.on("SIGBREAK", onSigbreak);
  stdin.on("end", onStdinEnd);
  stdin.on("close", onStdinEnd);

  return () => {
    proc.off("SIGINT", onSigint);
    proc.off("SIGTERM", onSigterm);
    proc.off("SIGBREAK", onSigbreak);
    stdin.off("end", onStdinEnd);
    stdin.off("close", onStdinEnd);
  };
}
