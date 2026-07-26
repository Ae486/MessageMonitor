/**
 * OneBot message event -> conversation identity + storage-ready message.
 * Friend conversation IDs are always the peer's uin, never the owner's
 * (docs/requirements.md 2.2); sender names are point-in-time snapshots with
 * group card > nickname > uin precedence.
 */
import type { OneBotMessageEvent, OneBotSegment } from "../bridge/onebot-events.ts";
import type { ConversationIdentity } from "../storage/repositories/conversations.ts";
import type { IncomingMessage } from "../storage/repositories/messages.ts";
import { projectSegments } from "./project-message.ts";

export interface NormalizedMessage {
  conversation: Omit<ConversationIdentity, "summaryEnabled">;
  message: IncomingMessage;
}

function asSegments(message: OneBotSegment[] | string, rawMessage: string | undefined): OneBotSegment[] {
  if (Array.isArray(message)) {
    return message.filter(
      (segment): segment is OneBotSegment =>
        typeof segment === "object" &&
        segment !== null &&
        typeof segment.type === "string" &&
        typeof segment.data === "object" &&
        segment.data !== null,
    );
  }
  // String format fallback: stored verbatim as one text segment; production
  // bridge config should use array format (implementation-plan 5.3).
  const text = rawMessage ?? message;
  return [{ type: "text", data: { text } }];
}

function senderName(event: OneBotMessageEvent, isGroup: boolean): string {
  const card = event.sender?.card;
  if (isGroup && typeof card === "string" && card.trim() !== "") return card;
  const nickname = event.sender?.nickname;
  if (typeof nickname === "string" && nickname.trim() !== "") return nickname;
  return String(event.user_id);
}

export function normalizeMessage(
  event: OneBotMessageEvent,
  targetSelfUin: string,
): NormalizedMessage | undefined {
  const selfUin = String(event.self_id);
  if (selfUin !== targetSelfUin) return undefined;

  const isOwner = String(event.user_id) === targetSelfUin;
  const isGroup = event.message_type === "group";

  // Group temp sessions (private + sub_type "group"/"other") are not friend
  // conversations; capturing them would pollute friend identity semantics.
  if (!isGroup && event.sub_type !== undefined && event.sub_type !== "friend") {
    return undefined;
  }

  let conversationSourceId: string;
  let displayName: string | undefined;
  if (isGroup) {
    conversationSourceId = String(event.group_id);
  } else if (isOwner) {
    if (event.target_id === undefined) return undefined;
    conversationSourceId = String(event.target_id);
  } else {
    conversationSourceId = String(event.user_id);
    const nickname = event.sender?.nickname;
    if (typeof nickname === "string" && nickname.trim() !== "") displayName = nickname;
  }

  const segments = asSegments(event.message, event.raw_message);

  return {
    conversation: {
      selfUin,
      type: isGroup ? "group" : "friend",
      sourceId: conversationSourceId,
      ...(displayName !== undefined ? { displayName } : {}),
    },
    message: {
      sourceMessageId: String(event.message_id),
      sourceTimestamp: event.time * 1000,
      senderUin: String(event.user_id),
      senderName: senderName(event, isGroup),
      isOwner,
      direction: isOwner ? "out" : "in",
      segmentsJson: JSON.stringify(segments),
      projection: projectSegments(segments),
    },
  };
}
