/**
 * qq_read_conversation assembly per docs/mcp-tools.md section 5: scoped
 * reads with view rules, short-reference reads with context windows, and
 * mark_read. Only scope=unread advances Conversation Read Progress; pinned
 * reference reads never do.
 */
import type { AppConfig } from "../config/schema.ts";
import type { Database } from "../storage/database.ts";
import type { Storage } from "../storage/index.ts";
import { decodeRef, encodeRef } from "../storage/refs.ts";

export class ToolError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly details: Record<string, unknown>;

  constructor(code: string, message: string, retryable = false, details: Record<string, unknown> = {}) {
    super(message);
    this.name = "ToolError";
    this.code = code;
    this.retryable = retryable;
    this.details = details;
  }
}

export interface MessageItem {
  kind: "message";
  ref: string;
  senderUin: string;
  senderName: string;
  isOwner: boolean;
  direction: string;
  text: string | null;
  timestamp: number;
  recalled: boolean;
  contentAvailable: boolean;
  isEvidence?: boolean;
}

export interface SummaryItem {
  kind: "summary";
  ref: string;
  summaryText: string;
  availableDimensions: string[];
  messageCount: number;
  from: number;
  to: number;
}

export interface SummaryGapItem {
  kind: "summary_gap";
  ref: string;
  messageCount: number;
  from: number;
  to: number;
}

export interface CaptureGapItem {
  kind: "capture_gap";
  from: number;
  to: number;
  reasonCode: string;
}

export type ReadItem = MessageItem | SummaryItem | SummaryGapItem | CaptureGapItem;

interface MessageRow {
  id: number;
  conversation_id: number;
  source_timestamp: number;
  sender_uin: string;
  sender_name: string;
  is_owner: number;
  direction: string;
  summary_unit_id: number | null;
  projection: string | null;
  recalled_at: number | null;
  content_expired_at: number | null;
}

interface UnitRow {
  id: number;
  conversation_id: number;
  start_message_id: number;
  end_message_id: number;
  status: string;
  summary_text: string | null;
  message_count: number;
  schema_snapshot_json: string;
  source_available: number;
}

export function createConversationReader(db: Database, storage: Storage, config: AppConfig) {
  const consumerId = config.agent.consumerId;
  const expose =
    config.messages.retainRecalledContent && config.messages.exposeRecalledContentToAgent;

  const conversationByRefId = db.raw.prepare(
    "SELECT id, type, source_id FROM conversations WHERE id = ? AND self_uin = ?",
  );
  const messageAfter = db.raw.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? AND id > ? ORDER BY id LIMIT 1",
  );
  const messagesInRange = db.raw.prepare(
    "SELECT * FROM messages WHERE conversation_id = ? AND id >= ? AND id <= ? ORDER BY id",
  );
  const recentMessageIds = db.raw.prepare(
    "SELECT id FROM messages WHERE conversation_id = ? ORDER BY id DESC LIMIT ?",
  );
  const unitById = db.raw.prepare("SELECT * FROM summary_units WHERE id = ?");
  const messageById = db.raw.prepare("SELECT * FROM messages WHERE id = ?");
  // Entry-point statements: docs/data-model.md section 5 requires reference
  // resolution to enforce target-account isolation.
  const unitByIdForAccount = db.raw.prepare(
    `SELECT su.* FROM summary_units su JOIN conversations c ON c.id = su.conversation_id
     WHERE su.id = ? AND c.self_uin = ?`,
  );
  const messageByIdForAccount = db.raw.prepare(
    `SELECT m.* FROM messages m JOIN conversations c ON c.id = m.conversation_id
     WHERE m.id = ? AND c.self_uin = ?`,
  );
  const findingByIdForAccount = db.raw.prepare(
    `SELECT sf.* FROM summary_findings sf
     JOIN summary_units su ON su.id = sf.summary_unit_id
     JOIN conversations c ON c.id = su.conversation_id
     WHERE sf.id = ? AND c.self_uin = ?`,
  );
  const maxMessageId = db.raw.prepare(
    "SELECT MAX(id) AS id FROM messages WHERE conversation_id = ?",
  );
  const countBetween = db.raw.prepare(
    "SELECT COUNT(*) AS c FROM messages WHERE conversation_id = ? AND id > ? AND id <= ?",
  );
  const findingsOfUnit = db.raw.prepare(
    "SELECT id, dimension_key, ordinal, text FROM summary_findings WHERE summary_unit_id = ? ORDER BY dimension_key, ordinal",
  );
  const evidenceIds = db.raw.prepare(
    "SELECT message_id FROM summary_finding_messages WHERE summary_finding_id = ? ORDER BY message_id",
  );
  const evidenceCountOf = db.raw.prepare(
    "SELECT COUNT(*) AS c FROM summary_finding_messages WHERE summary_finding_id = ?",
  );
  const gapsOverlapping = db.raw.prepare(
    `SELECT started_at, ended_at, reason_code FROM capture_gaps
     WHERE started_at <= ?2 AND ended_at >= ?1 ORDER BY started_at LIMIT 20`,
  );

  function messageText(row: MessageRow): { text: string | null; available: boolean } {
    if (row.content_expired_at !== null) return { text: null, available: false };
    if (row.recalled_at !== null && !expose) return { text: "[消息已撤回]", available: true };
    return { text: row.projection, available: row.projection !== null };
  }

  function toMessageItem(row: MessageRow, isEvidence?: boolean): MessageItem {
    const { text, available } = messageText(row);
    return {
      kind: "message",
      ref: encodeRef("message", row.id),
      senderUin: row.sender_uin,
      senderName: row.sender_name,
      isOwner: row.is_owner === 1,
      direction: row.direction,
      text,
      timestamp: row.source_timestamp,
      recalled: row.recalled_at !== null,
      contentAvailable: available,
      ...(isEvidence !== undefined ? { isEvidence } : {}),
    };
  }

  function toSummaryItem(unit: UnitRow): SummaryItem | SummaryGapItem {
    const start = messageById.get(unit.start_message_id) as MessageRow | undefined;
    const end = messageById.get(unit.end_message_id) as MessageRow | undefined;
    const from = start?.source_timestamp ?? 0;
    const to = end?.source_timestamp ?? 0;
    if (unit.status === "failed") {
      return {
        kind: "summary_gap",
        ref: encodeRef("summaryUnit", unit.id),
        messageCount: unit.message_count,
        from,
        to,
      };
    }
    const dims = db.raw
      .prepare(
        "SELECT DISTINCT dimension_key FROM summary_findings WHERE summary_unit_id = ? ORDER BY dimension_key",
      )
      .all(unit.id) as unknown as { dimension_key: string }[];
    return {
      kind: "summary",
      ref: encodeRef("summaryUnit", unit.id),
      summaryText: unit.summary_text ?? "",
      availableDimensions: dims.map((dim) => dim.dimension_key),
      messageCount: unit.message_count,
      from,
      to,
    };
  }

  function resolveConversation(args: {
    conversationType?: string;
    conversationId?: string;
    reference?: string;
  }): { id: number; type: string; sourceId: string } {
    if (args.reference !== undefined) {
      const decoded = decodeRef(args.reference);
      if (decoded === undefined || decoded.kind !== "conversation") {
        throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
          reference: args.reference,
        });
      }
      const row = conversationByRefId.get(decoded.id, config.account.targetSelfUin) as
        | { id: number; type: string; source_id: string }
        | undefined;
      if (row === undefined) {
        throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
          reference: args.reference,
        });
      }
      return { id: row.id, type: row.type, sourceId: row.source_id };
    }
    if (args.conversationType === undefined || args.conversationId === undefined) {
      throw new ToolError(
        "INVALID_ARGUMENT",
        "Provide either reference or conversationType with conversationId.",
      );
    }
    const id = storage.conversations.findId(
      config.account.targetSelfUin,
      args.conversationType as "group" | "friend",
      args.conversationId,
    );
    if (id === undefined) {
      throw new ToolError("CONVERSATION_NOT_FOUND", "The conversation is not captured or does not exist.", false, {
        conversationType: args.conversationType,
        conversationId: args.conversationId,
      });
    }
    return { id, type: args.conversationType, sourceId: args.conversationId };
  }

  /** Walks logical items starting after `afterId`; returns items + highest covered message id. */
  function assembleForward(
    conversationId: number,
    afterId: number,
    view: string,
    limit: number,
  ): { items: ReadItem[]; lastCoveredId: number; reachedEnd: boolean } {
    const items: ReadItem[] = [];
    let cursor = afterId;
    let reachedEnd = false;

    while (items.length < limit) {
      const next = messageAfter.get(conversationId, cursor) as MessageRow | undefined;
      if (next === undefined) {
        reachedEnd = true;
        break;
      }
      const unit =
        next.summary_unit_id !== null
          ? (unitById.get(next.summary_unit_id) as UnitRow | undefined)
          : undefined;
      // A failed unit whose source is still readable is a RECOVERABLE region:
      // auto view must fall back to the raw messages (mcp-tools.md 5.3); only
      // expired failures collapse into a gap stub there.
      const collapse =
        unit !== undefined &&
        (unit.status === "completed" ||
          (unit.status === "failed" &&
            (unit.source_available === 0 || view === "summaries" || view === "both")));

      if (view === "messages" || !collapse) {
        if (view === "summaries") {
          // Summaries view never falls back to raw messages: stop at the tail.
          reachedEnd = false;
          break;
        }
        items.push(toMessageItem(next));
        cursor = next.id;
        continue;
      }
      if (unit === undefined) continue;

      // Completed or failed unit: emit the unit-level item.
      items.push(toSummaryItem(unit));
      if (view === "both") {
        const rows = messagesInRange.all(
          conversationId,
          unit.start_message_id,
          unit.end_message_id,
        ) as unknown as MessageRow[];
        for (const row of rows) {
          if (items.length >= limit) break;
          items.push(toMessageItem(row));
        }
      }
      cursor = unit.end_message_id;
    }

    return { items, lastCoveredId: cursor, reachedEnd };
  }

  function attachCaptureGaps(items: ReadItem[]): ReadItem[] {
    const timestamps = items
      .map((item) => ("timestamp" in item ? item.timestamp : "from" in item ? item.from : 0))
      .filter((value) => value > 0);
    if (timestamps.length === 0) return items;
    const from = Math.min(...timestamps);
    const to = Math.max(...timestamps);
    const gaps = gapsOverlapping.all(from, to) as unknown as {
      started_at: number;
      ended_at: number;
      reason_code: string;
    }[];
    if (gaps.length === 0) return items;
    const gapItems: CaptureGapItem[] = gaps.map((gap) => ({
      kind: "capture_gap",
      from: gap.started_at,
      to: gap.ended_at,
      reasonCode: gap.reason_code,
    }));
    const merged = [...items, ...gapItems];
    merged.sort((a, b) => {
      const ta = "timestamp" in a ? a.timestamp : a.from;
      const tb = "timestamp" in b ? b.timestamp : b.from;
      return ta - tb;
    });
    return merged;
  }

  function readConversation(args: {
    conversationType?: string;
    conversationId?: string;
    reference?: string;
    scope: string;
    cursor?: string;
    view: string;
    limit: number;
  }) {
    let cursorId: number | undefined;
    if (args.scope === "after_cursor") {
      if (args.cursor === undefined) {
        throw new ToolError("INVALID_ARGUMENT", "cursor is required when scope is after_cursor.");
      }
      const decoded = decodeRef(args.cursor);
      if (decoded === undefined || decoded.kind !== "message") {
        throw new ToolError("INVALID_ARGUMENT", "cursor must be a message reference.", false, {
          cursor: args.cursor,
        });
      }
      cursorId = decoded.id;
    }

    const conversation = resolveConversation(args);

    let afterId: number;
    if (args.scope === "unread") {
      afterId = storage.progress.getReadProgress(consumerId, conversation.id);
    } else if (cursorId !== undefined) {
      afterId = cursorId;
    } else {
      // recent: start so that roughly `limit` most recent messages are covered.
      const ids = recentMessageIds.all(conversation.id, args.limit) as unknown as { id: number }[];
      afterId = ids.length > 0 ? (ids.at(-1)?.id ?? 1) - 1 : 0;
    }

    const { items, lastCoveredId, reachedEnd } = assembleForward(
      conversation.id,
      afterId,
      args.view,
      args.limit,
    );

    let readProgressAdvancedTo: string | undefined;
    if (args.scope === "unread" && lastCoveredId > afterId) {
      storage.progress.advanceReadProgress(consumerId, conversation.id, lastCoveredId, Date.now());
      readProgressAdvancedTo = encodeRef("message", lastCoveredId);
    }

    const withGaps = attachCaptureGaps(items);
    const nextCursor = reachedEnd ? undefined : encodeRef("message", lastCoveredId);

    return {
      conversationRef: encodeRef("conversation", conversation.id),
      conversationType: conversation.type,
      conversationId: conversation.sourceId,
      scope: args.scope,
      view: args.view,
      items: withGaps,
      hasMore: !reachedEnd,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
      ...(readProgressAdvancedTo !== undefined ? { readProgressAdvancedTo } : {}),
    };
  }

  function readSummaryUnit(unitId: number, view: string, limit: number) {
    const unit = unitByIdForAccount.get(unitId, config.account.targetSelfUin) as unknown as
      | UnitRow
      | undefined;
    if (unit === undefined) {
      throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
        reference: encodeRef("summaryUnit", unitId),
      });
    }
    const findings = findingsOfUnit.all(unit.id) as unknown as {
      id: number;
      dimension_key: string;
      ordinal: number;
      text: string;
    }[];
    const sections: Record<string, { ref: string; text: string; evidenceCount: number }[]> = {};
    const snapshot = JSON.parse(unit.schema_snapshot_json) as {
      dimensions?: Record<string, { description: string }>;
    };
    for (const key of Object.keys(snapshot.dimensions ?? {})) {
      sections[key] = [];
    }
    for (const finding of findings) {
      const list = (sections[finding.dimension_key] ??= []);
      const count = (evidenceCountOf.get(finding.id) as { c: number }).c;
      list.push({
        ref: encodeRef("summaryFinding", finding.id),
        text: finding.text,
        evidenceCount: count,
      });
    }

    const base = {
      kind: "summary_unit",
      ref: encodeRef("summaryUnit", unit.id),
      conversationRef: encodeRef("conversation", unit.conversation_id),
      status: unit.status,
      summaryText: unit.summary_text ?? "",
      messageCount: unit.message_count,
      sourceAvailable: unit.source_available === 1,
      schemaSnapshot: snapshot,
      sections,
    };

    if (view !== "both") return base;
    if (unit.source_available === 0) {
      return { ...base, messages: [], evidenceAvailable: false, reason: "source_messages_expired" };
    }
    const rows = messagesInRange.all(
      unit.conversation_id,
      unit.start_message_id,
      unit.end_message_id,
    ) as unknown as MessageRow[];
    return { ...base, messages: rows.slice(0, limit).map((row) => toMessageItem(row)) };
  }

  function contextWindows(
    conversationId: number,
    centerIds: number[],
    radius: number,
  ): MessageItem[][] {
    const evidence = new Set(centerIds);
    const sorted = [...centerIds].sort((a, b) => a - b);
    const ranges: { start: number; end: number }[] = [];
    for (const id of sorted) {
      const start = Math.max(1, id - radius);
      const end = id + radius;
      const last = ranges.at(-1);
      if (last !== undefined && start <= last.end + 1) {
        last.end = Math.max(last.end, end);
      } else {
        ranges.push({ start, end });
      }
    }
    return ranges.map((range) => {
      const rows = messagesInRange.all(conversationId, range.start, range.end) as unknown as MessageRow[];
      return rows.map((row) => toMessageItem(row, evidence.has(row.id)));
    });
  }

  function readFinding(findingId: number, contextRadius: number) {
    const finding = findingByIdForAccount.get(findingId, config.account.targetSelfUin) as unknown as
      | { id: number; summary_unit_id: number; dimension_key: string; text: string }
      | undefined;
    if (finding === undefined) {
      throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
        reference: encodeRef("summaryFinding", findingId),
      });
    }
    const unit = unitById.get(finding.summary_unit_id) as unknown as UnitRow;
    const ids = (evidenceIds.all(finding.id) as unknown as { message_id: number }[]).map(
      (row) => row.message_id,
    );
    const rows = ids
      .map((id) => messageById.get(id) as MessageRow | undefined)
      .filter((row): row is MessageRow => row !== undefined);
    const allExpired = rows.length > 0 && rows.every((row) => row.content_expired_at !== null);

    const base = {
      kind: "summary_finding",
      ref: encodeRef("summaryFinding", finding.id),
      unitRef: encodeRef("summaryUnit", finding.summary_unit_id),
      dimension: finding.dimension_key,
      text: finding.text,
      evidenceCount: ids.length,
    };
    if (allExpired || unit.source_available === 0) {
      return { ...base, evidenceAvailable: false, reason: "source_messages_expired" };
    }
    return {
      ...base,
      evidenceAvailable: true,
      evidence: contextWindows(unit.conversation_id, ids, contextRadius),
    };
  }

  function readMessage(messageId: number, contextRadius: number) {
    const row = messageByIdForAccount.get(messageId, config.account.targetSelfUin) as unknown as
      | MessageRow
      | undefined;
    if (row === undefined) {
      throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
        reference: encodeRef("message", messageId),
      });
    }
    const windows = contextWindows(row.conversation_id, [row.id], contextRadius);
    return {
      kind: "message_context",
      conversationRef: encodeRef("conversation", row.conversation_id),
      message: toMessageItem(row, true),
      context: windows[0] ?? [],
    };
  }

  function markRead(args: { conversationType?: string; conversationId?: string; reference?: string }) {
    const conversation = resolveConversation(args);
    return db.transaction(() => {
      const before = storage.progress.getReadProgress(consumerId, conversation.id);
      const latest = (maxMessageId.get(conversation.id) as { id: number | null }).id;
      if (latest === null || latest <= before) {
        return {
          conversationRef: encodeRef("conversation", conversation.id),
          operation: "mark_read",
          markedMessageCount: 0,
          readProgressBefore: before > 0 ? encodeRef("message", before) : null,
          readProgressAfter: before > 0 ? encodeRef("message", before) : null,
          markedThroughTimestamp: null,
        };
      }
      const marked = (countBetween.get(conversation.id, before, latest) as { c: number }).c;
      storage.progress.advanceReadProgress(consumerId, conversation.id, latest, Date.now());
      const latestRow = messageById.get(latest) as unknown as MessageRow;
      return {
        conversationRef: encodeRef("conversation", conversation.id),
        operation: "mark_read",
        markedMessageCount: marked,
        readProgressBefore: before > 0 ? encodeRef("message", before) : null,
        readProgressAfter: encodeRef("message", latest),
        markedThroughTimestamp: latestRow.source_timestamp,
      };
    });
  }

  return { readConversation, readSummaryUnit, readFinding, readMessage, markRead, resolveConversation };
}

export type ConversationReader = ReturnType<typeof createConversationReader>;
