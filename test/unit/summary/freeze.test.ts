import { describe, expect, it } from "vitest";
import { EvidenceOutOfUnitError } from "../../../src/storage/repositories/summary-units.ts";
import { openTestDb } from "../storage/helpers.ts";
import { ingestBatch } from "./helpers.ts";

const FREEZE_DEFAULTS = {
  schemaHash: "sumcfg_test",
  schemaSnapshotJson: "{}",
  tokenBudget: 11000,
  now: 1_700_000_100_000,
};

describe("summary unit freeze", () => {
  it("freezes all unsummarized messages and assigns them atomically (AC-08 boundary)", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 5);
      const unit = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      expect(unit).toBeDefined();
      expect(unit?.messages).toHaveLength(5);

      const unassigned = t.storage.summaryUnits.unsummarizedCount(conversationId);
      expect(unassigned).toBe(0);

      // Messages arriving after the freeze belong to the next unit.
      ingestBatch(t, 2, 6);
      expect(t.storage.summaryUnits.unsummarizedCount(conversationId)).toBe(2);
      const row = t.db.raw
        .prepare("SELECT start_message_id, end_message_id, message_count, status FROM summary_units")
        .get() as { start_message_id: number; end_message_id: number; message_count: number; status: string };
      expect(row).toMatchObject({ message_count: 5, status: "queued" });
    } finally {
      t.dispose();
    }
  });

  it("refuses a second freeze while a unit is pending", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 3);
      expect(t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId })).toBeDefined();
      ingestBatch(t, 3, 10);
      expect(t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId })).toBeUndefined();
    } finally {
      t.dispose();
    }
  });

  it("bounds the unit by token budget, oldest first, and continues with the remainder", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 10);
      // Each message ~4-6 CJK chars + 8 fixed: a tiny budget takes only the oldest few.
      const unit = t.storage.summaryUnits.freeze({
        ...FREEZE_DEFAULTS,
        conversationId,
        tokenBudget: 40,
      });
      expect(unit).toBeDefined();
      const size = unit?.messages.length ?? 0;
      expect(size).toBeGreaterThan(0);
      expect(size).toBeLessThan(10);
      expect(unit?.messages[0]?.projection).toBe("消息内容1");
      expect(t.storage.summaryUnits.unsummarizedCount(conversationId)).toBe(10 - size);
    } finally {
      t.dispose();
    }
  });

  it("always freezes at least one message even when it alone exceeds the budget", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 1);
      t.db.raw
        .prepare("UPDATE messages SET projection = ?")
        .run("超长".repeat(5000));
      const unit = t.storage.summaryUnits.freeze({
        ...FREEZE_DEFAULTS,
        conversationId,
        tokenBudget: 100,
      });
      expect(unit?.messages).toHaveLength(1);
    } finally {
      t.dispose();
    }
  });

  it("links the preceding unit and injects only a completed predecessor's text (AC-09/AC-10)", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 3);
      const first = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      expect(first).toBeDefined();
      if (first === undefined) throw new Error("unreachable");
      t.storage.summaryUnits.markRunning(first.unitId, 1);
      t.storage.summaryUnits.complete({
        unitId: first.unitId,
        summaryText: "第一段摘要",
        findings: [],
        now: 2,
      });

      ingestBatch(t, 3, 10);
      const second = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      expect(second?.precedingSummaryText).toBe("第一段摘要");
      if (second === undefined) throw new Error("unreachable");

      // Fail the second unit; the third must NOT inherit the first's summary.
      t.storage.summaryUnits.markRunning(second.unitId, 3);
      t.storage.summaryUnits.markFailed(second.unitId, 4);
      ingestBatch(t, 3, 20);
      const third = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      expect(third?.precedingSummaryText).toBeUndefined();
    } finally {
      t.dispose();
    }
  });

  it("uses recall placeholders in frozen projections and flags the unit", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 3);
      t.storage.messages.markRecalled(
        { conversationId, sourceMessageId: "msg-2", retainContent: true },
        50,
      );
      const unit = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      expect(unit?.containsRecalled).toBe(true);
      expect(unit?.messages[1]?.projection).toBe("[消息已撤回]");
    } finally {
      t.dispose();
    }
  });

  it("rejects completion evidence outside the frozen unit", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 3);
      const unit = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      if (unit === undefined) throw new Error("unreachable");
      ingestBatch(t, 1, 99);
      const outsideId = (
        t.db.raw
          .prepare("SELECT id FROM messages WHERE summary_unit_id IS NULL")
          .get() as { id: number }
      ).id;

      t.storage.summaryUnits.markRunning(unit.unitId, 1);
      expect(() =>
        t.storage.summaryUnits.complete({
          unitId: unit.unitId,
          summaryText: "s",
          findings: [{ dimensionKey: "keyPoints", text: "t", evidenceMessageIds: [outsideId] }],
          now: 2,
        }),
      ).toThrow(EvidenceOutOfUnitError);

      // The failed transaction left nothing behind.
      const status = (
        t.db.raw.prepare("SELECT status FROM summary_units WHERE id = ?").get(unit.unitId) as {
          status: string;
        }
      ).status;
      expect(status).toBe("running");
      expect(
        (t.db.raw.prepare("SELECT COUNT(*) AS c FROM summary_findings").get() as { c: number }).c,
      ).toBe(0);
    } finally {
      t.dispose();
    }
  });

  it("recovers interrupted running units back to queued and reloads them", () => {
    const t = openTestDb();
    try {
      const conversationId = ingestBatch(t, 3);
      const unit = t.storage.summaryUnits.freeze({ ...FREEZE_DEFAULTS, conversationId });
      if (unit === undefined) throw new Error("unreachable");
      t.storage.summaryUnits.markRunning(unit.unitId, 1);

      expect(t.storage.summaryUnits.recoverInterrupted()).toBe(1);
      const reloaded = t.storage.summaryUnits.loadQueued(conversationId);
      expect(reloaded?.unitId).toBe(unit.unitId);
      expect(reloaded?.messages).toHaveLength(3);
    } finally {
      t.dispose();
    }
  });
});
