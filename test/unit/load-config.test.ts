import { mkdtempSync, rmSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ConfigError, loadConfig, resolveConfigPath } from "../../src/config/load-config.ts";

const tempDirs: string[] = [];

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), "qqmon-test-"));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true });
  }
});

function writeConfig(dir: string, config: unknown): string {
  const filePath = join(dir, "config.json");
  writeFileSync(filePath, JSON.stringify(config));
  return filePath;
}

function validConfig(dir: string): Record<string, unknown> {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: { url: "ws://127.0.0.1:3001", accessTokenEnv: "TEST_ONEBOT_TOKEN" },
    capture: {
      groups: { whitelist: ["123456789"] },
      friends: { mode: "all", whitelist: [] },
    },
    storage: { databasePath: join(dir, "data", "monitor.db") },
  };
}

const baseEnv: NodeJS.ProcessEnv = { TEST_ONEBOT_TOKEN: "token-value-sekret" };

function expectConfigError(fn: () => unknown): ConfigError {
  try {
    fn();
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return error as ConfigError;
  }
  throw new Error("expected ConfigError");
}

describe("resolveConfigPath", () => {
  it("prefers --config over the environment variable and default", () => {
    const env = { QQ_MONITOR_CONFIG: "/env/config.json", LOCALAPPDATA: "/appdata" };
    expect(resolveConfigPath(["--config", "cli.json"], env)).toBe("cli.json");
    expect(resolveConfigPath([], env)).toBe("/env/config.json");
    expect(resolveConfigPath([], { LOCALAPPDATA: "/appdata" })).toBe(
      join("/appdata", "QQMessageMonitor", "config.json"),
    );
  });

  it("fails when --config has no value", () => {
    const error = expectConfigError(() => resolveConfigPath(["--config"], {}));
    expect(error.issues[0]).toContain("--config");
  });

  it("fails when the default path needs LOCALAPPDATA and it is missing", () => {
    const error = expectConfigError(() => resolveConfigPath([], {}));
    expect(error.issues[0]).toContain("LOCALAPPDATA");
  });
});

describe("loadConfig", () => {
  it("loads a valid config and expands nothing when no variables are used", () => {
    const dir = makeTempDir();
    const filePath = writeConfig(dir, validConfig(dir));
    const config = loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } });
    expect(config.account.targetSelfUin).toBe("10001");
    expect(config.storage.databasePath).toBe(join(dir, "data", "monitor.db"));
    expect(existsSync(join(dir, "data"))).toBe(true);
  });

  it("treats an absent summary block as disabled", () => {
    const dir = makeTempDir();
    const filePath = writeConfig(dir, validConfig(dir));
    const config = loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } });
    expect(config.summary.enabled).toBe(false);
    expect(config.summary.producer).toBeUndefined();
  });

  it("reports a missing config file with its path", () => {
    const dir = makeTempDir();
    const missing = join(dir, "nope.json");
    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", missing], env: { ...baseEnv } }),
    );
    expect(error.issues[0]).toContain(missing);
  });

  it("reports invalid JSON", () => {
    const dir = makeTempDir();
    const filePath = join(dir, "config.json");
    writeFileSync(filePath, "{ not json");
    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } }),
    );
    expect(error.issues[0]).toContain("not valid JSON");
  });

  it("reports schema issues with field paths", () => {
    const dir = makeTempDir();
    const config = validConfig(dir);
    (config["account"] as Record<string, unknown>)["targetSelfUin"] = "not-digits";
    const filePath = writeConfig(dir, config);
    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } }),
    );
    expect(error.issues.some((issue) => issue.startsWith("account.targetSelfUin:"))).toBe(true);
  });

  it("fails when the access token env var is missing, naming the variable", () => {
    const dir = makeTempDir();
    const filePath = writeConfig(dir, validConfig(dir));
    const error = expectConfigError(() => loadConfig({ argv: ["--config", filePath], env: {} }));
    expect(error.issues.join("\n")).toContain("TEST_ONEBOT_TOKEN");
  });

  it("never echoes secret values present in the environment on validation failure", () => {
    const dir = makeTempDir();
    const config = validConfig(dir);
    (config["account"] as Record<string, unknown>)["targetSelfUin"] = "not-digits";
    const filePath = writeConfig(dir, config);
    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } }),
    );
    const combined = error.issues.join("\n") + error.message;
    expect(combined).toContain("account.targetSelfUin");
    expect(combined).not.toContain("token-value-sekret");
  });

  it("rejects databasePath referencing a secret env var without echoing its value", () => {
    const dir = makeTempDir();
    const config = validConfig(dir);
    (config["storage"] as Record<string, unknown>)["databasePath"] =
      "${TEST_ONEBOT_TOKEN}/monitor.db";
    const filePath = writeConfig(dir, config);
    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } }),
    );
    const combined = error.issues.join("\n") + error.message;
    expect(combined).toContain("must not reference secret-bearing environment variable");
    expect(combined).toContain("TEST_ONEBOT_TOKEN");
    expect(combined).not.toContain("token-value-sekret");
  });

  it("checks the producer api key env whenever it is configured, even with summary disabled", () => {
    const dir = makeTempDir();
    const producer = {
      type: "openai-compatible",
      baseUrl: "https://api.example.com/v1",
      model: "m",
      apiKeyEnv: "TEST_LLM_KEY",
    };

    const enabledConfig = validConfig(dir);
    enabledConfig["summary"] = { enabled: true, groupWhitelist: ["123456789"], producer };
    const enabledPath = writeConfig(dir, enabledConfig);
    const enabledError = expectConfigError(() =>
      loadConfig({ argv: ["--config", enabledPath], env: { ...baseEnv } }),
    );
    expect(enabledError.issues.some((issue) => issue.includes("TEST_LLM_KEY"))).toBe(true);

    const disabledDir = makeTempDir();
    const disabledConfig = validConfig(disabledDir);
    disabledConfig["summary"] = { enabled: false, producer };
    const disabledPath = writeConfig(disabledDir, disabledConfig);
    const disabledError = expectConfigError(() =>
      loadConfig({ argv: ["--config", disabledPath], env: { ...baseEnv } }),
    );
    expect(disabledError.issues.some((issue) => issue.includes("TEST_LLM_KEY"))).toBe(true);

    const ok = loadConfig({
      argv: ["--config", enabledPath],
      env: { ...baseEnv, TEST_LLM_KEY: "llm-key" },
    });
    expect(ok.summary.enabled).toBe(true);
  });

  it("expands ${NAME} in databasePath and fails on undefined variables", () => {
    const dir = makeTempDir();
    const config = validConfig(dir);
    (config["storage"] as Record<string, unknown>)["databasePath"] =
      "${QQMON_TEST_DATA}/monitor.db";
    const filePath = writeConfig(dir, config);

    const expanded = loadConfig({
      argv: ["--config", filePath],
      env: { ...baseEnv, QQMON_TEST_DATA: join(dir, "custom") },
    });
    expect(expanded.storage.databasePath).toBe(join(dir, "custom") + "/monitor.db");

    const error = expectConfigError(() =>
      loadConfig({ argv: ["--config", filePath], env: { ...baseEnv } }),
    );
    expect(error.issues.some((issue) => issue.includes("QQMON_TEST_DATA"))).toBe(true);
  });
});
