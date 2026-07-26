/**
 * Feed and per-conversation read progress. Both only move forward: a stale
 * advance is a silent no-op, per docs/data-model.md sections 4.11/4.12.
 */
import type { Database } from "../database.ts";

export interface ProgressRepo {
  getFeedProgress(consumerId: string): number;
  advanceFeedProgress(consumerId: string, lastFeedEventId: number, now: number): void;
  getReadProgress(consumerId: string, conversationId: number): number;
  advanceReadProgress(
    consumerId: string,
    conversationId: number,
    lastMessageId: number,
    now: number,
  ): void;
}

export function createProgressRepo(db: Database): ProgressRepo {
  const getFeed = db.raw.prepare(
    "SELECT last_feed_event_id FROM feed_progress WHERE consumer_id = ?",
  );
  const upsertFeed = db.raw.prepare(`
    INSERT INTO feed_progress (consumer_id, last_feed_event_id, updated_at)
    VALUES (?, ?, ?)
    ON CONFLICT (consumer_id) DO UPDATE SET
      last_feed_event_id = MAX(last_feed_event_id, excluded.last_feed_event_id),
      updated_at = excluded.updated_at
  `);
  const getRead = db.raw.prepare(
    "SELECT last_message_id FROM conversation_read_progress WHERE consumer_id = ? AND conversation_id = ?",
  );
  const upsertRead = db.raw.prepare(`
    INSERT INTO conversation_read_progress (consumer_id, conversation_id, last_message_id, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT (consumer_id, conversation_id) DO UPDATE SET
      last_message_id = MAX(last_message_id, excluded.last_message_id),
      updated_at = excluded.updated_at
  `);

  return {
    getFeedProgress(consumerId) {
      const row = getFeed.get(consumerId) as { last_feed_event_id: number } | undefined;
      return row?.last_feed_event_id ?? 0;
    },
    advanceFeedProgress(consumerId, lastFeedEventId, now) {
      upsertFeed.run(consumerId, lastFeedEventId, now);
    },
    getReadProgress(consumerId, conversationId) {
      const row = getRead.get(consumerId, conversationId) as
        | { last_message_id: number }
        | undefined;
      return row?.last_message_id ?? 0;
    },
    advanceReadProgress(consumerId, conversationId, lastMessageId, now) {
      upsertRead.run(consumerId, conversationId, lastMessageId, now);
    },
  };
}
