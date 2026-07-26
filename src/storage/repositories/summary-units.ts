/**
 * Summary unit lifecycle per docs/data-model.md 6.2/6.3: budget-bounded
 * atomic freeze, single-call completion with evidence validation, failure
 * marking. Model calls never run inside these transactions.
 */
import type { Database } from "../database.ts";
import { estimateTokens } from "../../summary/token-estimate.ts";

export interface FreezeOptions {
  conversationId: number;
  schemaHash: string;
  schemaSnapshotJson: string;
  tokenBudget: number;
  now: number;
}

export interface FrozenMessage {
  id: number;
  senderName: string;
  senderUin: string;
  isOwner: boolean;
  timestamp: number;
  projection: string;
  recalled: boolean;
}

export interface FrozenUnit {
  unitId: number;
  conversationId: number;
  messages: FrozenMessage[];
  precedingSummaryText?: string;
  containsRecalled: boolean;
}

export interface FindingInput {
  dimensionKey: string;
  text: string;
  evidenceMessageIds: number[];
}

export interface CompletionInput {
  unitId: number;
  summaryText: string;
  findings: FindingInput[];
  now: number;
}

export interface SummaryUnitsRepo {
  unsummarizedCount(conversationId: number): number;
  hasPendingUnit(conversationId: number): boolean;
  /** Freezes the oldest unsummarized messages that fit the budget; undefined when none exist or a unit is pending. */
  freeze(options: FreezeOptions): FrozenUnit | undefined;
  /** Reloads an already-frozen queued unit (crash/restart recovery path). */
  loadQueued(conversationId: number): FrozenUnit | undefined;
  markRunning(unitId: number, now: number): void;
  requeue(unitId: number): void;
  /** Crash-isolation: puts a conversation's running unit back to queued. */
  requeueConversation(conversationId: number): void;
  complete(input: CompletionInput): void;
  recordFailure(unitId: number, errorCode: string, errorMessage: string): number;
  markFailed(unitId: number, now: number): void;
  recoverInterrupted(): number;
  listQueuedConversationIds(): number[];
  summaryEnabledConversationIds(): number[];
}

export class EvidenceOutOfUnitError extends Error {
  constructor(messageId: number) {
    super(`evidence message ${String(messageId)} is outside the frozen unit`);
    this.name = "EvidenceOutOfUnitError";
  }
}

export function createSummaryUnitsRepo(db: Database): SummaryUnitsRepo {
  // content_expired_at IS NULL keeps messages released by unit expiry from
  // ever re-entering the pipeline (docs/data-model.md 4.7: one-time membership).
  const countUnassigned = db.raw.prepare(
    "SELECT COUNT(*) AS count FROM messages WHERE conversation_id = ? AND summary_unit_id IS NULL AND content_expired_at IS NULL",
  );
  const pendingUnit = db.raw.prepare(
    "SELECT id FROM summary_units WHERE conversation_id = ? AND status IN ('queued', 'running') LIMIT 1",
  );
  const selectUnassigned = db.raw.prepare(`
    SELECT id, sender_name, sender_uin, is_owner, source_timestamp, projection, recalled_at
    FROM messages
    WHERE conversation_id = ? AND summary_unit_id IS NULL AND content_expired_at IS NULL
    ORDER BY id
  `);
  const precedingCompleted = db.raw.prepare(`
    SELECT id, summary_text FROM summary_units
    WHERE conversation_id = ? AND status IN ('completed', 'failed')
    ORDER BY id DESC LIMIT 1
  `);
  const insertUnit = db.raw.prepare(`
    INSERT INTO summary_units (
      conversation_id, start_message_id, end_message_id, preceding_unit_id, status,
      message_count, schema_hash, schema_snapshot_json, contains_recalled_messages,
      source_available, created_at
    ) VALUES (?, ?, ?, ?, 'queued', ?, ?, ?, ?, 1, ?)
  `);
  const assignMessages = db.raw.prepare(
    "UPDATE messages SET summary_unit_id = ? WHERE id BETWEEN ? AND ? AND conversation_id = ? AND summary_unit_id IS NULL",
  );
  const setRunning = db.raw.prepare(
    "UPDATE summary_units SET status = 'running', started_at = ? WHERE id = ? AND status = 'queued'",
  );
  const setQueued = db.raw.prepare(
    "UPDATE summary_units SET status = 'queued' WHERE id = ? AND status = 'running'",
  );
  const setQueuedByConversation = db.raw.prepare(
    "UPDATE summary_units SET status = 'queued' WHERE conversation_id = ? AND status = 'running'",
  );
  const unitForUpdate = db.raw.prepare(
    "SELECT conversation_id, start_message_id, end_message_id, status FROM summary_units WHERE id = ?",
  );
  const updateCompleted = db.raw.prepare(
    "UPDATE summary_units SET status = 'completed', summary_text = ?, completed_at = ? WHERE id = ?",
  );
  const insertFinding = db.raw.prepare(
    "INSERT INTO summary_findings (summary_unit_id, dimension_key, ordinal, text) VALUES (?, ?, ?, ?)",
  );
  const insertEvidence = db.raw.prepare(
    "INSERT INTO summary_finding_messages (summary_finding_id, message_id) VALUES (?, ?)",
  );
  const evidenceInUnit = db.raw.prepare(
    "SELECT 1 FROM messages WHERE id = ? AND summary_unit_id = ?",
  );
  const insertFeedEvent = db.raw.prepare(
    "INSERT INTO feed_events (conversation_id, kind, summary_unit_id, occurred_at) VALUES (?, ?, ?, ?)",
  );
  const bumpRetry = db.raw.prepare(`
    UPDATE summary_units SET retry_count = retry_count + 1, last_error_code = ?, last_error_message = ?
    WHERE id = ? RETURNING retry_count
  `);
  const setFailed = db.raw.prepare(
    "UPDATE summary_units SET status = 'failed', completed_at = ? WHERE id = ?",
  );
  const recoverRunning = db.raw.prepare(
    "UPDATE summary_units SET status = 'queued' WHERE status = 'running'",
  );
  const queuedUnit = db.raw.prepare(`
    SELECT id, conversation_id, preceding_unit_id, contains_recalled_messages
    FROM summary_units WHERE conversation_id = ? AND status = 'queued' LIMIT 1
  `);
  const unitMessages = db.raw.prepare(`
    SELECT id, sender_name, sender_uin, is_owner, source_timestamp, projection, recalled_at
    FROM messages WHERE summary_unit_id = ? ORDER BY id
  `);
  const summaryTextOf = db.raw.prepare(
    "SELECT summary_text FROM summary_units WHERE id = ? AND status = 'completed'",
  );
  const queuedConversations = db.raw.prepare(
    "SELECT DISTINCT conversation_id FROM summary_units WHERE status = 'queued'",
  );
  const summaryEnabled = db.raw.prepare(
    "SELECT id FROM conversations WHERE summary_enabled = 1 AND capture_enabled = 1",
  );

  return {
    unsummarizedCount(conversationId) {
      const row = countUnassigned.get(conversationId) as { count: number };
      return row.count;
    },
    hasPendingUnit(conversationId) {
      return pendingUnit.get(conversationId) !== undefined;
    },
    freeze(options) {
      return db.transaction(() => {
        if (pendingUnit.get(options.conversationId) !== undefined) return undefined;

        const rows = selectUnassigned.all(options.conversationId) as unknown as {
          id: number;
          sender_name: string;
          sender_uin: string;
          is_owner: number;
          source_timestamp: number;
          projection: string | null;
          recalled_at: number | null;
        }[];
        if (rows.length === 0) return undefined;

        const selected: typeof rows = [];
        let usedTokens = 0;
        for (const row of rows) {
          const text = row.recalled_at !== null ? "[消息已撤回]" : (row.projection ?? "");
          const cost = estimateTokens(text) + 8;
          if (selected.length > 0 && usedTokens + cost > options.tokenBudget) break;
          selected.push(row);
          usedTokens += cost;
        }

        const first = selected[0];
        const last = selected.at(-1);
        if (first === undefined || last === undefined) return undefined;

        const preceding = precedingCompleted.get(options.conversationId) as
          | { id: number; summary_text: string | null }
          | undefined;

        const containsRecalled = selected.some((row) => row.recalled_at !== null);
        const insert = insertUnit.run(
          options.conversationId,
          first.id,
          last.id,
          preceding?.id ?? null,
          selected.length,
          options.schemaHash,
          options.schemaSnapshotJson,
          containsRecalled ? 1 : 0,
          options.now,
        );
        const unitId = Number(insert.lastInsertRowid);
        const assigned = assignMessages.run(unitId, first.id, last.id, options.conversationId);
        if (Number(assigned.changes) !== selected.length) {
          throw new Error(
            `freeze assignment mismatch: expected ${String(selected.length)}, assigned ${String(assigned.changes)}`,
          );
        }

        return {
          unitId,
          conversationId: options.conversationId,
          messages: selected.map((row) => ({
            id: row.id,
            senderName: row.sender_name,
            senderUin: row.sender_uin,
            isOwner: row.is_owner === 1,
            timestamp: row.source_timestamp,
            projection: row.recalled_at !== null ? "[消息已撤回]" : (row.projection ?? ""),
            recalled: row.recalled_at !== null,
          })),
          ...(preceding?.summary_text != null ? { precedingSummaryText: preceding.summary_text } : {}),
          containsRecalled,
        };
      });
    },
    loadQueued(conversationId) {
      const unit = queuedUnit.get(conversationId) as
        | {
            id: number;
            conversation_id: number;
            preceding_unit_id: number | null;
            contains_recalled_messages: number;
          }
        | undefined;
      if (unit === undefined) return undefined;
      const rows = unitMessages.all(unit.id) as unknown as {
        id: number;
        sender_name: string;
        sender_uin: string;
        is_owner: number;
        source_timestamp: number;
        projection: string | null;
        recalled_at: number | null;
      }[];
      let precedingSummaryText: string | undefined;
      if (unit.preceding_unit_id !== null) {
        const preceding = summaryTextOf.get(unit.preceding_unit_id) as
          | { summary_text: string | null }
          | undefined;
        if (preceding?.summary_text != null) precedingSummaryText = preceding.summary_text;
      }
      return {
        unitId: unit.id,
        conversationId: unit.conversation_id,
        messages: rows.map((row) => ({
          id: row.id,
          senderName: row.sender_name,
          senderUin: row.sender_uin,
          isOwner: row.is_owner === 1,
          timestamp: row.source_timestamp,
          projection: row.recalled_at !== null ? "[消息已撤回]" : (row.projection ?? ""),
          recalled: row.recalled_at !== null,
        })),
        ...(precedingSummaryText !== undefined ? { precedingSummaryText } : {}),
        containsRecalled: unit.contains_recalled_messages === 1,
      };
    },
    markRunning(unitId, now) {
      setRunning.run(now, unitId);
    },
    requeue(unitId) {
      setQueued.run(unitId);
    },
    requeueConversation(conversationId) {
      setQueuedByConversation.run(conversationId);
    },
    complete(input) {
      db.transaction(() => {
        const unit = unitForUpdate.get(input.unitId) as
          | { conversation_id: number; status: string }
          | undefined;
        if (unit === undefined || unit.status !== "running") {
          throw new Error(`unit ${String(input.unitId)} is not running`);
        }
        for (const finding of input.findings) {
          for (const messageId of finding.evidenceMessageIds) {
            if (evidenceInUnit.get(messageId, input.unitId) === undefined) {
              throw new EvidenceOutOfUnitError(messageId);
            }
          }
        }
        updateCompleted.run(input.summaryText, input.now, input.unitId);
        const ordinals = new Map<string, number>();
        for (const finding of input.findings) {
          const ordinal = ordinals.get(finding.dimensionKey) ?? 0;
          ordinals.set(finding.dimensionKey, ordinal + 1);
          const inserted = insertFinding.run(
            input.unitId,
            finding.dimensionKey,
            ordinal,
            finding.text,
          );
          const findingId = Number(inserted.lastInsertRowid);
          for (const messageId of new Set(finding.evidenceMessageIds)) {
            insertEvidence.run(findingId, messageId);
          }
        }
        insertFeedEvent.run(unit.conversation_id, "summary_completed", input.unitId, input.now);
      });
    },
    recordFailure(unitId, errorCode, errorMessage) {
      const row = bumpRetry.get(errorCode, errorMessage.slice(0, 500), unitId) as {
        retry_count: number;
      };
      return row.retry_count;
    },
    markFailed(unitId, now) {
      db.transaction(() => {
        const unit = unitForUpdate.get(unitId) as { conversation_id: number } | undefined;
        if (unit === undefined) return;
        setFailed.run(now, unitId);
        insertFeedEvent.run(unit.conversation_id, "summary_failed", unitId, now);
      });
    },
    recoverInterrupted() {
      return Number(recoverRunning.run().changes);
    },
    listQueuedConversationIds() {
      const rows = queuedConversations.all() as unknown as { conversation_id: number }[];
      return rows.map((row) => row.conversation_id);
    },
    summaryEnabledConversationIds() {
      const rows = summaryEnabled.all() as unknown as { id: number }[];
      return rows.map((row) => row.id);
    },
  };
}
