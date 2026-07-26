/** Recorded-shape OneBot 11 fixtures per implementation-plan 5.3. */

export const SELF = 10001;
export const GROUP = 123456789;
export const FRIEND = 20002;

export function groupMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: "message",
    message_type: "group",
    sub_type: "normal",
    self_id: SELF,
    user_id: FRIEND,
    group_id: GROUP,
    message_id: 900001,
    message: [{ type: "text", data: { text: "大家周六测试" } }],
    raw_message: "大家周六测试",
    sender: { user_id: FRIEND, nickname: "小雨", card: "雨雨" },
    time: 1_784_566_100,
    ...overrides,
  };
}

export function friendMessage(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: "message",
    message_type: "private",
    sub_type: "friend",
    self_id: SELF,
    user_id: FRIEND,
    message_id: 900002,
    message: [{ type: "text", data: { text: "周六下午有时间吗？" } }],
    raw_message: "周六下午有时间吗？",
    sender: { user_id: FRIEND, nickname: "小雨" },
    time: 1_784_566_200,
    ...overrides,
  };
}

export function ownerSentFriendMessage(
  overrides: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    post_type: "message_sent",
    message_type: "private",
    sub_type: "friend",
    self_id: SELF,
    user_id: SELF,
    target_id: FRIEND,
    message_id: 900003,
    message: [{ type: "text", data: { text: "有的，三点见" } }],
    raw_message: "有的，三点见",
    sender: { user_id: SELF, nickname: "主人" },
    time: 1_784_566_300,
    ...overrides,
  };
}

export function richGroupMessage(): Record<string, unknown> {
  return groupMessage({
    message_id: 900004,
    message: [
      { type: "reply", data: { id: "900001" } },
      { type: "at", data: { qq: String(FRIEND) } },
      { type: "text", data: { text: " 看这张图 " } },
      { type: "image", data: { file: "abc.jpg", url: "https://example.invalid/abc.jpg" } },
      { type: "face", data: { id: "178" } },
    ],
  });
}

export function stringFormatMessage(): Record<string, unknown> {
  return friendMessage({
    message_id: 900005,
    message: "字符串格式 [CQ:face,id=178]",
    raw_message: "字符串格式 [CQ:face,id=178]",
  });
}

export function groupRecall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: "notice",
    notice_type: "group_recall",
    self_id: SELF,
    group_id: GROUP,
    user_id: FRIEND,
    operator_id: FRIEND,
    message_id: 900001,
    time: 1_784_566_400,
    ...overrides,
  };
}

export function friendRecall(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    post_type: "notice",
    notice_type: "friend_recall",
    self_id: SELF,
    user_id: FRIEND,
    message_id: 900002,
    time: 1_784_566_500,
    ...overrides,
  };
}

export function lifecycleConnect(selfId: number | string = SELF): Record<string, unknown> {
  return {
    post_type: "meta_event",
    meta_event_type: "lifecycle",
    sub_type: "connect",
    self_id: selfId,
    time: 1_784_566_000,
  };
}

export function heartbeat(selfId: number | string = SELF): Record<string, unknown> {
  return {
    post_type: "meta_event",
    meta_event_type: "heartbeat",
    self_id: selfId,
    status: { online: true, good: true },
    interval: 60000,
    time: 1_784_566_060,
  };
}
