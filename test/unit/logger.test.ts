import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import { createLogger } from "../../src/logging/logger.ts";

function collectingStream(): { stream: Writable; lines: () => Record<string, unknown>[] } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      chunks.push(chunk.toString());
      callback();
    },
  });
  return {
    stream,
    lines: () =>
      chunks
        .join("")
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => JSON.parse(line) as Record<string, unknown>),
  };
}

describe("createLogger", () => {
  it("writes JSON lines with level and message", () => {
    const { stream, lines } = collectingStream();
    const log = createLogger("info", stream);
    log.info({ a: 1 }, "hello");
    const [entry] = lines();
    expect(entry).toMatchObject({ level: "info", msg: "hello", a: 1 });
    expect(typeof entry?.["ts"]).toBe("number");
  });

  it("filters below the configured level", () => {
    const { stream, lines } = collectingStream();
    const log = createLogger("warn", stream);
    log.debug({}, "d");
    log.info({}, "i");
    log.warn({}, "w");
    expect(lines().map((entry) => entry["level"])).toEqual(["warn"]);
  });

  it("redacts secret-looking field values but keeps *Env names", () => {
    const { stream, lines } = collectingStream();
    const log = createLogger("info", stream);
    log.info(
      { accessToken: "raw-secret", apiKey: "raw-key", accessTokenEnv: "MY_TOKEN_ENV" },
      "boot",
    );
    const [entry] = lines();
    expect(entry?.["accessToken"]).toBe("[redacted]");
    expect(entry?.["apiKey"]).toBe("[redacted]");
    expect(entry?.["accessTokenEnv"]).toBe("MY_TOKEN_ENV");
  });

  it("merges child bindings", () => {
    const { stream, lines } = collectingStream();
    const log = createLogger("info", stream).child({ component: "config" });
    log.info({}, "loaded");
    expect(lines()[0]?.["component"]).toBe("config");
  });
});
