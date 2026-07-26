/**
 * Zod schema for config.json, mirroring docs/configuration.md exactly.
 * Unknown fields at any level are rejected; QQ identifiers are digit strings.
 */
import { z } from "zod";

const digitString = z.string().regex(/^\d+$/, "must be a digit-only string");

const dedupe = (list: string[]): string[] => [...new Set(list)];

const wsUrl = z
  .string()
  .min(1)
  .superRefine((value, ctx) => {
    let parsed: URL;
    try {
      parsed = new URL(value);
    } catch {
      ctx.addIssue({ code: "custom", message: "must be a valid URL" });
      return;
    }
    if (parsed.protocol !== "ws:" && parsed.protocol !== "wss:") {
      ctx.addIssue({ code: "custom", message: "must use ws:// or wss://" });
    }
  });

const AccountSchema = z.strictObject({
  targetSelfUin: digitString,
});

const BridgeSchema = z.strictObject({
  provider: z.enum(["llonebot", "napcat"]).default("llonebot"),
  protocol: z.literal("onebot11").default("onebot11"),
  mode: z.literal("forward-websocket").default("forward-websocket"),
  url: wsUrl,
  accessTokenEnv: z.string().min(1),
  connectTimeoutMs: z.number().int().min(1000).max(30000).default(5000),
  reconnectIntervalMs: z.number().int().min(1000).max(60000).default(5000),
  heartbeatTimeoutMs: z.number().int().min(1000).default(130000),
  requireSelfMessageReporting: z.boolean().default(true),
});

const CaptureSchema = z.strictObject({
  groups: z.strictObject({
    whitelist: z.array(digitString).transform(dedupe),
  }),
  friends: z.strictObject({
    mode: z.enum(["all", "whitelist"]),
    whitelist: z.array(digitString).transform(dedupe),
  }),
});

const MessagesSchema = z
  .strictObject({
    retainRecalledContent: z.boolean().default(true),
    exposeRecalledContentToAgent: z.boolean().default(false),
  })
  .default({ retainRecalledContent: true, exposeRecalledContentToAgent: false });

const StorageSchema = z.strictObject({
  databasePath: z.string().min(1).default("${LOCALAPPDATA}/QQMessageMonitor/data/monitor.db"),
  messageRetentionDays: z.number().int().min(1).max(3650).default(30),
  summaryRetentionDays: z.number().int().min(1).max(3650).default(180),
  cleanupIntervalHours: z.number().int().min(1).max(168).default(24),
});

export const RESERVED_DIMENSION_KEYS = new Set([
  "summaryText",
  "metadata",
  "sourceMessageIds",
  "ref",
  "schemaHash",
]);

const DIMENSION_KEY_PATTERN = /^[a-z][A-Za-z0-9]{0,63}$/;

const DimensionSchema = z.strictObject({
  description: z.string().trim().min(1).max(1000),
});

const DimensionsSchema = z
  .record(z.string(), DimensionSchema)
  .default({})
  .superRefine((dimensions, ctx) => {
    const keys = Object.keys(dimensions);
    if (keys.length > 32) {
      ctx.addIssue({ code: "custom", message: "at most 32 dimensions are allowed" });
    }
    for (const key of keys) {
      if (!DIMENSION_KEY_PATTERN.test(key)) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "dimension key must match ^[a-z][A-Za-z0-9]{0,63}$",
        });
      } else if (RESERVED_DIMENSION_KEYS.has(key)) {
        ctx.addIssue({ code: "custom", path: [key], message: "dimension key is reserved" });
      }
    }
  });

const ProducerSchema = z.strictObject({
  type: z.literal("openai-compatible"),
  baseUrl: z.url({ protocol: /^https?$/ }),
  model: z.string().min(1),
  apiKeyEnv: z.string().min(1).optional(),
});

const SummarySchema = z.strictObject({
  enabled: z.boolean().default(true),
  groupWhitelist: z.array(digitString).transform(dedupe).default([]),
  threshold: z.number().int().min(1).max(10000).default(30),
  maxConcurrentTasks: z.number().int().min(1).max(4).default(1),
  maxInputTokensPerCall: z.number().int().min(1000).max(100000).default(12000),
  maxRetries: z.number().int().min(0).max(10).default(3),
  retryBaseDelayMs: z.number().int().min(1000).max(600000).default(5000),
  requestTimeoutMs: z.number().int().min(5000).max(600000).default(60000),
  additionalPrompt: z.string().max(8000).default(""),
  producer: ProducerSchema.optional(),
  dimensions: DimensionsSchema,
});

const AgentSchema = z
  .strictObject({
    consumerId: z.string().min(1).default("taki-main"),
  })
  .default({ consumerId: "taki-main" });

const LoggingSchema = z
  .strictObject({
    level: z.enum(["debug", "info", "warn", "error"]).default("info"),
    includeMessageContent: z.boolean().default(false),
  })
  .default({ level: "info", includeMessageContent: false });

export const ConfigSchema = z
  .strictObject({
    configVersion: z.literal(1),
    account: AccountSchema,
    bridge: BridgeSchema,
    capture: CaptureSchema,
    messages: MessagesSchema,
    storage: StorageSchema,
    summary: SummarySchema,
    agent: AgentSchema,
    logging: LoggingSchema,
  })
  .superRefine((config, ctx) => {
    if (!config.messages.retainRecalledContent && config.messages.exposeRecalledContentToAgent) {
      ctx.addIssue({
        code: "custom",
        path: ["messages", "exposeRecalledContentToAgent"],
        message: "cannot expose recalled content when retainRecalledContent is false",
      });
    }
    if (config.summary.enabled && !config.summary.producer) {
      ctx.addIssue({
        code: "custom",
        path: ["summary", "producer"],
        message: "producer is required when summary.enabled is true",
      });
    }
    const capturedGroups = new Set(config.capture.groups.whitelist);
    const outside = config.summary.groupWhitelist.filter((id) => !capturedGroups.has(id));
    if (outside.length > 0) {
      ctx.addIssue({
        code: "custom",
        path: ["summary", "groupWhitelist"],
        message: `must be a subset of capture.groups.whitelist; not captured: ${outside.join(", ")}`,
      });
    }
  });

export type AppConfig = z.output<typeof ConfigSchema>;
export type SummaryConfig = AppConfig["summary"];
export type BridgeConfig = AppConfig["bridge"];
export type LogLevel = AppConfig["logging"]["level"];
