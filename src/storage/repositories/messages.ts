/**
 * Idempotent message ingest per docs/data-model.md section 6.1: one short
 * transaction covering conversation upsert, insert-or-detect-duplicate,
 * checkpoint advance, and a feed event only when a row was actually inserted.
 */
import type { Database } from "../database.ts";
import type { ConversationIdentity, ConversationsRepo } from "./conversations.ts";

export interface IncomingMessage {
  sourceMessageId: string;
  sourceSequence?: string;
  sourceTimestamp: number;
  senderUin: string;
  senderName: string;
  isOwner: boolean;
  direction: "in" | "out";
  segmentsJson?: string;
  projection?: string;
}

export interface IngestResult {
  inserted: boolean;
  messageId: number;
  conversationId: number;
}

export interface RecallInput {
  conversationId: number;
  sourceMessageId: string;
  operatorUin?: string;
  /** When false (retainRecalledContent=false), the captured body is cleared. */
  retainContent: boolean;
}

export interface MessagesRepo {
  ingest(conversation: ConversationIdentity, message: IncomingMessage, now: number): IngestResult;
  /** Marks a captured message recalled; no-op for unknown or already-recalled messages. */
  markRecalled(recall: RecallInput, now: number): boolean;
  getById(messageId: number): MessageRow | undefined;
  /** Resolves which friend conversation holds a captured message (owner self-recall path). */
  findFriendConversation(
    selfUin: string,
    sourceMessageId: string,
  ): { conversationId: number; sourceId: string } | undefined;
  /** Wall-clock time of the most recent ingest checkpoint advance, if any. */
  latestCheckpointAt(): number | undefined;
}

export interface MessageRow {
  id: number;
  conversation_id: number;
  source_message_id: string;
  source_timestamp: number;
  sender_uin: string;
  sender_name: string;
  is_owner: number;
  direction: string;
  summary_unit_id: number | null;
  segments_json: string | null;
  projection: string | null;
  recalled_at: number | null;
  content_expired_at: number | null;
}

export function createMessagesRepo(db: Database, conversations: ConversationsRepo): MessagesRepo {
  const insertMessage = db.raw.prepare(`
    INSERT INTO messages (
      conversation_id, source_message_id, source_sequence, source_timestamp, ingested_at,
      sender_uin, sender_name, is_owner, direction, segments_json, projection
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id, source_message_id) DO NOTHING
  `);
  const findExisting = db.raw.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? AND source_message_id = ?",
  );
  const upsertCheckpoint = db.raw.prepare(`
    INSERT INTO bridge_checkpoints (
      conversation_id, last_source_message_id, last_source_sequence, last_source_timestamp,
      last_committed_message_id, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT (conversation_id) DO UPDATE SET
      last_source_message_id = excluded.last_source_message_id,
      last_source_sequence = excluded.last_source_sequence,
      last_source_timestamp = excluded.last_source_timestamp,
      last_committed_message_id = excluded.last_committed_message_id,
      updated_at = excluded.updated_at
    WHERE excluded.last_source_timestamp > COALESCE(last_source_timestamp, -1)
       OR (excluded.last_source_timestamp = COALESCE(last_source_timestamp, -1)
           AND excluded.last_committed_message_id >= COALESCE(last_committed_message_id, 0))
  `);
  const insertFeedEvent = db.raw.prepare(`
    INSERT INTO feed_events (conversation_id, kind, message_id, occurred_at)
    VALUES (?, 'message', ?, ?)
  `);
  const selectById = db.raw.prepare("SELECT * FROM messages WHERE id = ?");
  const markRecalledStmt = db.raw.prepare(`
    UPDATE messages SET recalled_at = ?, recall_operator_uin = ?
    WHERE conversation_id = ? AND source_message_id = ? AND recalled_at IS NULL
    RETURNING id
  `);
  const clearContentStmt = db.raw.prepare(
    "UPDATE messages SET segments_json = NULL, projection = NULL WHERE id = ?",
  );
  const insertRecallFeedEvent = db.raw.prepare(`
    INSERT INTO feed_events (conversation_id, kind, message_id, occurred_at)
    VALUES (?, 'recall', ?, ?)
  `);
  const findFriendConversationStmt = db.raw.prepare(`
    SELECT c.id AS conversation_id, c.source_id
    FROM messages m JOIN conversations c ON c.id = m.conversation_id
    WHERE c.self_uin = ? AND c.type = 'friend' AND m.source_message_id = ?
    LIMIT 2
  `);
  const latestCheckpointStmt = db.raw.prepare(
    "SELECT MAX(updated_at) AS latest FROM bridge_checkpoints",
  );

  return {
    ingest(conversation, message, now) {
      return db.transaction(() => {
        const conversationId = conversations.ensure(conversation, now);
        const result = insertMessage.run(
          conversationId,
          message.sourceMessageId,
          message.sourceSequence ?? null,
          message.sourceTimestamp,
          now,
          message.senderUin,
          message.senderName,
          message.isOwner ? 1 : 0,
          message.direction,
          message.segmentsJson ?? null,
          message.projection ?? null,
        );
        const inserted = result.changes > 0;

        let messageId: number;
        if (inserted) {
          messageId = Number(result.lastInsertRowid);
        } else {
          const existing = findExisting.get(conversationId, message.sourceMessageId) as {
            id: number;
          };
          messageId = existing.id;
        }

        upsertCheckpoint.run(
          conversationId,
          message.sourceMessageId,
          message.sourceSequence ?? null,
          message.sourceTimestamp,
          messageId,
          now,
        );

        if (inserted) {
          insertFeedEvent.run(conversationId, messageId, now);
        }

        return { inserted, messageId, conversationId };
      });
    },
    markRecalled(recall, now) {
      return db.transaction(() => {
        const row = markRecalledStmt.get(
          now,
          recall.operatorUin ?? null,
          recall.conversationId,
          recall.sourceMessageId,
        ) as { id: number } | undefined;
        if (row === undefined) return false;
        if (!recall.retainContent) {
          clearContentStmt.run(row.id);
        }
        insertRecallFeedEvent.run(recall.conversationId, row.id, now);
        return true;
      });
    },
    getById(messageId) {
      return selectById.get(messageId) as MessageRow | undefined;
    },
    findFriendConversation(selfUin, sourceMessageId) {
      const rows = findFriendConversationStmt.all(selfUin, sourceMessageId) as unknown as {
        conversation_id: number;
        source_id: string;
      }[];
      // Ambiguous source ids across conversations cannot be resolved safely.
      if (rows.length !== 1 || rows[0] === undefined) return undefined;
      return { conversationId: rows[0].conversation_id, sourceId: rows[0].source_id };
    },
    latestCheckpointAt() {
      const row = latestCheckpointStmt.get() as { latest: number | null };
      return row.latest ?? undefined;
    },
  };
}
