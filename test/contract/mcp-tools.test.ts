import { afterEach, describe, expect, it } from "vitest";
import {
  friendMessage,
  groupMessage,
  groupRecall,
  ownerSentFriendMessage,
} from "../fixtures/onebot-events.ts";
import { okContent, waitFor } from "../unit/summary/helpers.ts";
import { startContractRig, type ContractRig } from "./helpers.ts";

let rig: ContractRig;

afterEach(async () => {
  await rig.dispose();
});

function ingestGroupMessages(count: number, startId = 1): void {
  for (let index = 0; index < count; index += 1) {
    rig.ingest.handleEvent(
      groupMessage({
        message_id: 900000 + startId + index,
        message: [{ type: "text", data: { text: `第${String(startId + index)}条` } }],
        time: 1_784_566_000 + startId + index,
      }),
      (1_784_566_000 + startId + index) * 1000,
    );
  }
}

describe("MCP tool surface", () => {
  it("exposes exactly the three read-only tools with dynamic dimension descriptions", async () => {
    rig = await startContractRig();
    const tools = await rig.client.listTools();
    const names = tools.tools.map((tool) => tool.name).sort();
    expect(names).toEqual(["qq_feed_pull", "qq_monitor_status", "qq_read_conversation"]);
    const read = tools.tools.find((tool) => tool.name === "qq_read_conversation");
    expect(read?.description).toContain("keyPoints");
    expect(read?.description).toContain("关键事实");
  });
});

describe("qq_monitor_status", () => {
  it("reports active/healthy with populated sections and no issues", async () => {
    rig = await startContractRig();
    ingestGroupMessages(2);
    const status = await rig.callTool("qq_monitor_status");
    expect(status["lifecycleState"]).toBe("active");
    expect(status["healthState"]).toBe("healthy");
    expect(status["readyForCapture"]).toBe(true);
    expect((status["account"] as { verified: boolean }).verified).toBe(true);
    expect((status["storage"] as { messageCount: number }).messageCount).toBe(2);
    expect((status["summary"] as { producerState: string }).producerState).toBe("unknown");
    expect(status["issues"]).toEqual([]);
  });

  it("degrades with an owner-relayable issue on account mismatch (AC-02)", async () => {
    rig = await startContractRig();
    rig.lifecycleState.state = "verifying";
    rig.lifecycleState.mismatch = true;
    const status = await rig.callTool("qq_monitor_status");
    expect(status["healthState"]).toBe("degraded");
    expect(status["readyForCapture"]).toBe(false);
    const issues = status["issues"] as { code: string; message: string }[];
    expect(issues.some((issue) => issue.code === "ACCOUNT_MISMATCH")).toBe(true);
    expect(issues[0]?.message).toContain("目标账号");
  });

  it("surfaces summary gaps as a warning issue (AC-19)", async () => {
    rig = await startContractRig();
    rig.producer.script.push(
      { kind: "error", error: new Error("down") },
      { kind: "error", error: new Error("down") },
    );
    ingestGroupMessages(3);
    await waitFor(() => {
      const failed = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='failed'")
        .get() as { c: number };
      return failed.c === 1;
    });
    const status = await rig.callTool("qq_monitor_status");
    const issues = status["issues"] as { code: string }[];
    expect(issues.some((issue) => issue.code === "SUMMARY_GAP_CREATED")).toBe(true);
    expect(status["healthState"]).toBe("degraded");
  });
});

describe("qq_feed_pull", () => {
  it("returns changed conversations, advances feed progress, and never touches read progress (AC-14)", async () => {
    rig = await startContractRig();
    ingestGroupMessages(2);
    rig.ingest.handleEvent(friendMessage(), 3_000_000);

    const first = await rig.callTool("qq_feed_pull");
    expect(first["hasUpdates"]).toBe(true);
    const conversations = first["conversations"] as Record<string, unknown>[];
    expect(conversations).toHaveLength(2);
    expect(conversations[0]).toMatchObject({
      conversationType: "group",
      conversationId: "123456789",
      newMessageCount: 2,
      unreadMessageCount: 2,
    });

    // Feed progress advanced: nothing new on the second pull.
    const second = await rig.callTool("qq_feed_pull");
    expect(second["hasUpdates"]).toBe(false);

    // Read progress untouched: unread still returns everything.
    const read = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "unread",
      view: "messages",
    });
    expect((read["items"] as unknown[]).length).toBe(2);
  });

  it("treats summary completion as a standalone feed update (AC-13)", async () => {
    rig = await startContractRig();
    // Hold the producer at the gate so the summary CANNOT complete before the
    // message events are consumed by the first pull.
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    rig.producer.script.push({ kind: "ok", content: okContent("摘要完成"), gate });
    ingestGroupMessages(3);

    const first = await rig.callTool("qq_feed_pull");
    expect(first["hasUpdates"]).toBe(true);
    expect((first["conversations"] as Record<string, unknown>[])[0]?.["updateKinds"]).toEqual([
      "messages",
    ]);

    release();
    await waitFor(() => {
      const done = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='completed'")
        .get() as { c: number };
      return done.c === 1;
    });

    const second = await rig.callTool("qq_feed_pull");
    expect(second["hasUpdates"]).toBe(true);
    const conversation = (second["conversations"] as Record<string, unknown>[])[0];
    expect(conversation?.["updateKinds"]).toEqual(["summary_completed"]);
    expect(conversation?.["newMessageCount"]).toBe(0);
    const units = conversation?.["summaryUnits"] as { summaryText: string }[];
    expect(units[0]?.summaryText).toBe("摘要完成");
  });

  it("keeps events past the cutoff for the next pull without leaking or duplicating", async () => {
    rig = await startContractRig();
    // Interleave: A(msg), B(msg), C(msg), A(msg) — limit=2 selects A and B,
    // cutoff stops before C's first event, so A's second message must wait.
    ingestGroupMessages(1);
    rig.ingest.handleEvent(friendMessage(), 2_000_000);
    rig.ingest.handleEvent(ownerSentFriendMessage({ target_id: 30003, message_id: 900098 }), 3_000_000);
    ingestGroupMessages(1, 50);

    const first = await rig.callTool("qq_feed_pull", { limit: 2 });
    const firstConversations = first["conversations"] as Record<string, unknown>[];
    expect(firstConversations).toHaveLength(2);
    const groupFirst = firstConversations.find((c) => c["conversationType"] === "group");
    expect(groupFirst?.["newMessageCount"]).toBe(1);
    expect(first["hasMore"]).toBe(true);

    const second = await rig.callTool("qq_feed_pull", { limit: 10 });
    const secondConversations = second["conversations"] as Record<string, unknown>[];
    const types = secondConversations.map((c) => [c["conversationType"], c["newMessageCount"]]);
    expect(types).toContainEqual(["friend", 1]);
    expect(types).toContainEqual(["group", 1]);
    expect(second["hasMore"]).toBe(false);

    const third = await rig.callTool("qq_feed_pull");
    expect(third["hasUpdates"]).toBe(false);
  });

  it("paginates by conversation with hasMore and resumes at the cutoff", async () => {
    rig = await startContractRig();
    ingestGroupMessages(1);
    rig.ingest.handleEvent(friendMessage(), 2_000_000);
    rig.ingest.handleEvent(ownerSentFriendMessage({ target_id: 30003, message_id: 900099 }), 3_000_000);

    const first = await rig.callTool("qq_feed_pull", { limit: 2 });
    expect((first["conversations"] as unknown[]).length).toBe(2);
    expect(first["hasMore"]).toBe(true);

    const second = await rig.callTool("qq_feed_pull", { limit: 2 });
    expect((second["conversations"] as unknown[]).length).toBe(1);
    expect(second["hasMore"]).toBe(false);
  });
});

describe("qq_read_conversation", () => {
  it("reads unread contiguously and advances progress; pinned reads do not advance (AC-14)", async () => {
    rig = await startContractRig();
    ingestGroupMessages(4);

    const firstTwo = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "messages",
      limit: 2,
    });
    const items = firstTwo["items"] as { ref: string; text: string }[];
    expect(items).toHaveLength(2);
    expect(items[0]?.text).toBe("第1条");
    expect(firstTwo["readProgressAdvancedTo"]).toBe(items[1]?.ref);
    expect(firstTwo["hasMore"]).toBe(true);

    // Pinned read of a message BEYOND the progress frontier: a regression that
    // advances progress here is observable (monotonic MAX cannot mask it).
    const recent = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "recent",
      view: "messages",
      limit: 1,
    });
    const lastRef = (recent["items"] as { ref: string }[])[0]?.ref;
    await rig.callTool("qq_read_conversation", { reference: lastRef, contextRadius: 2 });

    const progressRow = rig.t.db.raw
      .prepare("SELECT last_message_id FROM conversation_read_progress")
      .get() as { last_message_id: number };
    const secondRef = items[1]?.ref ?? "";
    expect(`qqm_${progressRow.last_message_id.toString(36)}`).toBe(secondRef);

    const rest = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "messages",
    });
    const restItems = rest["items"] as { text: string }[];
    expect(restItems.map((item) => item.text)).toEqual(["第3条", "第4条"]);
  });

  it("collapses completed units in auto view and expands them in both view", async () => {
    rig = await startContractRig();
    rig.producer.script.push({ kind: "ok", content: okContent("单元摘要文本") });
    ingestGroupMessages(3);
    await waitFor(() => {
      const done = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='completed'")
        .get() as { c: number };
      return done.c === 1;
    });
    ingestGroupMessages(1, 10);

    const auto = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "auto",
    });
    const autoItems = auto["items"] as { kind: string; summaryText?: string; text?: string }[];
    expect(autoItems.map((item) => item.kind)).toEqual(["summary", "message"]);
    expect(autoItems[0]?.summaryText).toBe("单元摘要文本");
    expect(autoItems[1]?.text).toBe("第10条");

    const both = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "recent",
      view: "both",
      limit: 10,
    });
    const bothKinds = (both["items"] as { kind: string }[]).map((item) => item.kind);
    expect(bothKinds).toEqual(["summary", "message", "message", "message", "message"]);
  });

  it("resolves qqsu_/qqsf_/qqm_ references with sections and merged evidence windows", async () => {
    rig = await startContractRig();
    rig.producer.script.push({
      kind: "ok",
      content: (prompt) => {
        const ids = [...prompt.user.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
        return JSON.stringify({
          summaryText: "带维度摘要",
          findings: [{ dimension: "keyPoints", text: "关键事实文本", messageIds: [ids[1]] }],
        });
      },
    });
    ingestGroupMessages(3);
    await waitFor(() => {
      const done = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='completed'")
        .get() as { c: number };
      return done.c === 1;
    });

    const feed = await rig.callTool("qq_feed_pull");
    const conversation = (feed["conversations"] as Record<string, unknown>[])[0];
    const unitRef = (conversation?.["summaryUnits"] as { ref: string }[])[0]?.ref ?? "";

    const unit = await rig.callTool("qq_read_conversation", { reference: unitRef });
    expect(unit["summaryText"]).toBe("带维度摘要");
    const sections = unit["sections"] as Record<string, { ref: string; text: string; evidenceCount: number }[]>;
    expect(Object.keys(sections).sort()).toEqual(["conflicts", "keyPoints"]);
    expect(sections["conflicts"]).toEqual([]);
    expect(sections["keyPoints"]?.[0]?.text).toBe("关键事实文本");
    expect(sections["keyPoints"]?.[0]?.evidenceCount).toBe(1);

    const findingRef = sections["keyPoints"]?.[0]?.ref ?? "";
    const finding = await rig.callTool("qq_read_conversation", {
      reference: findingRef,
      contextRadius: 2,
    });
    expect(finding["evidenceAvailable"]).toBe(true);
    const windows = finding["evidence"] as { isEvidence?: boolean; text: string }[][];
    expect(windows).toHaveLength(1);
    expect(windows[0]?.filter((message) => message.isEvidence === true)).toHaveLength(1);

    const evidenceRef = windows[0]?.find((message) => message.isEvidence === true);
    const context = await rig.callTool("qq_read_conversation", {
      reference: (evidenceRef as { ref?: string } | undefined)?.ref ?? "",
      contextRadius: 1,
    });
    expect(context["kind"]).toBe("message_context");
    expect((context["context"] as unknown[]).length).toBeGreaterThan(1);

    // None of the pinned reference reads advanced read progress (AC-14).
    const progressRows = rig.t.db.raw.prepare("SELECT * FROM conversation_read_progress").all();
    expect(progressRows).toEqual([]);
  });

  it("returns raw messages for a recoverable failed unit in auto view, gap stub in summaries view", async () => {
    rig = await startContractRig();
    rig.producer.script.push(
      { kind: "error", error: new Error("down") },
      { kind: "error", error: new Error("still down") },
    );
    ingestGroupMessages(3);
    await waitFor(() => {
      const failed = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='failed'")
        .get() as { c: number };
      return failed.c === 1;
    });

    const auto = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "auto",
    });
    const autoItems = auto["items"] as { kind: string; text?: string }[];
    expect(autoItems.map((item) => item.kind)).toEqual(["message", "message", "message"]);
    expect(autoItems[0]?.text).toBe("第1条");

    const summaries = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "recent",
      view: "summaries",
    });
    const summaryItems = summaries["items"] as { kind: string }[];
    expect(summaryItems.map((item) => item.kind)).toEqual(["summary_gap"]);
  });

  it("rejects out-of-range and out-of-enum inputs at the schema layer", async () => {
    rig = await startContractRig();
    const tools = await rig.client.listTools();
    const feedSchema = tools.tools.find((tool) => tool.name === "qq_feed_pull")?.inputSchema as {
      properties?: Record<string, { minimum?: number; maximum?: number }>;
    };
    expect(feedSchema.properties?.["limit"]?.minimum).toBe(1);
    expect(feedSchema.properties?.["limit"]?.maximum).toBe(100);
    const readSchema = tools.tools.find((tool) => tool.name === "qq_read_conversation")
      ?.inputSchema as { properties?: Record<string, { enum?: string[]; minimum?: number; maximum?: number }> };
    expect(readSchema.properties?.["scope"]?.enum).toEqual(["unread", "recent", "after_cursor"]);
    expect(readSchema.properties?.["view"]?.enum).toEqual(["auto", "summaries", "messages", "both"]);
    expect(readSchema.properties?.["limit"]?.maximum).toBe(200);
    expect(readSchema.properties?.["contextRadius"]?.maximum).toBe(10);

    for (const badArgs of [
      { name: "qq_feed_pull", arguments: { limit: 0 } },
      { name: "qq_feed_pull", arguments: { limit: 101 } },
      { name: "qq_read_conversation", arguments: { conversationType: "group", conversationId: "1", limit: 201 } },
      { name: "qq_read_conversation", arguments: { conversationType: "group", conversationId: "1", scope: "everything" } },
      { name: "qq_read_conversation", arguments: { conversationType: "group", conversationId: "1", contextRadius: 11 } },
    ]) {
      const result = await rig.client.callTool(badArgs as Parameters<typeof rig.client.callTool>[0]);
      expect(result.isError).toBe(true);
    }
  });

  it("reports expired evidence as success with evidenceAvailable=false (AC-16)", async () => {
    rig = await startContractRig();
    rig.producer.script.push({
      kind: "ok",
      content: (prompt) => {
        const ids = [...prompt.user.matchAll(/^\[(\d+)\]/gm)].map((match) => Number(match[1]));
        return JSON.stringify({
          summaryText: "证据将过期",
          findings: [{ dimension: "keyPoints", text: "事实", messageIds: ids }],
        });
      },
    });
    ingestGroupMessages(3);
    await waitFor(() => {
      const done = rig.t.db.raw
        .prepare("SELECT COUNT(*) AS c FROM summary_units WHERE status='completed'")
        .get() as { c: number };
      return done.c === 1;
    });
    rig.t.db.raw
      .prepare("UPDATE messages SET segments_json = NULL, projection = NULL, content_expired_at = 1")
      .run();
    rig.t.db.raw.prepare("UPDATE summary_units SET source_available = 0").run();

    const findingId = (rig.t.db.raw.prepare("SELECT id FROM summary_findings").get() as { id: number }).id;
    const finding = await rig.callTool("qq_read_conversation", {
      reference: `qqsf_${findingId.toString(36)}`,
    });
    expect(finding["evidenceAvailable"]).toBe(false);
    expect(finding["reason"]).toBe("source_messages_expired");
    expect(finding["text"]).toBe("事实");
  });

  it("mark_read advances local progress without returning content (AC-15)", async () => {
    rig = await startContractRig();
    ingestGroupMessages(3);

    const marked = await rig.callTool("qq_read_conversation", {
      operation: "mark_read",
      conversationType: "group",
      conversationId: "123456789",
    });
    expect(marked["markedMessageCount"]).toBe(3);
    expect(marked["readProgressBefore"]).toBeNull();
    expect(typeof marked["readProgressAfter"]).toBe("string");
    expect(marked["items"]).toBeUndefined();

    // Idempotent.
    const again = await rig.callTool("qq_read_conversation", {
      operation: "mark_read",
      conversationType: "group",
      conversationId: "123456789",
    });
    expect(again["markedMessageCount"]).toBe(0);

    const unread = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "messages",
    });
    expect(unread["items"]).toEqual([]);
  });

  it("returns recalled placeholders and honors after_cursor without advancing progress", async () => {
    rig = await startContractRig();
    ingestGroupMessages(3);
    rig.ingest.handleEvent(groupRecall({ message_id: 900001 + 1 }), 5_000_000);

    const read = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "recent",
      view: "messages",
    });
    const items = read["items"] as { ref: string; text: string; recalled: boolean }[];
    const recalled = items.find((item) => item.recalled);
    expect(recalled?.text).toBe("[消息已撤回]");

    const afterFirst = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "after_cursor",
      cursor: items[0]?.ref,
      view: "messages",
    });
    expect((afterFirst["items"] as unknown[]).length).toBe(2);

    // after_cursor never advanced progress: unread still starts at message 1.
    const unread = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      view: "messages",
    });
    expect((unread["items"] as unknown[]).length).toBe(3);
  });

  it("returns documented error envelopes", async () => {
    rig = await startContractRig();
    const missing = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "424242",
    });
    expect(missing["isError"]).toBe(true);
    expect((missing["error"] as { code: string }).code).toBe("CONVERSATION_NOT_FOUND");

    const badRef = await rig.callTool("qq_read_conversation", { reference: "qqsf_zz99xx" });
    expect((badRef["error"] as { code: string }).code).toBe("REFERENCE_NOT_FOUND");

    const badArgs = await rig.callTool("qq_read_conversation", {});
    expect((badArgs["error"] as { code: string }).code).toBe("INVALID_ARGUMENT");

    const badCursor = await rig.callTool("qq_read_conversation", {
      conversationType: "group",
      conversationId: "123456789",
      scope: "after_cursor",
    });
    expect((badCursor["error"] as { code: string }).code).toBe("INVALID_ARGUMENT");
  });
});
