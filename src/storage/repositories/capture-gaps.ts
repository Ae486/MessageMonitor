import type { Database } from "../database.ts";

export interface AccountGapInput {
  startedAt: number;
  endedAt: number;
  reasonCode: string;
  detailsJson?: string;
}

export interface CaptureGapsRepo {
  /** conversation_id NULL = account-level gap (the only kind v1 creates). */
  createAccountGap(gap: AccountGapInput, now: number): number;
  unresolvedCount(): number;
  listOverlapping(fromMs: number, toMs: number): CaptureGapRow[];
}

export interface CaptureGapRow {
  id: number;
  conversation_id: number | null;
  started_at: number;
  ended_at: number;
  reason_code: string;
  resolved_at: number | null;
}

export function createCaptureGapsRepo(db: Database): CaptureGapsRepo {
  const insert = db.raw.prepare(`
    INSERT INTO capture_gaps (conversation_id, started_at, ended_at, reason_code, details_json, recovery_attempted, created_at)
    VALUES (NULL, ?, ?, ?, ?, 0, ?)
  `);
  const countUnresolved = db.raw.prepare(
    "SELECT COUNT(*) AS count FROM capture_gaps WHERE resolved_at IS NULL",
  );
  const overlapping = db.raw.prepare(`
    SELECT id, conversation_id, started_at, ended_at, reason_code, resolved_at
    FROM capture_gaps
    WHERE started_at <= ?2 AND ended_at >= ?1
    ORDER BY started_at
  `);

  return {
    createAccountGap(gap, now) {
      const result = insert.run(
        gap.startedAt,
        gap.endedAt,
        gap.reasonCode,
        gap.detailsJson ?? "{}",
        now,
      );
      return Number(result.lastInsertRowid);
    },
    unresolvedCount() {
      const row = countUnresolved.get() as { count: number };
      return row.count;
    },
    listOverlapping(fromMs, toMs) {
      return overlapping.all(fromMs, toMs) as unknown as CaptureGapRow[];
    },
  };
}
