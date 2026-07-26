import { describe, expect, it } from "vitest";
import { runCleanup } from "../../../src/storage/maintenance/cleanup.ts";
import { countRows, groupConversation, incomingMessage, openTestDb, type TestDb } from "./helpers.ts";

const DAY = 24 * 60 * 60 * 1000;
const NOW = 1_750_000_000_000;

function ingestAt(t: TestDb, sourceMessageId: string, timestamp: number) {
  return t.storage.messages.ingest(
    groupConversation(),
    incomingMessage({ sourceMessageId, sourceTimestamp: timestamp }),
    timestamp,
  );
}

function createCompletedUnit(
  t: TestDb,
  conversationId: number,
  startMessageId: number,
  endMessageId: number,
  completedAt: number,
  precedingUnitId?: number,
): { unitId: number; findingId: number } {
  const unit = t.db.raw
    .prepare(
      `INSERT INTO summary_units (
         conversation_id, start_message_id, end_message_id, preceding_unit_id, status, message_count,
         summary_text, schema_hash, schema_snapshot_json, contains_recalled_messages,
         source_available, created_at, started_at, completed_at
       ) VALUES (?, ?, ?, ?, 'completed', ?, 'summary', 'hash', '{}', 0, 1, ?, ?, ?)`,
    )
    .run(
      conversationId,
      startMessageId,
      endMessageId,
      precedingUnitId ?? null,
      endMessageId - startMessageId + 1,
      completedAt,
      completedAt,
      completedAt,
    );
  const unitId = Number(unit.lastInsertRowid);
  t.db.raw
    .prepare("UPDATE messages SET summary_unit_id = ? WHERE id BETWEEN ? AND ?")
    .run(unitId, startMessageId, endMessageId);
  const finding = t.db.raw
    .prepare(
      "INSERT INTO summary_findings (summary_unit_id, dimension_key, ordinal, text) VALUES (?, 'keyPoints', 0, 'fact')",
    )
    .run(unitId);
  const findingId = Number(finding.lastInsertRowid);
  t.db.raw
    .prepare("INSERT INTO summary_finding_messages (summary_finding_id, message_id) VALUES (?, ?)")
    .run(findingId, startMessageId);
  t.db.raw
    .prepare(
      "INSERT INTO feed_events (conversation_id, kind, summary_unit_id, occurred_at) VALUES (?, 'summary_completed', ?, ?)",
    )
    .run(conversationId, unitId, completedAt);
  return { unitId, findingId };
}

function consumeAllFeed(t: TestDb) {
  const max = t.db.raw.prepare("SELECT MAX(id) AS id FROM feed_events").get() as {
    id: number | null;
  };
  t.storage.progress.advanceFeedProgress("taki-main", max.id ?? 0, NOW);
}

describe("runCleanup", () => {
  it("clears content of referenced messages but keeps metadata and evidence intact", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 40 * DAY);
      ingestAt(t, "m2", NOW - 40 * DAY + 1000);
      const m3 = ingestAt(t, "m3", NOW - 35 * DAY);
      const m4 = ingestAt(t, "m4", NOW - 1 * DAY);
      const { unitId } = createCompletedUnit(
        t,
        m1.conversationId,
        m1.messageId,
        m1.messageId + 1,
        NOW - 10 * DAY,
      );
      consumeAllFeed(t);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      // m3 was only referenced by its (consumed, expired) feed event: fully deleted.
      expect(result.deletedMessages).toBe(1);
      expect(t.storage.messages.getById(m3.messageId)).toBeUndefined();

      // m1/m2 are unit-covered: content cleared, metadata kept, unit marked source-unavailable.
      const m1Row = t.storage.messages.getById(m1.messageId);
      expect(m1Row).toBeDefined();
      expect(m1Row?.segments_json).toBeNull();
      expect(m1Row?.projection).toBeNull();
      expect(m1Row?.content_expired_at).toBe(NOW);
      const unit = t.db.raw
        .prepare("SELECT source_available FROM summary_units WHERE id = ?")
        .get(unitId) as { source_available: number };
      expect(unit.source_available).toBe(0);
      expect(countRows(t.db, "summary_finding_messages")).toBe(1);

      // m4 is inside retention: untouched.
      const m4Row = t.storage.messages.getById(m4.messageId);
      expect(m4Row?.projection).toBe("hi");
      expect(m4Row?.content_expired_at).toBeNull();
    } finally {
      t.dispose();
    }
  });

  it("deletes expired summary units and then their released messages", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 250 * DAY);
      ingestAt(t, "m2", NOW - 250 * DAY + 1000);
      createCompletedUnit(t, m1.conversationId, m1.messageId, m1.messageId + 1, NOW - 200 * DAY);
      consumeAllFeed(t);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      expect(result.deletedSummaryUnits).toBe(1);
      expect(countRows(t.db, "summary_units")).toBe(0);
      expect(countRows(t.db, "summary_findings")).toBe(0);
      expect(countRows(t.db, "summary_finding_messages")).toBe(0);
      // Both released messages are outside retention; only the checkpoint still pins the last one.
      expect(countRows(t.db, "messages")).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("deletes an expired unit that a live successor still references, nulling the chain link", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 250 * DAY);
      const m2 = ingestAt(t, "m2", NOW - 5 * DAY);
      const old = createCompletedUnit(
        t,
        m1.conversationId,
        m1.messageId,
        m1.messageId,
        NOW - 200 * DAY,
      );
      const successor = createCompletedUnit(
        t,
        m2.conversationId,
        m2.messageId,
        m2.messageId,
        NOW - 1 * DAY,
        old.unitId,
      );
      consumeAllFeed(t);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      expect(result.deletedSummaryUnits).toBe(1);
      const remaining = t.db.raw
        .prepare("SELECT id, preceding_unit_id FROM summary_units")
        .all() as unknown as { id: number; preceding_unit_id: number | null }[];
      expect(remaining).toEqual([{ id: successor.unitId, preceding_unit_id: null }]);
    } finally {
      t.dispose();
    }
  });

  it("never deletes feed events or units past the slowest consumer's progress", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 250 * DAY);
      ingestAt(t, "m2", NOW - 40 * DAY);
      createCompletedUnit(t, m1.conversationId, m1.messageId, m1.messageId, NOW - 200 * DAY);
      // Fast consumer has seen everything; slow consumer has seen nothing.
      consumeAllFeed(t);
      t.storage.progress.advanceFeedProgress("slow-consumer", 0, NOW);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      expect(result.deletedSummaryUnits).toBe(0);
      expect(result.deletedFeedEvents).toBe(0);
      expect(result.deletedMessages).toBe(0);
      expect(countRows(t.db, "summary_units")).toBe(1);
      expect(countRows(t.db, "feed_events")).toBe(3);
    } finally {
      t.dispose();
    }
  });

  it("keeps consumed summary feed events while their unit is inside summary retention", () => {
    const t = openTestDb();
    try {
      // Unit completed 40 days ago: past message retention, inside summary retention.
      const m1 = ingestAt(t, "m1", NOW - 40 * DAY);
      createCompletedUnit(t, m1.conversationId, m1.messageId, m1.messageId, NOW - 40 * DAY);
      consumeAllFeed(t);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      // The message-kind event goes; the summary_completed event must stay.
      expect(result.deletedFeedEvents).toBe(1);
      const kinds = t.db.raw
        .prepare("SELECT kind FROM feed_events ORDER BY id")
        .all() as unknown as { kind: string }[];
      expect(kinds).toEqual([{ kind: "summary_completed" }]);
      expect(countRows(t.db, "summary_units")).toBe(1);
    } finally {
      t.dispose();
    }
  });

  it("stays conservative when no feed consumer exists", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 250 * DAY);
      createCompletedUnit(t, m1.conversationId, m1.messageId, m1.messageId, NOW - 200 * DAY);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      expect(result.deletedSummaryUnits).toBe(0);
      expect(result.deletedFeedEvents).toBe(0);
      expect(result.deletedMessages).toBe(0);
      // Content expiry still applies: it does not depend on feed consumption.
      expect(result.expiredMessageContents).toBe(1);
      expect(countRows(t.db, "summary_units")).toBe(1);
      expect(countRows(t.db, "feed_events")).toBe(2);
    } finally {
      t.dispose();
    }
  });

  it("keeps messages pinned by read progress, clearing content only", () => {
    const t = openTestDb();
    try {
      const m1 = ingestAt(t, "m1", NOW - 40 * DAY);
      ingestAt(t, "m2", NOW - 1 * DAY);
      t.storage.progress.advanceReadProgress("taki-main", m1.conversationId, m1.messageId, NOW);
      consumeAllFeed(t);

      const result = runCleanup(t.db, {
        messageRetentionDays: 30,
        summaryRetentionDays: 180,
        now: NOW,
      });

      expect(result.deletedMessages).toBe(0);
      const row = t.storage.messages.getById(m1.messageId);
      expect(row).toBeDefined();
      expect(row?.projection).toBeNull();
      expect(row?.content_expired_at).toBe(NOW);
    } finally {
      t.dispose();
    }
  });
});
