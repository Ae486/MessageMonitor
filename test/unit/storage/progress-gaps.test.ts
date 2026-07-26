import { describe, expect, it } from "vitest";
import { groupConversation, incomingMessage, openTestDb } from "./helpers.ts";

describe("progress", () => {
  it("advances feed progress monotonically", () => {
    const t = openTestDb();
    try {
      expect(t.storage.progress.getFeedProgress("taki-main")).toBe(0);
      t.storage.progress.advanceFeedProgress("taki-main", 10, 1000);
      expect(t.storage.progress.getFeedProgress("taki-main")).toBe(10);
      t.storage.progress.advanceFeedProgress("taki-main", 5, 2000);
      expect(t.storage.progress.getFeedProgress("taki-main")).toBe(10);
      t.storage.progress.advanceFeedProgress("taki-main", 12, 3000);
      expect(t.storage.progress.getFeedProgress("taki-main")).toBe(12);
    } finally {
      t.dispose();
    }
  });

  it("advances read progress monotonically per conversation", () => {
    const t = openTestDb();
    try {
      const first = t.storage.messages.ingest(groupConversation(), incomingMessage(), 1000);
      const second = t.storage.messages.ingest(
        groupConversation(),
        incomingMessage({ sourceMessageId: "src-2" }),
        2000,
      );

      const conversationId = first.conversationId;
      t.storage.progress.advanceReadProgress("taki-main", conversationId, second.messageId, 3000);
      expect(t.storage.progress.getReadProgress("taki-main", conversationId)).toBe(
        second.messageId,
      );
      t.storage.progress.advanceReadProgress("taki-main", conversationId, first.messageId, 4000);
      expect(t.storage.progress.getReadProgress("taki-main", conversationId)).toBe(
        second.messageId,
      );
    } finally {
      t.dispose();
    }
  });
});

describe("capture gaps", () => {
  it("creates account-level gaps and counts unresolved ones", () => {
    const t = openTestDb();
    try {
      const id = t.storage.captureGaps.createAccountGap(
        { startedAt: 1000, endedAt: 5000, reasonCode: "disconnect" },
        6000,
      );
      expect(id).toBeGreaterThan(0);
      expect(t.storage.captureGaps.unresolvedCount()).toBe(1);

      const overlapping = t.storage.captureGaps.listOverlapping(4000, 9000);
      expect(overlapping).toHaveLength(1);
      expect(overlapping[0]).toMatchObject({ conversation_id: null, reason_code: "disconnect" });

      expect(t.storage.captureGaps.listOverlapping(6000, 9000)).toHaveLength(0);
    } finally {
      t.dispose();
    }
  });
});

describe("runtime state", () => {
  it("stores and reads JSON values", () => {
    const t = openTestDb();
    try {
      expect(t.storage.runtimeState.get("monitoringBaseline")).toBeUndefined();
      t.storage.runtimeState.set("monitoringBaseline", 1234, 1000);
      expect(t.storage.runtimeState.get<number>("monitoringBaseline")).toBe(1234);
      t.storage.runtimeState.set("monitoringBaseline", 5678, 2000);
      expect(t.storage.runtimeState.get<number>("monitoringBaseline")).toBe(5678);
    } finally {
      t.dispose();
    }
  });
});
