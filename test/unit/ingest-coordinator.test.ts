import { Writable } from "node:stream";
import { describe, expect, it } from "vitest";
import type { AppConfig } from "../../src/config/schema.ts";
import { createIngestCoordinator } from "../../src/ingest/ingest-coordinator.ts";
import { createLogger } from "../../src/logging/logger.ts";
import {
  friendMessage,
  friendRecall,
  groupMessage,
  groupRecall,
  heartbeat,
  ownerSentFriendMessage,
} from "../fixtures/onebot-events.ts";
import { countRows, openTestDb, type TestDb } from "./storage/helpers.ts";

const silentLog = createLogger("error", new Writable({ write: (_c, _e, cb) => cb() }));

function makeConfig(overrides: Partial<AppConfig["capture"]> = {}, retain = true): AppConfig {
  return {
    configVersion: 1,
    account: { targetSelfUin: "10001" },
    bridge: {
      provider: "llonebot",
      protocol: "onebot11",
      mode: "forward-websocket",
      url: "ws://127.0.0.1:3001",
      accessTokenEnv: "T",
      connectTimeoutMs: 5000,
      reconnectIntervalMs: 5000,
      heartbeatTimeoutMs: 130000,
      requireSelfMessageReporting: true,
    },
    capture: {
      groups: { whitelist: ["123456789"] },
      friends: { mode: "all", whitelist: [] },
      ...overrides,
    },
    messages: { retainRecalledContent: retain, exposeRecalledContentToAgent: false },
    storage: {
      databasePath: ":memory:",
      messageRetentionDays: 30,
      summaryRetentionDays: 180,
      cleanupIntervalHours: 24,
    },
    summary: {
      enabled: true,
      groupWhitelist: ["123456789"],
      threshold: 30,
      maxConcurrentTasks: 1,
      maxInputTokensPerCall: 12000,
      maxRetries: 3,
      retryBaseDelayMs: 5000,
      requestTimeoutMs: 60000,
      additionalPrompt: "",
      producer: { type: "openai-compatible", baseUrl: "https://api.example.com/v1", model: "m" },
      dimensions: {},
    },
    agent: { consumerId: "taki-main" },
    logging: { level: "error", includeMessageContent: false },
  };
}

function coordinator(t: TestDb, config = makeConfig()) {
  return createIngestCoordinator(config, t.storage, silentLog);
}

describe("ingest coordinator", () => {
  it("captures whitelisted group messages and marks summary enablement (AC-04)", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(groupMessage(), 1000);
      ingest.handleEvent(groupMessage({ group_id: 555, message_id: 1 }), 2000);

      expect(countRows(t.db, "messages")).toBe(1);
      const conversation = t.db.raw
        .prepare("SELECT type, source_id, summary_enabled FROM conversations")
        .get() as { type: string; source_id: string; summary_enabled: number };
      expect(conversation).toEqual({ type: "group", source_id: "123456789", summary_enabled: 1 });
    } finally {
      t.dispose();
    }
  });

  it("captures any friend in all mode and only whitelisted friends in whitelist mode (AC-05)", () => {
    const all = openTestDb();
    try {
      coordinator(all).handleEvent(friendMessage(), 1000);
      expect(countRows(all.db, "messages")).toBe(1);
    } finally {
      all.dispose();
    }

    const whitelisted = openTestDb();
    try {
      const config = makeConfig({ friends: { mode: "whitelist", whitelist: ["77777"] } });
      const ingest = coordinator(whitelisted, config);
      ingest.handleEvent(friendMessage(), 1000);
      expect(countRows(whitelisted.db, "messages")).toBe(0);
      ingest.handleEvent(friendMessage({ user_id: 77777, sender: { user_id: 77777 } }), 2000);
      expect(countRows(whitelisted.db, "messages")).toBe(1);
    } finally {
      whitelisted.dispose();
    }
  });

  it("stores owner messages with isOwner=true (AC-06)", () => {
    const t = openTestDb();
    try {
      coordinator(t).handleEvent(ownerSentFriendMessage(), 1000);
      const row = t.db.raw
        .prepare("SELECT is_owner, direction FROM messages")
        .get() as { is_owner: number; direction: string };
      expect(row).toEqual({ is_owner: 1, direction: "out" });
    } finally {
      t.dispose();
    }
  });

  it("absorbs duplicate deliveries (AC-07) and ignores meta events", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(heartbeat(), 500);
      ingest.handleEvent(groupMessage(), 1000);
      ingest.handleEvent(groupMessage(), 2000);
      expect(countRows(t.db, "messages")).toBe(1);
      expect(countRows(t.db, "feed_events")).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("marks recalls, keeps content when retaining, and emits a recall feed event", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(groupMessage(), 1000);
      ingest.handleEvent(groupRecall(), 2000);

      const row = t.db.raw
        .prepare("SELECT recalled_at, recall_operator_uin, projection FROM messages")
        .get() as { recalled_at: number; recall_operator_uin: string; projection: string };
      expect(row.recalled_at).toBe(2000);
      expect(row.recall_operator_uin).toBe("20002");
      expect(row.projection).toBe("大家周六测试");

      const kinds = t.db.raw
        .prepare("SELECT kind FROM feed_events ORDER BY id")
        .all() as unknown as { kind: string }[];
      expect(kinds).toEqual([{ kind: "message" }, { kind: "recall" }]);

      // Recall of an unknown message and a duplicate recall are both no-ops.
      ingest.handleEvent(groupRecall({ message_id: 424242 }), 3000);
      ingest.handleEvent(groupRecall(), 4000);
      expect(countRows(t.db, "feed_events")).toBe(2);
    } finally {
      t.dispose();
    }
  });

  it("clears recalled content when retainRecalledContent is false", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t, makeConfig({}, false));
      ingest.handleEvent(friendMessage(), 1000);
      ingest.handleEvent(friendRecall(), 2000);
      const row = t.db.raw
        .prepare("SELECT recalled_at, segments_json, projection FROM messages")
        .get() as { recalled_at: number; segments_json: null; projection: null };
      expect(row.recalled_at).toBe(2000);
      expect(row.segments_json).toBeNull();
      expect(row.projection).toBeNull();
    } finally {
      t.dispose();
    }
  });

  it("marks an owner self-recall in a friend chat by resolving the conversation from the message", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(ownerSentFriendMessage(), 1000);
      // LLOneBot friend_recall for a self-recall: user_id is the OWNER, no peer field.
      ingest.handleEvent(friendRecall({ user_id: 10001, message_id: 900003 }), 2000);

      const row = t.db.raw
        .prepare("SELECT recalled_at FROM messages WHERE source_message_id = '900003'")
        .get() as { recalled_at: number | null };
      expect(row.recalled_at).toBe(2000);
    } finally {
      t.dispose();
    }
  });

  it("drops group temp-session private messages (sub_type group) in friends all mode", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(friendMessage({ sub_type: "group", sender: { user_id: 20002, group_id: 555 } }), 1000);
      ingest.handleEvent(friendMessage({ sub_type: "other" }), 2000);
      expect(countRows(t.db, "messages")).toBe(0);
      ingest.handleEvent(friendMessage({ sub_type: "friend" }), 3000);
      expect(countRows(t.db, "messages")).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("skips malformed null segments without losing the message", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(
        groupMessage({
          message: [
            null,
            { type: "text", data: null },
            { type: "text", data: { text: "还在" } },
          ],
        }),
        1000,
      );
      const row = t.db.raw.prepare("SELECT projection FROM messages").get() as {
        projection: string;
      };
      expect(row.projection).toBe("还在");
    } finally {
      t.dispose();
    }
  });

  it("fires onSummaryCandidate only for inserted messages in summary-enabled groups (AC-08 trigger)", () => {
    const t = openTestDb();
    try {
      const pokes: number[] = [];
      const ingest = createIngestCoordinator(makeConfig(), t.storage, silentLog, {
        onSummaryCandidate: (conversationId) => pokes.push(conversationId),
      });

      ingest.handleEvent(groupMessage(), 1000);
      expect(pokes).toHaveLength(1);

      // Duplicate delivery: no second poke.
      ingest.handleEvent(groupMessage(), 2000);
      expect(pokes).toHaveLength(1);

      // Friend messages never trigger summarization.
      ingest.handleEvent(friendMessage(), 3000);
      expect(pokes).toHaveLength(1);

      // Captured group outside the summary whitelist: no poke.
      const config = makeConfig({ groups: { whitelist: ["123456789", "555"] } });
      config.summary.groupWhitelist = ["123456789"];
      const ingest2 = createIngestCoordinator(config, t.storage, silentLog, {
        onSummaryCandidate: (conversationId) => pokes.push(conversationId),
      });
      ingest2.handleEvent(groupMessage({ group_id: 555, message_id: 424242 }), 4000);
      expect(pokes).toHaveLength(1);
    } finally {
      t.dispose();
    }
  });

  it("ignores events from a different self account (AC-02 boundary)", () => {
    const t = openTestDb();
    try {
      const ingest = coordinator(t);
      ingest.handleEvent(groupMessage({ self_id: 99999 }), 1000);
      ingest.handleEvent(groupRecall({ self_id: 99999 }), 2000);
      expect(countRows(t.db, "messages")).toBe(0);
    } finally {
      t.dispose();
    }
  });
});
