import { describe, expect, it } from "vitest";
import { Writable } from "node:stream";
import { createLogger } from "../../../src/logging/logger.ts";
import { createSummaryQueue, computeSchemaHash } from "../../../src/summary/summary-queue.ts";
import { ProducerError } from "../../../src/summary/summary-producer.ts";
import { countRows, openTestDb, type TestDb } from "../storage/helpers.ts";
import { fakeProducer, ingestBatch, okContent, summaryConfig, waitFor, type FakeProducer } from "./helpers.ts";
import type { SummaryConfig } from "../../../src/config/schema.ts";

const silentLog = createLogger("error", new Writable({ write: (_c, _e, cb) => cb() }));

function makeQueue(t: TestDb, producer: FakeProducer, config: SummaryConfig = summaryConfig()) {
  return createSummaryQueue(config, {
    units: t.storage.summaryUnits,
    producer,
    log: silentLog,
    retryDelayMs: () => 5,
  });
}

function unitRows(t: TestDb) {
  return t.db.raw
    .prepare("SELECT id, status, summary_text, retry_count FROM summary_units ORDER BY id")
    .all() as unknown as {
    id: number;
    status: string;
    summary_text: string | null;
    retry_count: number;
  }[];
}

describe("summary queue", () => {
  it("does nothing below the threshold and summarizes once it is reached", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const queue = makeQueue(t, producer);
    try {
      const conversationId = ingestBatch(t, 2);
      queue.poke(conversationId);
      await new Promise((resolve) => setTimeout(resolve, 50));
      expect(countRows(t.db, "summary_units")).toBe(0);

      producer.script.push({ kind: "ok", content: okContent("三条消息的摘要") });
      ingestBatch(t, 1, 3);
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));

      const rows = unitRows(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.summary_text).toBe("三条消息的摘要");
      const feedKinds = t.db.raw
        .prepare("SELECT kind, COUNT(*) AS c FROM feed_events GROUP BY kind")
        .all() as unknown as { kind: string; c: number }[];
      expect(feedKinds.find((row) => row.kind === "summary_completed")?.c).toBe(1);
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("persists validated findings with evidence and exposes them via the unit", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const queue = makeQueue(t, producer);
    try {
      const conversationId = ingestBatch(t, 3);
      let promptIds: number[] = [];
      producer.script.push({
        kind: "ok",
        content: (prompt) => {
          promptIds = [...prompt.user.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
          return JSON.stringify({
            summaryText: "含证据摘要",
            findings: [
              { dimension: "keyPoints", text: "事实一", messageIds: [promptIds[0], promptIds[1]] },
              { dimension: "conflicts", text: "分歧一", messageIds: [promptIds[2]] },
            ],
          });
        },
      });
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));

      const findings = t.db.raw
        .prepare("SELECT id, dimension_key, ordinal, text FROM summary_findings ORDER BY id")
        .all() as unknown as { id: number; dimension_key: string; ordinal: number; text: string }[];
      expect(findings).toMatchObject([
        { dimension_key: "keyPoints", ordinal: 0, text: "事实一" },
        { dimension_key: "conflicts", ordinal: 0, text: "分歧一" },
      ]);
      const evidence = t.db.raw
        .prepare(
          "SELECT summary_finding_id, message_id FROM summary_finding_messages ORDER BY summary_finding_id, message_id",
        )
        .all() as unknown as { summary_finding_id: number; message_id: number }[];
      expect(evidence).toEqual([
        { summary_finding_id: findings[0]?.id, message_id: promptIds[0] },
        { summary_finding_id: findings[0]?.id, message_id: promptIds[1] },
        { summary_finding_id: findings[1]?.id, message_id: promptIds[2] },
      ]);
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("retries the SAME frozen boundary and forms a summary gap after exhaustion (AC-10)", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const queue = makeQueue(t, producer);
    try {
      const conversationId = ingestBatch(t, 3);
      producer.script.push(
        { kind: "error", error: new ProducerError("PRODUCER_HTTP_500", "boom", true) },
        { kind: "error", error: new ProducerError("PRODUCER_TIMEOUT", "slow", true) },
        { kind: "ok", content: () => "not json at all {{{" },
      );
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "failed"));

      const rows = unitRows(t);
      expect(rows).toHaveLength(1);
      expect(rows[0]?.retry_count).toBe(3);
      const failedEvents = t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM feed_events WHERE kind = 'summary_failed'")
        .get() as { c: number };
      expect(failedEvents.c).toBe(1);

      // The next unit proceeds despite the gap (messages after the freeze).
      producer.script.push({ kind: "ok", content: okContent("后续单元照常") });
      ingestBatch(t, 3, 10);
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));
      const finalRows = unitRows(t);
      expect(finalRows.map((row) => row.status)).toEqual(["failed", "completed"]);
      // The post-gap unit received no preceding summary context.
      expect(producer.prompts.at(-1)?.user).not.toContain("preceding summary");
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("injects the preceding completed summary into the next unit's prompt (AC-09)", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const queue = makeQueue(t, producer);
    try {
      const conversationId = ingestBatch(t, 3);
      producer.script.push({ kind: "ok", content: okContent("第一段摘要文本") });
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));

      producer.script.push({ kind: "ok", content: okContent("第二段") });
      ingestBatch(t, 3, 10);
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).filter((row) => row.status === "completed").length === 2);

      expect(producer.prompts.at(-1)?.user).toContain("第一段摘要文本");
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("drains an over-threshold backlog into consecutive units in one pass", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    // Tiny budget forces multiple units out of one backlog.
    const queue = makeQueue(t, producer, summaryConfig({ maxInputTokensPerCall: 1000 }));
    try {
      // Long projections (~300 tokens each) against the 1000-token floor
      // force the backlog into multiple consecutive units.
      let conversationId = 0;
      for (let index = 1; index <= 8; index += 1) {
        const result = t.storage.messages.ingest(
          { selfUin: "10001", type: "group", sourceId: "123456789", summaryEnabled: true },
          {
            sourceMessageId: `long-${String(index)}`,
            sourceTimestamp: 1_700_000_000_000 + index * 1000,
            senderUin: "20002",
            senderName: "sender",
            isOwner: false,
            direction: "in",
            projection: `第${String(index)}条`.repeat(100),
          },
          1_700_000_000_000 + index * 1000,
        );
        conversationId = result.conversationId;
      }
      for (let index = 0; index < 8; index += 1) {
        producer.script.push({ kind: "ok", content: okContent(`分段${String(index)}`) });
      }
      queue.poke(conversationId);
      await waitFor(() => {
        const rows = unitRows(t);
        return (
          rows.length > 0 &&
          rows.every((row) => row.status === "completed") &&
          t.storage.summaryUnits.unsummarizedCount(conversationId) === 0
        );
      });
      // Tiny-budget freeze yields multiple non-overlapping consecutive units.
      const rows = t.db.raw
        .prepare("SELECT start_message_id, end_message_id FROM summary_units ORDER BY id")
        .all() as unknown as { start_message_id: number; end_message_id: number }[];
      expect(rows.length).toBeGreaterThan(1);
      for (let index = 1; index < rows.length; index += 1) {
        const previous = rows[index - 1];
        const current = rows[index];
        if (previous === undefined || current === undefined) continue;
        expect(current.start_message_id).toBe(previous.end_message_id + 1);
      }
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("recovers a queued unit after restart via recover()", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    try {
      const conversationId = ingestBatch(t, 3);
      const unit = t.storage.summaryUnits.freeze({
        conversationId,
        schemaHash: "sumcfg_x",
        schemaSnapshotJson: "{}",
        tokenBudget: 11000,
        now: 1,
      });
      if (unit === undefined) throw new Error("unreachable");
      t.storage.summaryUnits.markRunning(unit.unitId, 2);

      producer.script.push({ kind: "ok", content: okContent("重启后完成") });
      const queue = makeQueue(t, producer);
      queue.recover();
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));
      expect(unitRows(t)[0]?.summary_text).toBe("重启后完成");
      await queue.close();
    } finally {
      t.dispose();
    }
  });

  it("reports producer state transitions in status", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const queue = makeQueue(t, producer);
    try {
      expect(queue.getStatus().producerState).toBe("unknown");
      const conversationId = ingestBatch(t, 3);
      producer.script.push(
        { kind: "error", error: new ProducerError("PRODUCER_UNREACHABLE", "down", true) },
        { kind: "ok", content: okContent("恢复") },
      );
      queue.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));
      expect(queue.getStatus().producerState).toBe("available");
      expect(queue.getStatus().lastCompletedAt).toBeGreaterThan(0);
    } finally {
      await queue.close();
      t.dispose();
    }
  });

  it("keeps old units on their schema snapshot while new units use the new schema (AC-11/AC-12)", async () => {
    const t = openTestDb();
    const producer = fakeProducer();
    const configA = summaryConfig();
    const queueA = makeQueue(t, producer, configA);
    try {
      const conversationId = ingestBatch(t, 3);
      producer.script.push({ kind: "ok", content: okContent("旧配置摘要") });
      queueA.poke(conversationId);
      await waitFor(() => unitRows(t).some((row) => row.status === "completed"));
      await queueA.close();

      // Config change: a brand-new dimension appears without any DB migration (AC-11).
      const configB = summaryConfig({
        dimensions: { newAngle: { description: "全新维度" } },
        additionalPrompt: "新提示",
      });
      const queueB = makeQueue(t, producer, configB);
      producer.script.push({
        kind: "ok",
        content: (prompt) => {
          const ids = [...prompt.user.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
          return JSON.stringify({
            summaryText: "新配置摘要",
            findings: [{ dimension: "newAngle", text: "新维度事实", messageIds: [ids[0]] }],
          });
        },
      });
      ingestBatch(t, 3, 10);
      queueB.poke(conversationId);
      await waitFor(() => unitRows(t).filter((row) => row.status === "completed").length === 2);
      await queueB.close();

      const units = t.db.raw
        .prepare("SELECT schema_hash, schema_snapshot_json FROM summary_units ORDER BY id")
        .all() as unknown as { schema_hash: string; schema_snapshot_json: string }[];
      expect(units).toHaveLength(2);
      expect(units[0]?.schema_hash).not.toBe(units[1]?.schema_hash);
      const oldSnapshot = JSON.parse(units[0]?.schema_snapshot_json ?? "{}") as {
        dimensions: Record<string, unknown>;
        additionalPrompt: string;
      };
      const newSnapshot = JSON.parse(units[1]?.schema_snapshot_json ?? "{}") as {
        dimensions: Record<string, unknown>;
        additionalPrompt: string;
      };
      expect(Object.keys(oldSnapshot.dimensions)).toEqual(["keyPoints", "conflicts"]);
      expect(Object.keys(newSnapshot.dimensions)).toEqual(["newAngle"]);
      expect(newSnapshot.additionalPrompt).toBe("新提示");
      const finding = t.db.raw
        .prepare("SELECT dimension_key FROM summary_findings ORDER BY id DESC LIMIT 1")
        .get() as { dimension_key: string };
      expect(finding.dimension_key).toBe("newAngle");
    } finally {
      t.dispose();
    }
  });

  it("computes a stable schema hash independent of key order", () => {
    const a = computeSchemaHash({ x: { description: "一" }, y: { description: "二" } });
    const b = computeSchemaHash({ y: { description: "二" }, x: { description: "一" } });
    const c = computeSchemaHash({ x: { description: "不同" }, y: { description: "二" } });
    expect(a).toBe(b);
    expect(a).not.toBe(c);
    expect(a).toMatch(/^sumcfg_[0-9a-f]{8}$/);
  });
});
