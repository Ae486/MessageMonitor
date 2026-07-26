import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

const ENTRY = join(process.cwd(), "src", "main.ts");

const tempDirs: string[] = [];
const children: ChildProcess[] = [];

afterEach(() => {
  for (const child of children.splice(0)) {
    if (child.exitCode === null) child.kill();
  }
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function writeTempConfig(config: unknown): string {
  const dir = mkdtempSync(join(tmpdir(), "qqmon-int-"));
  tempDirs.push(dir);
  const filePath = join(dir, "config.json");
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}

function validConfig(databaseDir: string): Record<string, unknown> {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: { url: "ws://127.0.0.1:3001", accessTokenEnv: "TEST_ONEBOT_TOKEN" },
    capture: {
      groups: { whitelist: [] },
      friends: { mode: "all", whitelist: [] },
    },
    storage: { databasePath: join(databaseDir, "data", "monitor.db") },
  };
}

interface RunResult {
  child: ChildProcess;
  stderrLine: (predicate: (line: string) => boolean) => Promise<string>;
  stdout: () => string;
  stderr: () => string;
  exited: Promise<number | null>;
}

function run(configPath: string, env: Record<string, string>): RunResult {
  const child = spawn(process.execPath, [ENTRY, "--config", configPath], {
    env: { ...process.env, ...env },
    stdio: ["pipe", "pipe", "pipe"],
  });
  children.push(child);

  let stdoutData = "";
  let stderrData = "";
  const lineWaiters: { predicate: (line: string) => boolean; resolve: (line: string) => void }[] =
    [];

  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutData += chunk.toString();
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrData += chunk.toString();
    for (const line of chunk.toString().split("\n")) {
      for (const waiter of lineWaiters.splice(0)) {
        if (waiter.predicate(line)) waiter.resolve(line);
        else lineWaiters.push(waiter);
      }
    }
  });

  const exited = new Promise<number | null>((resolve) => {
    child.on("exit", (code) => resolve(code));
  });

  return {
    child,
    stdout: () => stdoutData,
    stderr: () => stderrData,
    exited,
    stderrLine: (predicate) =>
      new Promise<string>((resolve, reject) => {
        const existing = stderrData.split("\n").find(predicate);
        if (existing !== undefined) {
          resolve(existing);
          return;
        }
        lineWaiters.push({ predicate, resolve });
        setTimeout(() => reject(new Error(`timed out waiting for stderr line; got:\n${stderrData}`)), 15000);
      }),
  };
}

describe("stdio lifecycle", () => {
  it("starts with a valid config, keeps stdout clean, and shuts down gracefully on stdin close", async () => {
    const configPath = writeTempConfig(validConfig(tmpdir()));
    const result = run(configPath, { TEST_ONEBOT_TOKEN: "integration-token" });

    await result.stderrLine((line) => line.includes("qq-message-monitor started"));
    expect(result.stdout()).toBe("");

    result.child.stdin?.end();
    await result.stderrLine((line) => line.includes("shutting down"));
    const code = await result.exited;
    expect(code).toBe(0);
    expect(result.stdout()).toBe("");
    expect(result.stderr()).not.toContain("integration-token");
  });

  it("exits 1 on invalid config with field paths on stderr and no secret values", async () => {
    const configPath = writeTempConfig({
      configVersion: 1,
      account: { targetSelfUin: "not-digits" },
      bridge: { url: "ws://127.0.0.1:3001", accessTokenEnv: "TEST_ONEBOT_TOKEN" },
      capture: { groups: { whitelist: [] }, friends: { mode: "all", whitelist: [] } },
      storage: { databasePath: join(tmpdir(), "qqmon-int-db", "monitor.db") },
      recovery: { enabled: true },
    });
    const result = run(configPath, { TEST_ONEBOT_TOKEN: "super-sekret-token-value" });

    const code = await result.exited;
    expect(code).toBe(1);
    const stderr = result.stderr();
    expect(stderr).toContain("configuration is invalid");
    expect(stderr).toContain("account.targetSelfUin");
    expect(stderr).toContain("recovery");
    expect(stderr).not.toContain("super-sekret-token-value");
  });
});
