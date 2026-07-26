import { describe, expect, it } from "vitest";
import { countRows, groupConversation, incomingMessage, openTestDb } from "./helpers.ts";

describe("message ingest", () => {
  it("inserts a message with conversation, checkpoint and exactly one feed event", () => {
    const t = openTestDb();
    try {
      const result = t.storage.messages.ingest(groupConversation(), incomingMessage(), 1000);
      expect(result.inserted).toBe(true);

      expect(countRows(t.db, "conversations")).toBe(1);
      expect(countRows(t.db, "messages")).toBe(1);
      const event = t.db.raw
        .prepare("SELECT conversation_id, kind, message_id FROM feed_events")
        .get() as { conversation_id: number; kind: string; message_id: number };
      expect(event).toEqual({
        conversation_id: result.conversationId,
        kind: "message",
        message_id: result.messageId,
      });

      const checkpoint = t.db.raw
        .prepare("SELECT * FROM bridge_checkpoints WHERE conversation_id = ?")
        .get(result.conversationId) as {
        last_source_message_id: string;
        last_committed_message_id: number;
      };
      expect(checkpoint.last_source_message_id).toBe("src-1");
      expect(checkpoint.last_committed_message_id).toBe(result.messageId);
    } finally {
      t.dispose();
    }
  });

  it("is idempotent for a duplicated source message", () => {
    const t = openTestDb();
    try {
      const first = t.storage.messages.ingest(groupConversation(), incomingMessage(), 1000);
      const second = t.storage.messages.ingest(groupConversation(), incomingMessage(), 2000);

      expect(first.inserted).toBe(true);
      expect(second.inserted).toBe(false);
      expect(second.messageId).toBe(first.messageId);
      expect(countRows(t.db, "messages")).toBe(1);
      expect(countRows(t.db, "feed_events")).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("keeps distinct messages distinct and orders feed events globally", () => {
    const t = openTestDb();
    try {
      t.storage.messages.ingest(groupConversation(), incomingMessage(), 1000);
      t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "src-2", sourceTimestamp: 1_700_000_001_000 }),
        2000,
      );
      t.storage.messages.ingest(
        { ...groupConversation("999"), type: "friend", sourceId: "30003", summaryEnabled: false },
        incomingMessage({ sourceMessageId: "src-1" }),
        3000,
      );

      expect(countRows(t.db, "messages")).toBe(3);
      expect(countRows(t.db, "conversations")).toBe(2);
      const events = t.db.raw
        .prepare("SELECT id, kind FROM feed_events ORDER BY id")
        .all() as unknown as { id: number; kind: string }[];
      expect(events).toHaveLength(3);
      expect(events.every((event) => event.kind === "message")).toBe(true);
    } finally {
      t.dispose();
    }
  });

  it("does not regress the checkpoint on an out-of-order duplicate", () => {
    const t = openTestDb();
    try {
      t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "new", sourceTimestamp: 2_000 }),
        1000,
      );
      t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "old", sourceTimestamp: 1_000 }),
        2000,
      );
      const checkpoint = t.db.raw
        .prepare("SELECT last_source_message_id, last_source_timestamp FROM bridge_checkpoints")
        .get() as { last_source_message_id: string; last_source_timestamp: number };
      expect(checkpoint.last_source_message_id).toBe("new");
      expect(checkpoint.last_source_timestamp).toBe(2000);
    } finally {
      t.dispose();
    }
  });

  it("does not regress the checkpoint on a duplicate with a tied source timestamp", () => {
    const t = openTestDb();
    try {
      const tiedTs = 1_700_000_000_000;
      t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "A", sourceTimestamp: tiedTs }),
        1000,
      );
      const b = t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "B", sourceTimestamp: tiedTs }),
        2000,
      );
      const replay = t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "A", sourceTimestamp: tiedTs }),
        3000,
      );
      expect(replay.inserted).toBe(false);

      const checkpoint = t.db.raw
        .prepare("SELECT last_source_message_id, last_committed_message_id FROM bridge_checkpoints")
        .get() as { last_source_message_id: string; last_committed_message_id: number };
      expect(checkpoint.last_source_message_id).toBe("B");
      expect(checkpoint.last_committed_message_id).toBe(b.messageId);
    } finally {
      t.dispose();
    }
  });

  it("updates the conversation display name without rewriting message snapshots", () => {
    const t = openTestDb();
    try {
      t.storage.messages.ingest(groupConversation(), incomingMessage(), 1000);
      t.storage.messages.ingest(
        { ...groupConversation(), displayName: "renamed group" },
        incomingMessage({ sourceMessageId: "src-2", senderName: "new-name" }),
        2000,
      );
      const conversation = t.db.raw
        .prepare("SELECT display_name FROM conversations")
        .get() as { display_name: string };
      expect(conversation.display_name).toBe("renamed group");
      const firstMessage = t.db.raw
        .prepare("SELECT sender_name FROM messages WHERE source_message_id = 'src-1'")
        .get() as { sender_name: string };
      expect(firstMessage.sender_name).toBe("sender");
    } finally {
      t.dispose();
    }
  });
});
