/**
 * Structured JSON-line logger. MCP owns stdout for protocol frames, so logs go to
 * stderr only. Field values whose keys look secret-bearing are redacted as defense
 * in depth; config never carries secret values, only env var names.
 */
import type { Writable } from "node:stream";
import type { LogLevel } from "../config/schema.ts";

const LEVEL_ORDER: Record<LogLevel, number> = { debug: 0, info: 1, warn: 2, error: 3 };

const SECRET_KEY_PATTERN = /token|secret|password|api[-_]?key|credential/i;

export interface Logger {
  debug(fields: Record<string, unknown>, message: string): void;
  info(fields: Record<string, unknown>, message: string): void;
  warn(fields: Record<string, unknown>, message: string): void;
  error(fields: Record<string, unknown>, message: string): void;
  child(bindings: Record<string, unknown>): Logger;
}

function redact(fields: Record<string, unknown>): Record<string, unknown> {
  const safe: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(fields)) {
    if (SECRET_KEY_PATTERN.test(key) && !key.endsWith("Env")) {
      safe[key] = "[redacted]";
    } else {
      safe[key] = value;
    }
  }
  return safe;
}

export function createLogger(
  level: LogLevel,
  stream: Writable = process.stderr,
  bindings: Record<string, unknown> = {},
): Logger {
  const threshold = LEVEL_ORDER[level];

  const write = (entryLevel: LogLevel, fields: Record<string, unknown>, message: string): void => {
    if (LEVEL_ORDER[entryLevel] < threshold) return;
    const entry = {
      ts: Date.now(),
      level: entryLevel,
      msg: message,
      ...bindings,
      ...redact(fields),
    };
    stream.write(`${JSON.stringify(entry)}\n`);
  };

  return {
    debug: (fields, message) => write("debug", fields, message),
    info: (fields, message) => write("info", fields, message),
    warn: (fields, message) => write("warn", fields, message),
    error: (fields, message) => write("error", fields, message),
    child: (childBindings) => createLogger(level, stream, { ...bindings, ...childBindings }),
  };
}
