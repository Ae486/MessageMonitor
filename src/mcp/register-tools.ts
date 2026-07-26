/**
 * The three read-only QQ tools per docs/mcp-tools.md. No QQ-writing tool is
 * ever registered here; tool errors use the documented envelope. Configured
 * summary dimensions are appended to the read tool's description at startup.
 */
import { z } from "zod";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { AppConfig } from "../config/schema.ts";
import type { FeedService } from "../feed/feed-service.ts";
import { ToolError, type ConversationReader } from "../query/conversation-reader.ts";
import { decodeRef } from "../storage/refs.ts";
import type { StatusService } from "./status-service.ts";

function ok(payload: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(payload) }] };
}

function toolError(error: unknown) {
  if (error instanceof ToolError) {
    return {
      isError: true,
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({
            isError: true,
            error: {
              code: error.code,
              message: error.message,
              retryable: error.retryable,
              details: error.details,
            },
          }),
        },
      ],
    };
  }
  const message = error instanceof Error ? error.message : String(error);
  const errnoCode = (error as NodeJS.ErrnoException | null)?.code ?? "";
  const isStorageFailure =
    (typeof errnoCode === "string" && errnoCode.startsWith("ERR_SQLITE")) ||
    /SQLITE_|database/i.test(message);
  return {
    isError: true,
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({
          isError: true,
          error: isStorageFailure
            ? { code: "STORAGE_UNAVAILABLE", message: "Local storage is currently unavailable.", retryable: true, details: {} }
            : { code: "INTERNAL_ERROR", message, retryable: false, details: {} },
        }),
      },
    ],
  };
}

export interface ToolDeps {
  status: StatusService;
  feed: FeedService;
  reader: ConversationReader;
  config: AppConfig;
}

export function registerTools(server: McpServer, deps: ToolDeps): void {
  const dimensionNote = Object.entries(deps.config.summary.dimensions)
    .map(([key, value]) => `${key}（${value.description}）`)
    .join("、");

  server.registerTool(
    "qq_monitor_status",
    {
      description:
        "Report the QQ monitor's lifecycle, health, capture, storage, summary and agent-progress state. Read-only, no side effects. The issues array carries owner-relayable problem descriptions.",
      inputSchema: {},
    },
    () => {
      try {
        return ok(deps.status.snapshot());
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "qq_feed_pull",
    {
      description:
        "Return the index of monitored conversations that changed since the last pull (new messages, completed/failed summaries, recalls). Advances feed progress; does NOT mark conversations read.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).default(20).describe("Max conversations to return"),
      },
    },
    (args: { limit?: number }) => {
      try {
        return ok(deps.feed.pull(args.limit ?? 20));
      } catch (error) {
        return toolError(error);
      }
    },
  );

  server.registerTool(
    "qq_read_conversation",
    {
      description:
        "Read one conversation (scope unread/recent/after_cursor; view auto/summaries/messages/both), resolve qqc_/qqsu_/qqsf_/qqm_ references with context, or mark_read a conversation. Only scope=unread advances read progress." +
        (dimensionNote === "" ? "" : ` Summary dimensions in effect: ${dimensionNote}.`),
      inputSchema: {
        operation: z.enum(["read", "mark_read"]).default("read"),
        conversationType: z.enum(["group", "friend"]).optional(),
        conversationId: z.string().optional(),
        reference: z
          .string()
          .optional()
          .describe("qqc_/qqsu_/qqsf_/qqm_ reference; alternative to type+id"),
        scope: z.enum(["unread", "recent", "after_cursor"]).default("unread"),
        cursor: z.string().optional(),
        view: z.enum(["auto", "summaries", "messages", "both"]).default("auto"),
        limit: z.number().int().min(1).max(200).default(50),
        contextRadius: z.number().int().min(0).max(10).default(2),
      },
    },
    (args: {
      operation?: "read" | "mark_read";
      conversationType?: "group" | "friend";
      conversationId?: string;
      reference?: string;
      scope?: "unread" | "recent" | "after_cursor";
      cursor?: string;
      view?: "auto" | "summaries" | "messages" | "both";
      limit?: number;
      contextRadius?: number;
    }) => {
      try {
        const operation = args.operation ?? "read";
        const limit = args.limit ?? 50;
        const contextRadius = args.contextRadius ?? 2;

        if (args.reference !== undefined && args.conversationId !== undefined) {
          throw new ToolError("INVALID_ARGUMENT", "Use either reference or conversationType/conversationId, not both.");
        }

        if (operation === "mark_read") {
          const markArgs: Parameters<typeof deps.reader.markRead>[0] = {};
          if (args.conversationType !== undefined) markArgs.conversationType = args.conversationType;
          if (args.conversationId !== undefined) markArgs.conversationId = args.conversationId;
          if (args.reference !== undefined) markArgs.reference = args.reference;
          return ok(deps.reader.markRead(markArgs));
        }

        const decoded = args.reference !== undefined ? decodeRef(args.reference) : undefined;
        if (args.reference !== undefined && decoded === undefined) {
          throw new ToolError("REFERENCE_NOT_FOUND", "The requested local reference does not exist.", false, {
            reference: args.reference,
          });
        }
        if (decoded !== undefined && decoded.kind === "summaryUnit") {
          return ok(deps.reader.readSummaryUnit(decoded.id, args.view ?? "auto", limit));
        }
        if (decoded !== undefined && decoded.kind === "summaryFinding") {
          return ok(deps.reader.readFinding(decoded.id, contextRadius));
        }
        if (decoded !== undefined && decoded.kind === "message") {
          return ok(deps.reader.readMessage(decoded.id, contextRadius));
        }

        const readArgs: Parameters<typeof deps.reader.readConversation>[0] = {
          scope: args.scope ?? "unread",
          view: args.view ?? "auto",
          limit,
        };
        if (args.conversationType !== undefined) readArgs.conversationType = args.conversationType;
        if (args.conversationId !== undefined) readArgs.conversationId = args.conversationId;
        if (args.reference !== undefined) readArgs.reference = args.reference;
        if (args.cursor !== undefined) readArgs.cursor = args.cursor;
        return ok(deps.reader.readConversation(readArgs));
      } catch (error) {
        return toolError(error);
      }
    },
  );
}
