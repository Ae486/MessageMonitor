/**
 * Config loading per docs/configuration.md: path priority --config > QQ_MONITOR_CONFIG >
 * ${LOCALAPPDATA}/QQMessageMonitor/config.json; ${NAME} expansion only in path fields;
 * env-var presence checks that never echo secret values; database dir writability probe.
 * An absent `summary` block means summarization is disabled.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { ConfigSchema, type AppConfig } from "./schema.ts";

export class ConfigError extends Error {
  readonly issues: readonly string[];

  constructor(issues: readonly string[]) {
    super(`invalid configuration:\n${issues.map((issue) => `  - ${issue}`).join("\n")}`);
    this.name = "ConfigError";
    this.issues = issues;
  }
}

export interface LoadOptions {
  argv?: readonly string[];
  env?: NodeJS.ProcessEnv;
}

export function resolveConfigPath(
  argv: readonly string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): string {
  const flagIndex = argv.indexOf("--config");
  if (flagIndex !== -1) {
    const value = argv[flagIndex + 1];
    if (value === undefined || value.startsWith("--")) {
      throw new ConfigError(["--config requires a file path argument"]);
    }
    return value;
  }
  const fromEnv = env["QQ_MONITOR_CONFIG"];
  if (fromEnv !== undefined && fromEnv.trim() !== "") {
    return fromEnv;
  }
  const localAppData = env["LOCALAPPDATA"];
  if (localAppData === undefined || localAppData.trim() === "") {
    throw new ConfigError([
      "cannot resolve default config path: LOCALAPPDATA is not set; pass --config or QQ_MONITOR_CONFIG",
    ]);
  }
  return join(localAppData, "QQMessageMonitor", "config.json");
}

const ENV_VAR_PATTERN = /\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g;

function expandPathField(
  value: string,
  fieldPath: string,
  env: NodeJS.ProcessEnv,
  issues: string[],
  secretEnvNames: ReadonlySet<string>,
): string {
  return value.replaceAll(ENV_VAR_PATTERN, (whole, name: string) => {
    if (secretEnvNames.has(name)) {
      issues.push(
        `${fieldPath}: must not reference secret-bearing environment variable "${name}"`,
      );
      return whole;
    }
    const resolved = env[name];
    if (resolved === undefined || resolved.trim() === "") {
      issues.push(`${fieldPath}: environment variable "${name}" is not set`);
      return whole;
    }
    return resolved;
  });
}

function checkSecretEnv(
  envName: string,
  fieldPath: string,
  env: NodeJS.ProcessEnv,
  issues: string[],
): void {
  const value = env[envName];
  if (value === undefined || value.trim() === "") {
    issues.push(`${fieldPath}: environment variable "${envName}" is not set or empty`);
  }
}

function checkDatabaseDirectory(databasePath: string, issues: string[]): void {
  const directory = dirname(databasePath);
  try {
    mkdirSync(directory, { recursive: true });
    const probe = join(directory, `.write-probe-${process.pid}`);
    writeFileSync(probe, "");
    rmSync(probe, { force: true });
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    issues.push(`storage.databasePath: database directory is not writable (${reason})`);
  }
}

export function loadConfig(options: LoadOptions = {}): AppConfig {
  const argv = options.argv ?? process.argv.slice(2);
  const env = options.env ?? process.env;
  const configPath = resolveConfigPath(argv, env);

  let rawText: string;
  try {
    rawText = readFileSync(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ConfigError([`config file not found: ${configPath}`]);
    }
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([`config file is not readable: ${reason}`]);
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawText);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new ConfigError([`config file is not valid JSON: ${reason}`]);
  }

  if (typeof parsedJson === "object" && parsedJson !== null && !("summary" in parsedJson)) {
    (parsedJson as Record<string, unknown>)["summary"] = { enabled: false };
  }

  const result = ConfigSchema.safeParse(parsedJson);
  if (!result.success) {
    throw new ConfigError(
      result.error.issues.flatMap((issue) => {
        if (issue.code === "unrecognized_keys") {
          return issue.keys.map(
            (key) => `${[...issue.path, key].map(String).join(".")}: unknown field`,
          );
        }
        const path = issue.path.length > 0 ? issue.path.map(String).join(".") : "(root)";
        return [`${path}: ${issue.message}`];
      }),
    );
  }

  const config = result.data;
  const issues: string[] = [];

  const apiKeyEnv = config.summary.producer?.apiKeyEnv;
  const secretEnvNames = new Set<string>([config.bridge.accessTokenEnv]);
  if (apiKeyEnv !== undefined) secretEnvNames.add(apiKeyEnv);

  const databasePath = expandPathField(
    config.storage.databasePath,
    "storage.databasePath",
    env,
    issues,
    secretEnvNames,
  );

  checkSecretEnv(config.bridge.accessTokenEnv, "bridge.accessTokenEnv", env, issues);
  if (apiKeyEnv !== undefined) {
    checkSecretEnv(apiKeyEnv, "summary.producer.apiKeyEnv", env, issues);
  }

  if (issues.length === 0) {
    checkDatabaseDirectory(databasePath, issues);
  }

  if (issues.length > 0) {
    throw new ConfigError(issues);
  }

  return {
    ...config,
    storage: { ...config.storage, databasePath },
  };
}
