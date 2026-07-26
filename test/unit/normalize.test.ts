import { describe, expect, it } from "vitest";
import { asMessageEvent } from "../../src/bridge/onebot-events.ts";
import { normalizeMessage } from "../../src/normalize/normalize-message.ts";
import { projectSegments } from "../../src/normalize/project-message.ts";
import {
  FRIEND,
  friendMessage,
  groupMessage,
  heartbeat,
  ownerSentFriendMessage,
  richGroupMessage,
  stringFormatMessage,
} from "../fixtures/onebot-events.ts";

function normalize(fixture: Record<string, unknown>, target = "10001") {
  const event = asMessageEvent(fixture);
  expect(event).toBeDefined();
  if (event === undefined) throw new Error("unreachable");
  return normalizeMessage(event, target);
}

describe("asMessageEvent", () => {
  it("accepts message and message_sent, rejects meta events and malformed shapes", () => {
    expect(asMessageEvent(groupMessage())).toBeDefined();
    expect(asMessageEvent(ownerSentFriendMessage())).toBeDefined();
    expect(asMessageEvent(heartbeat())).toBeUndefined();
    expect(asMessageEvent({ post_type: "message" })).toBeUndefined();
    expect(asMessageEvent(groupMessage({ group_id: undefined }))).toBeUndefined();
    expect(asMessageEvent(null)).toBeUndefined();
  });
});

describe("normalizeMessage", () => {
  it("normalizes a group message with card-name precedence", () => {
    const result = normalize(groupMessage());
    expect(result?.conversation).toMatchObject({
      selfUin: "10001",
      type: "group",
      sourceId: "123456789",
    });
    expect(result?.message).toMatchObject({
      sourceMessageId: "900001",
      sourceTimestamp: 1_784_566_100_000,
      senderUin: String(FRIEND),
      senderName: "雨雨",
      isOwner: false,
      direction: "in",
      projection: "大家周六测试",
    });
  });

  it("falls back from card to nickname to uin for the sender name", () => {
    const noCard = normalize(groupMessage({ sender: { user_id: FRIEND, nickname: "小雨" } }));
    expect(noCard?.message.senderName).toBe("小雨");
    const noNames = normalize(groupMessage({ sender: { user_id: FRIEND } }));
    expect(noNames?.message.senderName).toBe(String(FRIEND));
    const blankCard = normalize(
      groupMessage({ sender: { user_id: FRIEND, nickname: "小雨", card: "  " } }),
    );
    expect(blankCard?.message.senderName).toBe("小雨");
  });

  it("uses the peer uin as the friend conversation id in both directions (AC-06)", () => {
    const incoming = normalize(friendMessage());
    expect(incoming?.conversation).toMatchObject({ type: "friend", sourceId: String(FRIEND) });
    expect(incoming?.message.isOwner).toBe(false);

    const outgoing = normalize(ownerSentFriendMessage());
    expect(outgoing?.conversation).toMatchObject({ type: "friend", sourceId: String(FRIEND) });
    expect(outgoing?.message).toMatchObject({ isOwner: true, direction: "out" });
  });

  it("drops owner private messages without a target and mismatched accounts", () => {
    expect(normalize(ownerSentFriendMessage({ target_id: undefined }))).toBeUndefined();
    expect(normalize(groupMessage(), "99999")).toBeUndefined();
  });

  it("wraps string-format messages as a single text segment", () => {
    const result = normalize(stringFormatMessage());
    expect(result?.message.projection).toBe("字符串格式 [CQ:face,id=178]");
    expect(JSON.parse(result?.message.segmentsJson ?? "[]")).toHaveLength(1);
  });
});

describe("projectSegments", () => {
  it("textifies text/at/reply/face and uses placeholders for media", () => {
    const event = asMessageEvent(richGroupMessage());
    const segments = event?.message;
    expect(Array.isArray(segments)).toBe(true);
    if (!Array.isArray(segments)) throw new Error("unreachable");
    expect(projectSegments(segments)).toBe(`[回复]@${String(FRIEND)} 看这张图 [图片][表情]`);
  });

  it("renders @all and unknown segment types descriptively", () => {
    expect(
      projectSegments([
        { type: "at", data: { qq: "all" } },
        { type: "mystery", data: {} },
      ]),
    ).toBe("@全体成员[mystery]");
  });

  it("textualizes faces when the bridge provides a name and skips null segments", () => {
    expect(projectSegments([{ type: "face", data: { id: "178", faceText: "斜眼笑" } }])).toBe(
      "[斜眼笑]",
    );
    expect(projectSegments([{ type: "face", data: { id: "178", raw: { faceText: "[大笑]" } } }])).toBe(
      "[大笑]",
    );
    expect(projectSegments([null, { type: "text", data: null }, { type: "face", data: { id: "1" } }])).toBe(
      "[表情]",
    );
  });
});
