/**
 * qq_feed_pull assembly per docs/mcp-tools.md section 4: conversation-grouped
 * aggregation of feed events after the consumer's progress, per-conversation
 * pagination, progress advanced to the returned cutoff in the SAME
 * transaction (docs/data-model.md 4.11).
 */
import type { Database } from "../storage/database.ts";
import type { Storage } from "../storage/index.ts";
import { encodeRef } from "../storage/refs.ts";

const EVENT_SCAN_CAP = 4000;

export interface FeedUnitPreview {
  ref: string;
  summaryText: string;
  availableDimensions: string[];
}

export interface FeedConversation {
  conversationRef: string;
  conversationType: string;
  conversationId: string;
  conversationName: string;
  updateKinds: string[];
  newMessageCount: number;
  unreadMessageCount: number;
  from: number;
  to: number;
  summaryState: string;
  summaryUnits: FeedUnitPreview[];
  summarizingMessageCount: number;
  unsummarizedMessageCount: number;
}

export interface FeedPullResult {
  hasUpdates: boolean;
  hasMore: boolean;
  conversations: FeedConversation[];
}

interface FeedEventRow {
  id: number;
  conversation_id: number;
  kind: string;
  message_id: number | null;
  summary_unit_id: number | null;
  occurred_at: number;
}

const KIND_TO_UPDATE: Record<string, string> = {
  message: "messages",
  summary_completed: "summary_completed",
  summary_failed: "summary_failed",
  capture_gap: "capture_gap",
  recall: "recall",
};

export function createFeedService(
  db: Database,
  storage: Storage,
  consumerId: string,
  targetSelfUin: string,
) {
  const selectEvents = db.raw.prepare(
    `SELECT id, conversation_id, kind, message_id, summary_unit_id, occurred_at
     FROM feed_events WHERE id > ? ORDER BY id LIMIT ${String(EVENT_SCAN_CAP + 1)}`,
  );
  const conversationById = db.raw.prepare(
    "SELECT id, type, source_id, display_name, summary_enabled FROM conversations WHERE id = ? AND self_uin = ?",
  );
  const unreadCount = db.raw.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ?",
  );
  const summarizingCount = db.raw.prepare(
    `SELECT COUNT(*) AS c FROM messages m JOIN summary_units su ON su.id = m.summary_unit_id
     WHERE m.conversation_id = ? AND su.status IN ('queued', 'running')`,
  );
  const pendingUnitStatus = db.raw.prepare(
    "SELECT status FROM summary_units WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1",
  );
  const latestUnitStatus = db.raw.prepare(
    "SELECT status FROM summary_units WHERE conversation_id = ? ORDER BY id DESC LIMIT 1",
  );
  const unitPreview = db.raw.prepare(
    "SELECT id, summary_text FROM summary_units WHERE id = ? AND status = 'completed'",
  );
  const unitDimensions = db.raw.prepare(
    "SELECT DISTINCT dimension_key FROM summary_findings WHERE summary_unit_id = ? ORDER BY dimension_key",
  );

  return {
    pull(limit: number): FeedPullResult {
      return db.transaction(() => {
        const progress = storage.progress.getFeedProgress(consumerId);
        const rows = selectEvents.all(progress) as unknown as FeedEventRow[];
        const capped = rows.length > EVENT_SCAN_CAP;
        const events = capped ? rows.slice(0, EVENT_SCAN_CAP) : rows;
        if (events.length === 0) {
          return { hasUpdates: false, hasMore: false, conversations: [] };
        }

        const byConversation = new Map<number, FeedEventRow[]>();
        const order: number[] = [];
        for (const event of events) {
          let list = byConversation.get(event.conversation_id);
          if (list === undefined) {
            list = [];
            byConversation.set(event.conversation_id, list);
            order.push(event.conversation_id);
          }
          list.push(event);
        }

        const selected = new Set(order.slice(0, limit));
        const excluded = order.slice(limit);

        // Cutoff stops before the first event of the first unselected
        // conversation; later events of selected conversations wait for the
        // next call (docs/mcp-tools.md 4.5).
        let cutoff: number;
        if (excluded.length > 0) {
          const firstExcludedEventId = Math.min(
            ...excluded.map((conversationId) => byConversation.get(conversationId)?.[0]?.id ?? 0),
          );
          cutoff = firstExcludedEventId - 1;
        } else if (capped) {
          cutoff = events.at(-1)?.id ?? progress;
        } else {
          cutoff = events.at(-1)?.id ?? progress;
        }

        const conversations: FeedConversation[] = [];
        for (const conversationId of order.slice(0, limit)) {
          const scoped = (byConversation.get(conversationId) ?? []).filter(
            (event) => event.id <= cutoff,
          );
          if (scoped.length === 0) continue;
          const conversation = conversationById.get(conversationId, targetSelfUin) as
            | {
                id: number;
                type: string;
                source_id: string;
                display_name: string | null;
                summary_enabled: number;
              }
            | undefined;
          if (conversation === undefined) continue;

          const kinds = [...new Set(scoped.map((event) => KIND_TO_UPDATE[event.kind] ?? event.kind))];
          const completedUnits = scoped
            .filter((event) => event.kind === "summary_completed" && event.summary_unit_id !== null)
            .map((event) => event.summary_unit_id ?? 0);
          const failedInFeed = scoped.some((event) => event.kind === "summary_failed");

          const previews: FeedUnitPreview[] = [];
          for (const unitId of completedUnits) {
            const unit = unitPreview.get(unitId) as
              | { id: number; summary_text: string | null }
              | undefined;
            if (unit === undefined) continue;
            const dims = unitDimensions.all(unitId) as unknown as { dimension_key: string }[];
            previews.push({
              ref: encodeRef("summaryUnit", unit.id),
              summaryText: unit.summary_text ?? "",
              availableDimensions: dims.map((dim) => dim.dimension_key),
            });
          }

          const readProgress = storage.progress.getReadProgress(consumerId, conversationId);
          const unread = (unreadCount.get(conversationId, readProgress) as { c: number }).c;
          const summarizing = (summarizingCount.get(conversationId) as { c: number }).c;
          const unsummarized = storage.summaryUnits.unsummarizedCount(conversationId);

          let summaryState: string;
          if (conversation.summary_enabled === 0) summaryState = "disabled";
          else if (failedInFeed) summaryState = "failed";
          else if (previews.length > 0) summaryState = "completed";
          else {
            const pending = pendingUnitStatus.get(conversationId) as
              | { status: string }
              | undefined;
            if (pending !== undefined) summaryState = pending.status === "running" ? "running" : "queued";
            else if (unsummarized > 0) summaryState = "waiting";
            else {
              const latest = latestUnitStatus.get(conversationId) as
                | { status: string }
                | undefined;
              summaryState = latest?.status === "completed" ? "completed" : "waiting";
            }
          }

          conversations.push({
            conversationRef: encodeRef("conversation", conversationId),
            conversationType: conversation.type,
            conversationId: conversation.source_id,
            conversationName: conversation.display_name ?? conversation.source_id,
            updateKinds: kinds,
            newMessageCount: scoped.filter((event) => event.kind === "message").length,
            unreadMessageCount: unread,
            from: Math.min(...scoped.map((event) => event.occurred_at)),
            to: Math.max(...scoped.map((event) => event.occurred_at)),
            summaryState,
            summaryUnits: previews,
            summarizingMessageCount: summarizing,
            unsummarizedMessageCount: unsummarized,
          });
        }

        if (cutoff > progress) {
          storage.progress.advanceFeedProgress(consumerId, cutoff, Date.now());
        }
        const hasMore = capped || excluded.length > 0;
        return { hasUpdates: conversations.length > 0, hasMore, conversations };
      });
    },
  };
}

export type FeedService = ReturnType<typeof createFeedService>;
