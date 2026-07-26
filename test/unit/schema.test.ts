import { describe, expect, it } from "vitest";
import { ConfigSchema } from "../../src/config/schema.ts";

function baseConfig(): Record<string, unknown> {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: {
      url: "ws://127.0.0.1:3001",
      accessTokenEnv: "QQ_MONITOR_ONEBOT_TOKEN",
    },
    capture: {
      groups: { whitelist: ["123456789"] },
      friends: { mode: "all", whitelist: [] },
    },
    storage: {},
    summary: { enabled: false },
  };
}

function issuePaths(config: unknown): string[] {
  const result = ConfigSchema.safeParse(config);
  if (result.success) return [];
  return result.error.issues.flatMap((issue) =>
    issue.code === "unrecognized_keys"
      ? issue.keys.map((key) => [...issue.path, key].map(String).join("."))
      : [issue.path.map(String).join(".")],
  );
}

describe("ConfigSchema", () => {
  it("fills documented defaults on a minimal config", () => {
    const parsed = ConfigSchema.parse(baseConfig());
    expect(parsed.bridge.provider).toBe("llonebot");
    expect(parsed.bridge.protocol).toBe("onebot11");
    expect(parsed.bridge.mode).toBe("forward-websocket");
    expect(parsed.bridge.heartbeatTimeoutMs).toBe(130000);
    expect(parsed.messages).toEqual({
      retainRecalledContent: true,
      exposeRecalledContentToAgent: false,
    });
    expect(parsed.storage.messageRetentionDays).toBe(30);
    expect(parsed.storage.summaryRetentionDays).toBe(180);
    expect(parsed.agent.consumerId).toBe("taki-main");
    expect(parsed.logging).toEqual({ level: "info", includeMessageContent: false });
  });

  it("rejects unknown root and nested fields, including a legacy recovery block", () => {
    expect(issuePaths({ ...baseConfig(), recovery: { enabled: true } })).toContain("recovery");
    const config = baseConfig();
    (config["bridge"] as Record<string, unknown>)["reconnect"] = true;
    expect(issuePaths(config)).toContain("bridge.reconnect");
  });

  it("rejects unsupported configVersion", () => {
    expect(issuePaths({ ...baseConfig(), configVersion: 2 })).toContain("configVersion");
  });

  it("requires digit-string QQ identifiers", () => {
    const config = baseConfig();
    (config["account"] as Record<string, unknown>)["targetSelfUin"] = "abc123";
    expect(issuePaths(config)).toContain("account.targetSelfUin");

    const withBadGroup = baseConfig();
    (withBadGroup["capture"] as { groups: { whitelist: string[] } }).groups.whitelist = ["12x"];
    expect(issuePaths(withBadGroup)).toContain("capture.groups.whitelist.0");
  });

  it("requires friends.whitelist to be present", () => {
    const config = baseConfig();
    config["capture"] = { groups: { whitelist: [] }, friends: { mode: "all" } };
    expect(issuePaths(config)).toContain("capture.friends.whitelist");
  });

  it("deduplicates whitelists", () => {
    const config = baseConfig();
    (config["capture"] as { groups: { whitelist: string[] } }).groups.whitelist = [
      "111",
      "111",
      "222",
    ];
    const parsed = ConfigSchema.parse(config);
    expect(parsed.capture.groups.whitelist).toEqual(["111", "222"]);
  });

  it("rejects http URLs for the bridge", () => {
    const config = baseConfig();
    (config["bridge"] as Record<string, unknown>)["url"] = "http://127.0.0.1:3001";
    expect(issuePaths(config)).toContain("bridge.url");
  });

  it("enforces numeric ranges", () => {
    const config = baseConfig();
    (config["bridge"] as Record<string, unknown>)["connectTimeoutMs"] = 500;
    expect(issuePaths(config)).toContain("bridge.connectTimeoutMs");

    const withBadThreshold = baseConfig();
    withBadThreshold["summary"] = {
      enabled: false,
      threshold: 0,
    };
    expect(issuePaths(withBadThreshold)).toContain("summary.threshold");
  });

  it("rejects exposing recalled content while not retaining it", () => {
    const config = baseConfig();
    config["messages"] = { retainRecalledContent: false, exposeRecalledContentToAgent: true };
    expect(issuePaths(config)).toContain("messages.exposeRecalledContentToAgent");
  });

  it("requires a producer when summary is enabled", () => {
    const config = baseConfig();
    config["summary"] = { enabled: true };
    expect(issuePaths(config)).toContain("summary.producer");
  });

  it("requires summary.groupWhitelist to be a subset of capture groups", () => {
    const config = baseConfig();
    config["summary"] = {
      enabled: true,
      groupWhitelist: ["999999"],
      producer: { type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" },
    };
    expect(issuePaths(config)).toContain("summary.groupWhitelist");
  });

  it("validates dimension keys and descriptions", () => {
    const config = baseConfig();
    config["summary"] = {
      enabled: false,
      dimensions: {
        BadKey: { description: "x" },
        summaryText: { description: "reserved" },
        good: { description: "   " },
      },
    };
    const paths = issuePaths(config);
    expect(paths).toContain("summary.dimensions.BadKey");
    expect(paths).toContain("summary.dimensions.summaryText");
    expect(paths).toContain("summary.dimensions.good.description");
  });

  it("rejects more than 32 dimensions", () => {
    const dimensions: Record<string, { description: string }> = {};
    for (let index = 0; index < 33; index += 1) {
      dimensions[`dim${String(index)}`] = { description: "d" };
    }
    const config = baseConfig();
    config["summary"] = { enabled: false, dimensions };
    expect(issuePaths(config)).toContain("summary.dimensions");
  });
});
