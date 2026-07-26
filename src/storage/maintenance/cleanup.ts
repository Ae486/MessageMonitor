/**
 * Bounded-batch retention cleanup per docs/data-model.md section 7. Ordering
 * matters: expired summary units release their message/feed references first,
 * then consumed feed events go, then fully-unreferenced expired messages are
 * deleted, and finally still-referenced expired messages lose content only
 * (metadata stays so summary boundaries and evidence references keep resolving).
 * Feed rows are never removed past any consumer's feed progress.
 */
import type { Database } from "../database.ts";

export interface CleanupOptions {
  messageRetentionDays: number;
  summaryRetentionDays: number;
  now: number;
  batchLimit?: number;
}

export interface CleanupResult {
  deletedSummaryUnits: number;
  deletedFeedEvents: number;
  deletedMessages: number;
  expiredMessageContents: number;
}

const DAY_MS = 24 * 60 * 60 * 1000;

export function runCleanup(db: Database, options: CleanupOptions): CleanupResult {
  const batchLimit = options.batchLimit ?? 500;
  const messageCutoff = options.now - options.messageRetentionDays * DAY_MS;
  const summaryCutoff = options.now - options.summaryRetentionDays * DAY_MS;

  const minProgressRow = db.raw
    .prepare("SELECT MIN(last_feed_event_id) AS min_progress, COUNT(*) AS consumers FROM feed_progress")
    .get() as { min_progress: number | null; consumers: number };
  const hasConsumers = minProgressRow.consumers > 0;
  const minProgress = minProgressRow.min_progress ?? 0;

  let deletedSummaryUnits = 0;
  let deletedFeedEvents = 0;
  let deletedMessages = 0;
  let expiredMessageContents = 0;

  // 1. Expired summary units whose feed events are fully consumed.
  const expiredUnits = db.raw
    .prepare(
      `SELECT id FROM summary_units su
       WHERE COALESCE(su.completed_at, su.created_at) < ?
         AND NOT EXISTS (
           SELECT 1 FROM feed_events fe WHERE fe.summary_unit_id = su.id AND fe.id > ?
         )
       LIMIT ?`,
    )
    .all(summaryCutoff, minProgress, batchLimit) as unknown as { id: number }[];

  if (expiredUnits.length > 0 && hasConsumers) {
    const ids = expiredUnits.map((row) => row.id);
    const placeholders = ids.map(() => "?").join(", ");
    db.transaction(() => {
      db.raw
        .prepare(`DELETE FROM feed_events WHERE summary_unit_id IN (${placeholders})`)
        .run(...ids);
      db.raw
        .prepare(`UPDATE messages SET summary_unit_id = NULL WHERE summary_unit_id IN (${placeholders})`)
        .run(...ids);
      const result = db.raw
        .prepare(`DELETE FROM summary_units WHERE id IN (${placeholders})`)
        .run(...ids);
      deletedSummaryUnits = Number(result.changes);
    });
  }

  // 2. Consumed feed events whose entities are outside their OWN retention:
  //    message/recall events follow message retention; summary events are
  //    removed together with their unit in step 1, so they are never deleted
  //    here while the unit is still retained; capture_gap events are left to
  //    the future conversation-level gap extension.
  if (hasConsumers) {
    const result = db.raw
      .prepare(
        `DELETE FROM feed_events WHERE id IN (
           SELECT id FROM feed_events
           WHERE id <= ? AND occurred_at < ? AND kind IN ('message', 'recall')
           LIMIT ?
         )`,
      )
      .run(minProgress, messageCutoff, batchLimit);
    deletedFeedEvents = Number(result.changes);
  }

  // 3. Expired messages nothing references any more: delete the whole row.
  const deleteResult = db.raw
    .prepare(
      `DELETE FROM messages WHERE id IN (
         SELECT m.id FROM messages m
         WHERE m.source_timestamp < ?
           AND m.summary_unit_id IS NULL
           AND NOT EXISTS (SELECT 1 FROM summary_finding_messages sfm WHERE sfm.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM feed_events fe WHERE fe.message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM bridge_checkpoints bc WHERE bc.last_committed_message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM conversation_read_progress crp WHERE crp.last_message_id = m.id)
           AND NOT EXISTS (SELECT 1 FROM summary_units su WHERE su.start_message_id = m.id OR su.end_message_id = m.id)
         LIMIT ?
       )`,
    )
    .run(messageCutoff, batchLimit);
  deletedMessages = Number(deleteResult.changes);

  // 4. Expired but still-referenced messages: clear content, keep metadata,
  //    and mark covering summary units as source-unavailable.
  const contentRows = db.raw
    .prepare(
      `SELECT id, summary_unit_id FROM messages
       WHERE source_timestamp < ? AND content_expired_at IS NULL
         AND (segments_json IS NOT NULL OR projection IS NOT NULL)
       LIMIT ?`,
    )
    .all(messageCutoff, batchLimit) as unknown as { id: number; summary_unit_id: number | null }[];

  if (contentRows.length > 0) {
    const ids = contentRows.map((row) => row.id);
    const unitIds = [...new Set(contentRows.map((row) => row.summary_unit_id).filter(
      (id): id is number => id !== null,
    ))];
    const placeholders = ids.map(() => "?").join(", ");
    db.transaction(() => {
      db.raw
        .prepare(
          `UPDATE messages SET segments_json = NULL, projection = NULL, content_expired_at = ?
           WHERE id IN (${placeholders})`,
        )
        .run(options.now, ...ids);
      if (unitIds.length > 0) {
        const unitPlaceholders = unitIds.map(() => "?").join(", ");
        db.raw
          .prepare(`UPDATE summary_units SET source_available = 0 WHERE id IN (${unitPlaceholders})`)
          .run(...unitIds);
      }
    });
    expiredMessageContents = contentRows.length;
  }

  return { deletedSummaryUnits, deletedFeedEvents, deletedMessages, expiredMessageContents };
}
