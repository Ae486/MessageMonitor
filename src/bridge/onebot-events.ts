/**
 * Minimal OneBot 11 event model: only the fields this service reads. Events
 * arrive from the local bridge, so narrowing is tolerant — anything that does
 * not match a known shape is ignored upstream rather than crashing capture.
 */
export interface OneBotSegment {
  type: string;
  data: Record<string, unknown>;
}

export interface OneBotSender {
  user_id?: number | string;
  nickname?: string;
  card?: string;
}

export interface OneBotMessageEvent {
  post_type: "message" | "message_sent";
  message_type: "group" | "private";
  sub_type?: string;
  self_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  target_id?: number | string;
  message_id: number | string;
  message: OneBotSegment[] | string;
  raw_message?: string;
  sender?: OneBotSender;
  time: number;
}

export interface OneBotRecallEvent {
  post_type: "notice";
  notice_type: "friend_recall" | "group_recall";
  self_id: number | string;
  user_id: number | string;
  group_id?: number | string;
  operator_id?: number | string;
  message_id: number | string;
  time: number;
}

export type OneBotEvent = OneBotMessageEvent | OneBotRecallEvent;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function isId(value: unknown): value is number | string {
  return typeof value === "number" || typeof value === "string";
}

export function readSelfId(event: unknown): string | undefined {
  if (!isRecord(event) || !isId(event["self_id"])) return undefined;
  return String(event["self_id"]);
}

export function asMessageEvent(event: unknown): OneBotMessageEvent | undefined {
  if (!isRecord(event)) return undefined;
  const postType = event["post_type"];
  if (postType !== "message" && postType !== "message_sent") return undefined;
  const messageType = event["message_type"];
  if (messageType !== "group" && messageType !== "private") return undefined;
  if (!isId(event["self_id"]) || !isId(event["user_id"]) || !isId(event["message_id"])) {
    return undefined;
  }
  if (typeof event["time"] !== "number") return undefined;
  const message = event["message"];
  if (typeof message !== "string" && !Array.isArray(message)) return undefined;
  if (messageType === "group" && !isId(event["group_id"])) return undefined;
  return event as unknown as OneBotMessageEvent;
}

export function asRecallEvent(event: unknown): OneBotRecallEvent | undefined {
  if (!isRecord(event) || event["post_type"] !== "notice") return undefined;
  const noticeType = event["notice_type"];
  if (noticeType !== "friend_recall" && noticeType !== "group_recall") return undefined;
  if (!isId(event["self_id"]) || !isId(event["user_id"]) || !isId(event["message_id"])) {
    return undefined;
  }
  if (typeof event["time"] !== "number") return undefined;
  if (noticeType === "group_recall" && !isId(event["group_id"])) return undefined;
  return event as unknown as OneBotRecallEvent;
}
