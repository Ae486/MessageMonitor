import { EventEmitter } from "node:events";
import { Writable } from "node:stream";
import { describe, expect, it, vi } from "vitest";
import { createLogger } from "../../src/logging/logger.ts";
import { createShutdown, installShutdownTriggers } from "../../src/runtime/shutdown.ts";

function silentLogger() {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return { log: createLogger("debug", stream), output: () => chunks.join("") };
}

describe("createShutdown", () => {
  it("closes the target once and exits 0, even when invoked twice", async () => {
    const close = vi.fn().mockResolvedValue(undefined);
    const exit = vi.fn();
    const { log, output } = silentLogger();
    const shutdown = createShutdown({ close }, log, exit);

    shutdown("SIGTERM");
    shutdown("SIGINT");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(close).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenCalledTimes(1);
    expect(output()).toContain("shutting down");
    expect(output()).toContain("SIGTERM");
  });

  it("still exits 0 when close fails, logging a warning", async () => {
    const close = vi.fn().mockRejectedValue(new Error("boom"));
    const exit = vi.fn();
    const { log, output } = silentLogger();
    const shutdown = createShutdown({ close }, log, exit);

    shutdown("stdin closed");

    await vi.waitFor(() => {
      expect(exit).toHaveBeenCalledWith(0);
    });
    expect(output()).toContain("close failed");
  });
});

describe("installShutdownTriggers", () => {
  it("fires on signals and stdin end, and dispose removes the listeners", () => {
    const proc = new EventEmitter();
    const stdin = new EventEmitter();
    const shutdown = vi.fn();
    const dispose = installShutdownTriggers(shutdown, { proc, stdin });

    proc.emit("SIGTERM");
    expect(shutdown).toHaveBeenCalledWith("SIGTERM");
    proc.emit("SIGINT");
    expect(shutdown).toHaveBeenCalledWith("SIGINT");
    proc.emit("SIGBREAK");
    expect(shutdown).toHaveBeenCalledWith("SIGBREAK");
    stdin.emit("end");
    expect(shutdown).toHaveBeenCalledWith("stdin closed");

    shutdown.mockClear();
    dispose();
    proc.emit("SIGTERM");
    stdin.emit("end");
    stdin.emit("close");
    expect(shutdown).not.toHaveBeenCalled();
  });
});
