import type { Database } from "../database.ts";

export type ConversationType = "group" | "friend";

export interface ConversationIdentity {
  selfUin: string;
  type: ConversationType;
  sourceId: string;
  displayName?: string;
  summaryEnabled: boolean;
}

export interface ConversationsRepo {
  /** Insert or refresh; returns the local conversation id. Caller owns the transaction. */
  ensure(identity: ConversationIdentity, now: number): number;
  findId(selfUin: string, type: ConversationType, sourceId: string): number | undefined;
}

export function createConversationsRepo(db: Database): ConversationsRepo {
  const upsert = db.raw.prepare(`
    INSERT INTO conversations (self_uin, type, source_id, display_name, capture_enabled, summary_enabled, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1, ?, ?, ?)
    ON CONFLICT (self_uin, type, source_id) DO UPDATE SET
      display_name = COALESCE(excluded.display_name, display_name),
      summary_enabled = excluded.summary_enabled,
      capture_enabled = 1,
      updated_at = excluded.updated_at
    RETURNING id
  `);
  const find = db.raw.prepare(
    "SELECT id FROM conversations WHERE self_uin = ? AND type = ? AND source_id = ?",
  );

  return {
    ensure(identity, now) {
      const row = upsert.get(
        identity.selfUin,
        identity.type,
        identity.sourceId,
        identity.displayName ?? null,
        identity.summaryEnabled ? 1 : 0,
        now,
        now,
      ) as { id: number };
      return row.id;
    },
    findId(selfUin, type, sourceId) {
      const row = find.get(selfUin, type, sourceId) as { id: number } | undefined;
      return row?.id;
    },
  };
}
