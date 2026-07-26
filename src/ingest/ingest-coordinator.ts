/**
 * Whitelist filtering and persistence dispatch. Events outside the capture
 * scope are dropped before any storage work (docs/requirements.md 2.2), and
 * capture never waits on the summary pipeline (3.2).
 */
import { asMessageEvent, asRecallEvent } from "../bridge/onebot-events.ts";
import type { AppConfig } from "../config/schema.ts";
import type { Logger } from "../logging/logger.ts";
import { normalizeMessage } from "../normalize/normalize-message.ts";
import type { Storage } from "../storage/index.ts";

export interface IngestCoordinator {
  handleEvent(event: unknown, now: number): void;
}

export function createIngestCoordinator(
  config: AppConfig,
  storage: Storage,
  log: Logger,
): IngestCoordinator {
  const ingestLog = log.child({ component: "ingest" });
  const groupWhitelist = new Set(config.capture.groups.whitelist);
  const friendWhitelist = new Set(config.capture.friends.whitelist);
  const summaryGroups = new Set(config.summary.enabled ? config.summary.groupWhitelist : []);
  const targetSelfUin = config.account.targetSelfUin;

  const isCaptured = (type: "group" | "friend", sourceId: string): boolean => {
    if (type === "group") return groupWhitelist.has(sourceId);
    return config.capture.friends.mode === "all" || friendWhitelist.has(sourceId);
  };

  const handleMessage = (event: unknown, now: number): boolean => {
    const messageEvent = asMessageEvent(event);
    if (messageEvent === undefined) return false;

    const normalized = normalizeMessage(messageEvent, targetSelfUin);
    if (normalized === undefined) return true;
    const { conversation, message } = normalized;
    if (!isCaptured(conversation.type, conversation.sourceId)) return true;

    const result = storage.messages.ingest(
      {
        ...conversation,
        summaryEnabled: conversation.type === "group" && summaryGroups.has(conversation.sourceId),
      },
      message,
      now,
    );
    if (result.inserted) {
      ingestLog.debug(
        { conversationId: result.conversationId, messageId: result.messageId },
        "message captured",
      );
    }
    return true;
  };

  const handleRecall = (event: unknown, now: number): boolean => {
    const recall = asRecallEvent(event);
    if (recall === undefined) return false;
    if (String(recall.self_id) !== targetSelfUin) return true;

    const isGroup = recall.notice_type === "group_recall";
    let conversationId: number | undefined;
    if (isGroup) {
      const sourceId = String(recall.group_id);
      if (!isCaptured("group", sourceId)) return true;
      conversationId = storage.conversations.findId(targetSelfUin, "group", sourceId);
    } else if (String(recall.user_id) === targetSelfUin) {
      // LLOneBot sets friend_recall user_id to the message SENDER, so an owner
      // self-recall carries the owner's uin and cannot name the peer; resolve
      // the conversation from the captured message instead.
      const found = storage.messages.findFriendConversation(
        targetSelfUin,
        String(recall.message_id),
      );
      if (found === undefined || !isCaptured("friend", found.sourceId)) return true;
      conversationId = found.conversationId;
    } else {
      const sourceId = String(recall.user_id);
      if (!isCaptured("friend", sourceId)) return true;
      conversationId = storage.conversations.findId(targetSelfUin, "friend", sourceId);
    }
    if (conversationId === undefined) return true;

    const marked = storage.messages.markRecalled(
      {
        conversationId,
        sourceMessageId: String(recall.message_id),
        ...(recall.operator_id !== undefined ? { operatorUin: String(recall.operator_id) } : {}),
        retainContent: config.messages.retainRecalledContent,
      },
      now,
    );
    if (marked) {
      ingestLog.debug({ conversationId }, "message marked recalled");
    }
    return true;
  };

  return {
    handleEvent(event, now) {
      try {
        if (handleMessage(event, now)) return;
        if (handleRecall(event, now)) return;
      } catch (error) {
        const reason = error instanceof Error ? error.message : String(error);
        ingestLog.error({ err: reason }, "event ingest failed");
      }
    },
  };
}
